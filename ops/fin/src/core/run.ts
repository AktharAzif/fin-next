// A registered run (spec 01 §10, ARCHITECTURE §6.10, §11.8). A mutating command (without
// --dry-run) takes the run lock before it reads any provider state, so the plan it prints cannot go
// stale under another run; it writes `run.registered` (who, what, with which arguments, from which
// commit, and whether the checkout had local changes) before its first change, one `run.step` per
// change it sends, and `run.done` with the result at the end, whatever happened: a failure, a
// refusal or an interrupt. A dry run takes no lock and writes no record, and nothing can be sent in
// one: the provider writers ask assertWritable() first, which also checks that this run still holds
// the lock. A run registers once: it applies one plan.
//
// Each record also becomes a telemetry line in spec 08 §7.2's envelope (service `ops`), written
// beside the run log as it happens, printed in GitHub Actions (the job log is the record there),
// and shipped to the Better Stack source `fin-next-<env>-ops` when FIN_OPS_INGEST_HOST and
// FIN_OPS_INGEST_TOKEN_FILE are set: `run.registered` before the first change, the rest at the
// end. The run.registered, run.done and lock.broken lines carry the run log's head (`logSeq`,
// `logHead`), so the head also exists off this machine. Telemetry never changes a command's result:
// every failure to write or ship a line is a warning.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ParsedArgs } from "./args.ts";
import { hasCredential, readCredential } from "./credentials.ts";
import { BusyError, EXIT, FinError } from "./errors.ts";
import { send } from "./http.ts";
import type { Masker } from "./mask.ts";
import type { Output } from "./output.ts";
import type { Appended, RunLog } from "./runlog.ts";
import { newRunId, type Runtime } from "./runtime.ts";
import type { Secret } from "./secret.ts";

export type RunResult = "ok" | "failed" | "refused";

export interface RunOptions {
  command: string;
  environment: string;
  dryRun: boolean;
  /** The arguments the command was given: recorded (masked) with the registration. */
  args?: ParsedArgs;
}

export interface Line {
  dt: string;
  message: string;
  event: string;
  level: "info" | "warn" | "error";
  service: "ops";
  environment: string;
  release: string;
  replica: string;
  runId: string;
  [field: string]: unknown;
}

const INGEST_HOST = /^[a-z0-9.-]+$/;

export class Run {
  readonly id: string;
  readonly command: string;
  readonly environment: string;
  readonly dryRun: boolean;
  readonly #runtime: Runtime;
  readonly #log: RunLog;
  readonly #out: Output;
  readonly #masker: Masker;
  readonly #args: ParsedArgs | undefined;
  readonly #lines: Line[] = [];
  #unshipped: Line[] = [];
  #linesFileWarned = false;
  #locked = false;
  #registered = false;
  #finished = false;
  #steps = 0;

  constructor(runtime: Runtime, log: RunLog, out: Output, options: RunOptions) {
    this.#runtime = runtime;
    this.#log = log;
    this.#out = out;
    this.#masker = out.masker;
    this.id = newRunId(runtime);
    this.command = options.command;
    this.environment = options.environment;
    this.dryRun = options.dryRun;
    this.#args = options.args;
  }

  get registered(): boolean {
    return this.#registered;
  }

  get finished(): boolean {
    return this.#finished;
  }

  /** Whether this run took the run lock and has not released it. */
  get locked(): boolean {
    return this.#locked;
  }

  get lines(): readonly Line[] {
    return this.#lines;
  }

  /**
   * Takes the run lock (a BusyError, exit 75, when another run holds it). The CLI calls it before
   * a mutating command reads anything. A dry run takes none.
   */
  acquire(): void {
    if (this.dryRun || this.#locked || this.#finished) return;
    this.#log.lock({
      runId: this.id,
      command: this.command,
      startedAt: this.#runtime.now().toISOString(),
    });
    this.#locked = true;
  }

  /** Writes `run.registered`, taking the lock if the run has not. A dry run writes nothing. */
  register(fields: Record<string, unknown> = {}): void {
    if (this.dryRun) return;
    if (this.#finished) {
      throw new FinError(
        "this run has finished: a run registers once and applies one plan, so nothing more is sent",
        EXIT.internal,
      );
    }
    if (this.#registered) return;
    const lockedHere = !this.#locked;
    if (lockedHere) this.acquire();
    else this.#assertHolder("registering the run");
    const dirty = this.#runtime.dirty();
    let appended: Appended;
    try {
      appended = this.#log.append(this.#runtime.now(), this.id, "run.registered", {
        command: this.command,
        environment: this.environment,
        operator: this.#runtime.operator(),
        commit: this.#runtime.commit() ?? null,
        dirty: dirty ?? null,
        ...(this.#args === undefined
          ? {}
          : {
              args: {
                positionals: this.#args.positionals,
                flags: Object.fromEntries(this.#args.flags),
              },
            }),
        ...fields,
      });
    } catch (error) {
      if (lockedHere) this.#release();
      throw error;
    }
    this.#registered = true;
    if (dirty === true) {
      this.#out.warn(
        "this run comes from a checkout with local changes: the run log records it as dirty, " +
          "because the commit alone does not say what ran",
      );
    }
    this.line("run.registered", "info", {
      command: this.command,
      dirty: dirty ?? null,
      flags: this.#flagSummary(),
      logSeq: appended.record.seq,
      logHead: appended.hash,
    });
  }

  /**
   * The flags a line may carry: booleans and numbers as given (the safety overrides --spike,
   * --fallback and --confirm-delete among them), a string flag only as given (its value can be a
   * path, so it stays in the run log).
   */
  #flagSummary(): Record<string, boolean | number> {
    const flags: Record<string, boolean | number> = {};
    for (const [name, value] of this.#args?.flags ?? []) {
      flags[name] = typeof value === "string" ? true : value;
    }
    return flags;
  }

  /** Refuses a provider write outside a registered run, in a dry run, and once the lock is lost. */
  assertWritable(what: string): void {
    if (this.dryRun) throw new FinError(`${what}: a dry run sends nothing`, EXIT.internal);
    if (!this.#registered || this.#finished) {
      throw new FinError(`${what}: a write outside a registered run is refused`, EXIT.internal);
    }
    this.#assertHolder(what);
  }

  #assertHolder(what: string): void {
    const holder = this.#log.holder();
    if (holder?.runId === this.id) return;
    throw new BusyError(
      `${what}: this run no longer holds the run lock (${
        holder === undefined ? "it is free" : `${holder.runId} holds it`
      }); nothing more is sent`,
    );
  }

  /** Records one change the run sent (names and roles only; the masker runs first). */
  step(kind: string, name: string, action: string, fields: Record<string, unknown> = {}): void {
    if (!this.#registered || this.#finished) return;
    this.#steps++;
    this.#log.append(this.#runtime.now(), this.id, "run.step", { kind, name, action, ...fields });
  }

  /**
   * Writes a telemetry line (spec 08 §7.2's envelope): masked value by value, kept beside the run
   * log at once, printed in GitHub Actions, and queued for shipping. The envelope's fields cannot
   * be overridden by `fields`.
   */
  line(event: string, level: Line["level"], fields: Record<string, unknown> = {}): void {
    const line: Line = {
      dt: this.#runtime.now().toISOString(),
      message: event,
      event,
      level,
      service: "ops",
      environment: this.environment,
      release: this.#runtime.commit() ?? "unknown",
      replica: this.id,
      runId: this.id,
    };
    const masked = this.#masker.maskValue(fields);
    if (typeof masked === "object" && masked !== null && !Array.isArray(masked)) {
      for (const [key, value] of Object.entries(masked)) {
        if (Object.hasOwn(line, key)) continue;
        Object.defineProperty(line, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    this.#lines.push(line);
    this.#unshipped.push(line);
    this.#keep(line);
    if (this.#runtime.env.GITHUB_ACTIONS === "true") this.#out.info(JSON.stringify(line));
  }

  /** Appends a line to lines.jsonl beside the run log (a warning, once, if it cannot). */
  #keep(line: Line): void {
    try {
      mkdirSync(this.#log.dir, { recursive: true, mode: 0o700 });
      appendFileSync(join(this.#log.dir, "lines.jsonl"), `${JSON.stringify(line)}\n`, {
        mode: 0o600,
      });
    } catch {
      if (!this.#linesFileWarned) {
        this.#linesFileWarned = true;
        this.#out.warn("the telemetry lines could not be written beside the run log");
      }
    }
  }

  /**
   * Writes `run.done` and releases the lock. Safe to call once; later calls do nothing. It never
   * throws: a run log it cannot write, or a lock another run took meanwhile, is a warning, so the
   * error that stopped the run is never hidden.
   */
  finish(result: RunResult, fields: Record<string, unknown> = {}): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#registered) {
      let lockLost = false;
      try {
        lockLost = this.#log.holder()?.runId !== this.id;
      } catch {
        lockLost = true;
      }
      const level = result === "ok" ? "info" : "error";
      try {
        const appended = this.#log.append(this.#runtime.now(), this.id, "run.done", {
          command: this.command,
          result,
          steps: this.#steps,
          ...(lockLost ? { lockLost: true } : {}),
          ...fields,
        });
        this.line("run.done", level, {
          command: this.command,
          result,
          steps: this.#steps,
          logSeq: appended.record.seq,
          logHead: appended.hash,
        });
      } catch {
        this.#out.warn("run.done could not be written to the run log; this output is its record");
        this.line("run.done", level, {
          command: this.command,
          result,
          steps: this.#steps,
          logWriteFailed: true,
        });
      }
    }
    this.#release();
  }

  /**
   * Closes the run when its command ends: releases a lock taken for a run that registered nothing,
   * and closes a registered run that was left open as failed.
   */
  close(): void {
    if (this.#registered && !this.#finished) {
      this.finish("failed", { error: "the command ended without closing its run" });
      return;
    }
    this.#finished = true;
    this.#release();
  }

  #release(): void {
    if (!this.#locked) return;
    this.#locked = false;
    try {
      if (this.#log.release(this.id) === "held-by-another") {
        this.#out.warn("another run holds the run lock now (it was broken); it was left as it is");
      }
    } catch {
      this.#out.warn("the run lock could not be released: check it with pnpm fin lock status");
    }
  }

  /**
   * Ships the lines not shipped yet when an ingest is configured. Never throws: any failure is a
   * warning, and the lines stay in lines.jsonl.
   */
  async flushLines(): Promise<void> {
    const batch = this.#unshipped;
    this.#unshipped = [];
    if (batch.length === 0) return;
    try {
      await this.#ship(batch);
    } catch {
      this.#out.warn("shipping the run's lines failed; they stay local");
    }
  }

  async #ship(batch: readonly Line[]): Promise<void> {
    const env = this.#runtime.env;
    const host = env.FIN_OPS_INGEST_HOST;
    if (host === undefined || host === "" || !hasCredential(env, "FIN_OPS_INGEST_TOKEN_FILE"))
      return;
    this.#masker.register(host, "<ops-ingest-host>");
    if (!INGEST_HOST.test(host)) {
      this.#out.warn("FIN_OPS_INGEST_HOST is not a hostname; the lines stay local");
      return;
    }
    let token: Secret;
    try {
      token = readCredential(env, "FIN_OPS_INGEST_TOKEN_FILE", this.#masker);
    } catch (error) {
      const why = error instanceof FinError ? error.message : "the ingest token cannot be read";
      this.#out.warn(`${why}; the lines stay local`);
      return;
    }
    const response = await send(
      "betterstack",
      {
        method: "POST",
        url: `https://${host}/`,
        headers: {
          authorization: `Bearer ${token.reveal()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(batch),
        idempotent: false,
      },
      { fetch: this.#runtime.fetch, sleep: this.#runtime.sleep },
    );
    if (response.status >= 300)
      this.#out.warn(`shipping the run's lines answered ${response.status}; they stay local`);
  }
}
