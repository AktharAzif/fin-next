// The context one command runs in: the environment's settings, the overlay (loaded and masked
// before anything is printed), the guard, credentials by file, the output and the run.

import { join } from "node:path";
import { flagBool, flagInt, type ParsedArgs } from "./args.ts";
import { type CredentialVariable, readCredential } from "./credentials.ts";
import { ConfigError, EXIT, FinError } from "./errors.ts";
import { Guard } from "./guard.ts";
import type { Masker } from "./mask.ts";
import type { Output } from "./output.ts";
import { loadOverlay, type Overlay, registerOverlayFile } from "./overlay.ts";
import { type Change, checkDeletes, formatPlan, pending, summarize } from "./plan.ts";
import { Run, type RunResult } from "./run.ts";
import { RunLog } from "./runlog.ts";
import { type Runtime, stateDir } from "./runtime.ts";
import type { Secret } from "./secret.ts";
import type { Environment, Settings } from "./settings.ts";

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

/** The result a run.done records for an error: a safety rule's refusal, or a failure. */
export function resultOf(error: unknown): RunResult {
  return error instanceof FinError && error.exitCode === EXIT.refused ? "refused" : "failed";
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
  /**
   * Whether the overlay's values are registered with the masker. A command that needs the overlay
   * always has them; any other command has them when FIN_OVERLAY_FILE names a usable file.
   */
  readonly masked: boolean;
  readonly #overlay: Overlay | undefined;
  #guard: Guard | undefined;
  readonly #credentials = new Map<CredentialVariable, Secret>();

  constructor(options: ContextOptions) {
    this.runtime = options.runtime;
    this.environment = options.environment;
    this.settings = options.settings;
    this.masker = options.masker;
    this.out = options.out;
    this.args = options.args;
    // The overlay is read (and every value masked) before anything else happens. A command that
    // does not need it still masks with it when it is there, since what it prints or logs (a
    // reason, an error) may name a private value.
    if (options.needsOverlay) {
      this.#overlay = loadOverlay(options.runtime.env, options.environment, options.masker);
      this.masked = true;
      const policy = this.#overlay.dmarc.policy;
      if (policy !== undefined && policy !== options.settings.email.dmarcPolicy) {
        throw new ConfigError(
          `the overlay's dmarc.policy differs from email.dmarcPolicy in ops/environments/${options.environment}.json, which holds the policy ([BD-17])`,
        );
      }
    } else {
      this.#overlay = undefined;
      this.masked = registerOverlayFile(options.runtime.env, options.masker).registered;
    }
    this.log = new RunLog(join(stateDir(options.runtime.env), options.environment), options.masker);
    this.run = new Run(options.runtime, this.log, options.out, {
      command: options.command,
      environment: options.environment,
      dryRun: options.mutating ? flagBool(options.args, "dry-run") : true,
      args: options.args,
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
   * Prints a plan, and unless this is a dry run applies its pending changes in order inside a
   * registered run: run.registered (shipped at once) before the first change, one run.step per
   * change, and run.done with `ok`, `refused` (a safety rule stopped it) or `failed`. Returns the
   * exit code: 0 when everything planned was applied (or, in a dry run, when nothing differs), 1
   * when a dry run shows changes or some changes were held. A run applies one plan.
   */
  async applyPlan(
    title: string,
    changes: readonly Change[],
    apply: (change: Change) => Promise<void>,
    fields: Record<string, unknown> = {},
  ): Promise<number> {
    for (const line of formatPlan(title, changes)) this.out.info(line);
    const todo = pending(changes);
    const summary = summarize(changes);
    if (this.dryRun) {
      this.out.info(todo.length === 0 ? "dry run: nothing to change" : "dry run: nothing was sent");
      return todo.length === 0 && summary.held === 0 ? 0 : 1;
    }
    if (todo.length === 0) {
      this.out.info("nothing to change");
      return summary.held === 0 ? 0 : 1;
    }
    checkDeletes(changes, flagInt(this.args, "confirm-delete"));
    this.run.register({ plan: summary, ...fields });
    await this.run.flushLines();
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
    } catch (error) {
      this.run.finish(resultOf(error), {
        plan: summary,
        error: error instanceof Error ? error.message : "failed",
      });
      throw error;
    }
    this.run.finish("ok", { plan: summary, ...fields });
    return summary.held === 0 ? 0 : 1;
  }
}
