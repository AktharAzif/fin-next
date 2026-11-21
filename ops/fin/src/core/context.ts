// The context one command runs in: the environment's settings, the overlay (loaded and masked
// before anything is printed), the guard, credentials by file, the output and the run.

import { join } from "node:path";
import { flagBool, flagInt, type ParsedArgs } from "./args.ts";
import { type CredentialVariable, readCredential } from "./credentials.ts";
import { Guard } from "./guard.ts";
import type { Masker } from "./mask.ts";
import type { Output } from "./output.ts";
import { loadOverlay, type Overlay } from "./overlay.ts";
import { type Change, checkDeletes, formatPlan, pending, summarize } from "./plan.ts";
import { Run } from "./run.ts";
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
   * Prints a plan, and unless this is a dry run applies its pending changes in order inside a
   * registered run. Returns the exit code: 0 when everything planned was applied (or, in a dry
   * run, when nothing differs), 1 when a dry run shows changes or some changes were held.
   */
  async applyPlan(
    title: string,
    changes: readonly Change[],
    apply: (change: Change) => Promise<void>,
    fields: Record<string, unknown> = {},
    /** Read back after the changes (or when nothing changed); its fields join `run.done`. */
    after?: () => Promise<Record<string, unknown>>,
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
      if (after !== undefined) await after();
      return summary.held === 0 ? 0 : 1;
    }
    checkDeletes(changes, flagInt(this.args, "confirm-delete"));
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
      const readBack = after === undefined ? {} : await after();
      this.run.finish("ok", { plan: summary, ...fields, ...readBack });
    } catch (error) {
      this.run.finish("failed", {
        plan: summary,
        error: error instanceof Error ? error.message : "failed",
      });
      throw error;
    }
    return summary.held === 0 ? 0 : 1;
  }
}
