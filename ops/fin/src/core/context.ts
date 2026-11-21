// The context one command runs in: the environment's settings, the overlay (loaded and masked
// before anything is printed), the guard, credentials by file, the output and the run.
//
// A mutating run (without --dry-run) holds the run lock from before the command reads any provider
// state until its run is done, so the plan it prints and applies cannot go stale under another run
// (spec 01 §10). The planning lock is handed to the run when it registers (Run.register takes the
// lock itself): released and retaken in one synchronous step, so a run that takes it in between
// makes register() fail busy, and nothing is sent.

import { join } from "node:path";
import { flagBool, flagInt, type ParsedArgs } from "./args.ts";
import { type CredentialVariable, readCredential } from "./credentials.ts";
import { EXIT, FinError } from "./errors.ts";
import { Guard } from "./guard.ts";
import type { Masker } from "./mask.ts";
import type { Output } from "./output.ts";
import { loadOverlay, type Overlay } from "./overlay.ts";
import { type Change, checkDeletes, formatPlan, pending, summarize } from "./plan.ts";
import { Run, type RunResult } from "./run.ts";
import { RunLog } from "./runlog.ts";
import { type Runtime, stateDir } from "./runtime.ts";
import type { Secret } from "./secret.ts";
import type { Environment, Settings } from "./settings.ts";

/** The result a run.done records for an error: a safety rule's refusal, or a failure. */
export function resultOf(error: unknown): RunResult {
  return error instanceof FinError && error.exitCode === EXIT.refused ? "refused" : "failed";
}

export interface PlanHooks {
  /**
   * Checks one pending change without sending anything (the writer's check: the guard, the
   * endpoint, the body). Every pending change is checked before the run registers, so a refusal
   * sends nothing.
   */
  check?: (change: Change) => void;
  /** Read back after a registered run's changes; its fields join `run.done` (never printed). */
  after?: () => Promise<Record<string, unknown>>;
}

export interface ContextOptions {
  runtime: Runtime;
  environment: Environment;
  settings: Settings;
  masker: Masker;
  out: Output;
  args: ParsedArgs;
  command: string;
  mutating: boolean;
  needsOverlay: boolean;
}

export class Context {
  readonly runtime: Runtime;
  readonly environment: Environment;
  readonly settings: Settings;
  readonly masker: Masker;
  readonly out: Output;
  readonly args: ParsedArgs;
  readonly log: RunLog;
  readonly run: Run;
  readonly #overlay: Overlay | undefined;
  #guard: Guard | undefined;
  #planLock = false;
  readonly #credentials = new Map<CredentialVariable, Secret>();

  constructor(options: ContextOptions) {
    this.runtime = options.runtime;
    this.environment = options.environment;
    this.settings = options.settings;
    this.masker = options.masker;
    this.out = options.out;
    this.args = options.args;
    // The overlay is read (and every value masked) before anything else happens.
    this.#overlay = options.needsOverlay
      ? loadOverlay(options.runtime.env, options.environment, options.masker)
      : undefined;
    this.log = new RunLog(join(stateDir(options.runtime.env), options.environment), options.masker);
    this.run = new Run(options.runtime, this.log, options.out, {
      command: options.command,
      environment: options.environment,
      dryRun: options.mutating ? flagBool(options.args, "dry-run") : true,
    });
  }

  get dryRun(): boolean {
    return this.run.dryRun;
  }

  get overlay(): Overlay {
    if (this.#overlay === undefined) throw new Error("this command does not read the overlay");
    return this.#overlay;
  }

  get guard(): Guard {
    this.#guard ??= new Guard(this.overlay, {
      spike: flagBool(this.args, "spike"),
      fallback: flagBool(this.args, "fallback"),
    });
    return this.#guard;
  }

  /** A credential by its file variable, read once per run. */
  credential(variable: CredentialVariable): Secret {
    let secret = this.#credentials.get(variable);
    if (secret === undefined) {
      secret = readCredential(this.runtime.env, variable, this.masker);
      this.#credentials.set(variable, secret);
    }
    return secret;
  }

  /**
   * Takes the run lock before a mutating run (not a dry run) reads any provider state, so its plan
   * cannot go stale under another run. A BusyError (exit 75) names the run that holds it.
   */
  lockForPlanning(): void {
    if (this.dryRun || this.#planLock) return;
    this.log.lock({
      runId: this.run.id,
      command: this.run.command,
      startedAt: this.runtime.now().toISOString(),
    });
    this.#planLock = true;
  }

  /** Releases the planning lock of a run that never registered (nothing to change, or an error). */
  releasePlanLock(): void {
    if (!this.#planLock) return;
    this.#planLock = false;
    try {
      this.log.unlock(this.run.id);
    } catch {
      this.out.warn("the run lock could not be released: check it with pnpm fin lock status");
    }
  }

  /**
   * Prints a plan, and unless this is a dry run applies its pending changes in order inside a
   * registered run. Every pending change is checked first (hooks.check), so a refusal sends
   * nothing. Returns the exit code: 0 when everything planned was applied (or, in a dry run, when
   * nothing differs), 1 when a dry run shows changes or some changes were held. run.done records
   * `ok`, `refused` (a safety rule stopped it) or `failed`.
   */
  async applyPlan(
    title: string,
    changes: readonly Change[],
    apply: (change: Change) => Promise<void>,
    fields: Record<string, unknown> = {},
    hooks: PlanHooks = {},
  ): Promise<number> {
    for (const line of formatPlan(title, changes)) this.out.info(line);
    const todo = pending(changes);
    const summary = summarize(changes);
    if (this.dryRun) {
      for (const change of todo) hooks.check?.(change);
      this.out.info(todo.length === 0 ? "dry run: nothing to change" : "dry run: nothing was sent");
      return todo.length === 0 && summary.held === 0 ? 0 : 1;
    }
    if (todo.length === 0) {
      this.out.info("nothing to change");
      return summary.held === 0 ? 0 : 1;
    }
    checkDeletes(changes, flagInt(this.args, "confirm-delete"));
    for (const change of todo) hooks.check?.(change);
    // The planning lock passes to the run: Run.register takes the lock itself.
    this.releasePlanLock();
    this.run.register({ plan: summary, ...fields });
    try {
      for (const change of todo) {
        await apply(change);
        this.run.step(
          change.kind,
          change.name,
          change.action,
          change.fields ? { fields: change.fields } : {},
        );
        this.out.info(`  done: ${change.action} ${change.kind} ${change.name}`);
      }
      const readBack = hooks.after === undefined ? {} : await hooks.after();
      this.run.finish("ok", { plan: summary, ...fields, ...readBack });
    } catch (error) {
      this.run.finish(resultOf(error), {
        plan: summary,
        error: error instanceof Error ? error.message : "failed",
      });
      throw error;
    }
    return summary.held === 0 ? 0 : 1;
  }
}
