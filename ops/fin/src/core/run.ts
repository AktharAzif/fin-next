// A registered run (spec 01 §10, ARCHITECTURE §6.10): a mutating command takes the run lock and
// writes `run.registered` before it changes anything, one `run.step` per change it sends, and
// `run.done` with the result at the end, whatever happened. A dry run takes no lock and writes no
// record, and nothing can be sent in one: the provider writers ask assertWritable() first.
//
// Each record also becomes a telemetry line in spec 08 §7.2's envelope (service `ops`), written
// beside the run log, printed in GitHub Actions (the job log is the record there), and shipped to
// the Better Stack source `fin-next-<env>-ops` when FIN_OPS_INGEST_HOST and
// FIN_OPS_INGEST_TOKEN_FILE are set.

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { hasCredential, readCredential } from "./credentials.ts";
import { FinError } from "./errors.ts";
import { send } from "./http.ts";
import type { Masker } from "./mask.ts";
import type { Output } from "./output.ts";
import type { RunLog } from "./runlog.ts";
import { newRunId, type Runtime } from "./runtime.ts";

export type RunResult = "ok" | "failed" | "refused";

export interface RunOptions {
  command: string;
  environment: string;
  dryRun: boolean;
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

export class Run {
  readonly id: string;
  readonly command: string;
  readonly environment: string;
  readonly dryRun: boolean;
  readonly #runtime: Runtime;
  readonly #log: RunLog;
  readonly #out: Output;
  readonly #masker: Masker;
  readonly #lines: Line[] = [];
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
  }

  get registered(): boolean {
    return this.#registered;
  }

  get lines(): readonly Line[] {
    return this.#lines;
  }

  /** Takes the lock and writes `run.registered`. A dry run does neither. */
  register(fields: Record<string, unknown> = {}): void {
    if (this.dryRun || this.#registered) return;
    this.#log.lock({
      runId: this.id,
      command: this.command,
      startedAt: this.#runtime.now().toISOString(),
    });
    try {
      this.#log.append(this.#runtime.now(), this.id, "run.registered", {
        command: this.command,
        environment: this.environment,
        operator: this.#runtime.operator(),
        commit: this.#runtime.commit() ?? null,
        ...fields,
      });
    } catch (error) {
      this.#log.unlock(this.id);
      throw error;
    }
    this.#registered = true;
    this.line("run.registered", "info", { command: this.command });
  }

  /** Refuses a provider write outside a registered run (and in every dry run). */
  assertWritable(what: string): void {
    if (this.dryRun) throw new FinError(`${what}: a dry run sends nothing`, 70);
    if (!this.#registered || this.#finished) {
      throw new FinError(`${what}: a write outside a registered run is refused`, 70);
    }
  }

  /** Records one change the run sent (names and roles only; the masker runs first). */
  step(kind: string, name: string, action: string, fields: Record<string, unknown> = {}): void {
    if (!this.#registered) return;
    this.#steps++;
    this.#log.append(this.#runtime.now(), this.id, "run.step", { kind, name, action, ...fields });
  }

  /** Writes a telemetry line (spec 08 §7.2's envelope). */
  line(event: string, level: Line["level"], fields: Record<string, unknown> = {}): void {
    const masked = JSON.parse(
      this.#masker.mask(
        JSON.stringify({
          dt: this.#runtime.now().toISOString(),
          message: event,
          event,
          level,
          service: "ops",
          environment: this.environment,
          release: this.#runtime.commit() ?? "unknown",
          replica: this.id,
          runId: this.id,
          ...fields,
        }),
      ),
    ) as Line;
    this.#lines.push(masked);
    if (this.#runtime.env.GITHUB_ACTIONS === "true") this.#out.info(JSON.stringify(masked));
  }

  /** Writes `run.done` and releases the lock. Safe to call once; later calls do nothing. */
  finish(result: RunResult, fields: Record<string, unknown> = {}): void {
    if (this.#finished) return;
    this.#finished = true;
    if (!this.#registered) return;
    try {
      this.#log.append(this.#runtime.now(), this.id, "run.done", {
        command: this.command,
        result,
        steps: this.#steps,
        ...fields,
      });
      this.line("run.done", result === "ok" ? "info" : "error", {
        command: this.command,
        result,
        steps: this.#steps,
      });
    } finally {
      this.#log.unlock(this.id);
    }
  }

  /** Appends the lines to the local lines file and ships them when an ingest is configured. */
  async flushLines(): Promise<void> {
    if (this.#lines.length === 0) return;
    const file = join(this.#log.dir, "lines.jsonl");
    try {
      mkdirSync(this.#log.dir, { recursive: true, mode: 0o700 });
      const fd = openSync(file, "a", 0o600);
      try {
        for (const line of this.#lines) writeSync(fd, `${JSON.stringify(line)}\n`);
      } finally {
        closeSync(fd);
      }
    } catch {
      this.#out.warn("the telemetry lines could not be written beside the run log");
    }
    const env = this.#runtime.env;
    const host = env.FIN_OPS_INGEST_HOST;
    if (host === undefined || host === "" || !hasCredential(env, "FIN_OPS_INGEST_TOKEN_FILE"))
      return;
    this.#masker.register(host, "<ops-ingest-host>");
    if (!/^[a-z0-9.-]+$/.test(host)) {
      this.#out.warn("FIN_OPS_INGEST_HOST is not a hostname; the lines stay local");
      return;
    }
    const token = readCredential(env, "FIN_OPS_INGEST_TOKEN_FILE", this.#masker);
    try {
      const response = await send(
        "betterstack",
        {
          method: "POST",
          url: `https://${host}/`,
          headers: {
            authorization: `Bearer ${token.reveal()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(this.#lines),
          idempotent: false,
        },
        { fetch: this.#runtime.fetch, sleep: this.#runtime.sleep },
      );
      if (response.status >= 300)
        this.#out.warn(`shipping the run's lines answered ${response.status}; they stay local`);
    } catch {
      this.#out.warn("shipping the run's lines failed; they stay local");
    }
  }
}
