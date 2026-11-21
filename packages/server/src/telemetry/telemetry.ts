// One structured line per unit of work (ARCHITECTURE §10.2, §10.3; spec 08 §7.2, §7.3). Each unit
// keeps its batch in AsyncLocalStorage; every line is scrubbed and capped before stdout and before
// shipping; a unit's batch is POSTed after its answer, and lines outside a unit go to a bounded
// process queue sent every 5 seconds. Shipping failures are swallowed: `telemetry.ship_failed` goes
// to stdout and the next good batch carries `telemetry.recovered`. Monitoring never breaks the work.
import { AsyncLocalStorage } from "node:async_hooks";
import { type Clock, isBoundedCode, rfc3339, safeError, scrubLine } from "@fin/core";
import type { Environment, ServiceName } from "../config/index.ts";
import { type StdoutWriter, writeStdout } from "../log/stdout.ts";
import { capLine } from "./cap.ts";
import { ENVELOPE_KEYS, type Fields, type Level } from "./lines.ts";
import { batches, gzipLines, sendWithRetry, type Transport } from "./ship.ts";

export const QUEUE_LIMIT = 1000;
export const QUEUE_INTERVAL_MS = 5000;

export interface UnitStart {
  requestId?: string;
  runId?: string;
}

interface UnitState extends UnitStart {
  lines: string[];
  dropped: number;
}

export interface TelemetryOptions {
  service: ServiceName;
  environment: Environment;
  release: string;
  replica: string;
  clock: Clock;
  /** Absent in development and CI without a source: stdout only. */
  transport?: Transport;
  stdout?: StdoutWriter;
  queueLimit?: number;
  sendTimeoutMs?: number;
}

/** Called when background work fails, so the reporter can record it. */
export type BackgroundFailureHook = (error: unknown, name: string) => void;

export class Telemetry {
  readonly service: ServiceName;
  readonly environment: Environment;
  readonly release: string;
  readonly replica: string;
  readonly clock: Clock;
  private readonly transport: Transport | undefined;
  private readonly stdout: StdoutWriter;
  private readonly queueLimit: number;
  private readonly sendTimeoutMs: number;
  private readonly storage = new AsyncLocalStorage<UnitState>();
  private readonly background = new Set<Promise<void>>();
  private queue: string[] = [];
  private queueDropped = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private gap = { failedSends: 0, linesLost: 0, statuses: new Set<number>() };
  private backgroundFailure: BackgroundFailureHook | undefined;

  constructor(options: TelemetryOptions) {
    this.service = options.service;
    this.environment = options.environment;
    this.release = options.release;
    this.replica = options.replica;
    this.clock = options.clock;
    this.transport = options.transport;
    this.stdout = options.stdout ?? writeStdout;
    this.queueLimit = options.queueLimit ?? QUEUE_LIMIT;
    this.sendTimeoutMs = options.sendTimeoutMs ?? 3000;
  }

  /** Whether lines leave the process (a source is configured). */
  get shipping(): boolean {
    return this.transport !== undefined;
  }

  /** Background work in flight, for `process.health`'s `background` field. */
  get backgroundCount(): number {
    return this.background.size;
  }

  onBackgroundFailure(hook: BackgroundFailureHook): void {
    this.backgroundFailure = hook;
  }

  /** Starts the 5-second process queue. Never called at module scope. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.shipQueue(), QUEUE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The current unit's IDs, if any. */
  currentUnit(): UnitStart | undefined {
    const unit = this.storage.getStore();
    if (unit === undefined) return undefined;
    const out: UnitStart = {};
    if (unit.requestId !== undefined) out.requestId = unit.requestId;
    if (unit.runId !== undefined) out.runId = unit.runId;
    return out;
  }

  /** Builds, scrubs and caps one line. */
  format(event: string, fields: Fields, level: Level, unit?: UnitStart): string {
    const name = isBoundedCode(event) ? event : "telemetry.bad_event";
    const line: Record<string, unknown> = {
      dt: rfc3339(this.clock.now()),
      message: name,
      event: name,
      level,
      service: this.service,
      environment: this.environment,
      release: this.release,
      replica: this.replica,
    };
    if (unit?.requestId !== undefined) line.requestId = unit.requestId;
    if (unit?.runId !== undefined) line.runId = unit.runId;
    for (const [key, value] of Object.entries(fields)) {
      if (!ENVELOPE_KEYS.has(key) && value !== undefined) line[key] = value;
    }
    return capLine(scrubLine(line));
  }

  /** Writes a scrubbed line to stdout only (Railway's copy), never shipped. */
  logLocal(event: string, fields: Fields = {}, level: Level = "info"): void {
    try {
      this.stdout(this.format(event, fields, level, this.storage.getStore()));
    } catch {
      // Monitoring never breaks the work.
    }
  }

  /** Writes one line: stdout now, and Better Stack with its unit's batch or the process queue. */
  log(event: string, fields: Fields = {}, level: Level = "info"): void {
    try {
      const unit = this.storage.getStore();
      const text = this.format(event, fields, level, unit);
      this.stdout(text);
      if (this.transport === undefined) return;
      if (unit !== undefined) {
        if (unit.lines.length < this.queueLimit) unit.lines.push(text);
        else unit.dropped++;
      } else {
        this.queue.push(text);
        if (this.queue.length > this.queueLimit) {
          this.queue.shift();
          this.queueDropped++;
        }
      }
    } catch {
      // Monitoring never breaks the work.
    }
  }

  /** Runs `fn` as one unit of work; its batch ships after it ends, even when it throws. */
  async withUnit<T>(unit: UnitStart, fn: () => Promise<T>): Promise<T> {
    const state: UnitState = { ...unit, lines: [], dropped: 0 };
    try {
      return await this.storage.run(state, fn);
    } finally {
      this.shipUnit(state);
    }
  }

  /** Writes a line in a unit of its own (process lines: spec 08 §7.2), shipped at once. */
  logUnit(event: string, fields: Fields = {}, level: Level = "info", unit: UnitStart = {}): void {
    void this.withUnit(unit, async () => this.log(event, fields, level));
  }

  private shipUnit(state: UnitState): void {
    if (this.transport === undefined) return;
    const lines = state.lines.splice(0);
    if (state.dropped > 0) this.gap.linesLost += state.dropped;
    if (lines.length === 0) return;
    // After the answer: the next turn of the event loop, never in the request's path.
    this.shipAfter(
      new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.send(lines)),
      "telemetry.unit",
    );
  }

  private shipQueue(): void {
    if (this.transport === undefined) return;
    if (this.queueDropped > 0) {
      this.gap.linesLost += this.queueDropped;
      this.queueDropped = 0;
    }
    const lines = this.queue.splice(0);
    if (lines.length > 0) this.shipAfter(this.send(lines), "telemetry.queue");
  }

  private async send(lines: string[]): Promise<void> {
    const transport = this.transport;
    if (transport === undefined) return;
    const recovering = this.gap.failedSends > 0 || this.gap.linesLost > 0;
    const snapshot = {
      failedSends: this.gap.failedSends,
      linesLost: this.gap.linesLost,
      statuses: [...this.gap.statuses].sort((a, b) => a - b),
    };
    const all = recovering
      ? [this.format("telemetry.recovered", snapshot, "warn", this.currentUnit()), ...lines]
      : lines;
    let first = true;
    for (const batch of batches(all)) {
      const result = await sendWithRetry(transport, await gzipLines(batch), this.sendTimeoutMs);
      const real = first && recovering ? batch.length - 1 : batch.length;
      if (result.ok) {
        if (first && recovering) {
          this.gap.failedSends -= snapshot.failedSends;
          this.gap.linesLost -= snapshot.linesLost;
          for (const status of snapshot.statuses) this.gap.statuses.delete(status);
        }
      } else {
        this.gap.failedSends++;
        this.gap.linesLost += real;
        this.gap.statuses.add(result.status);
        this.stdout(
          this.format("telemetry.ship_failed", { status: result.status, linesLost: real }, "warn"),
        );
      }
      first = false;
    }
  }

  /**
   * Registers background work that runs after the answer: its rejection is caught, logged as
   * `background.failed` and reported, and shutdown drains it.
   */
  shipAfter(work: Promise<unknown>, name = "background"): void {
    const tracked: Promise<void> = work.then(
      () => undefined,
      (error: unknown) => {
        const safe = safeError(error);
        this.log(
          "background.failed",
          { task: name, errorName: safe.errorName, errorCode: safe.errorCode },
          "error",
        );
        try {
          this.backgroundFailure?.(error, name);
        } catch {
          // A failing hook is not allowed to throw out of the registry.
        }
      },
    );
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  /**
   * Sends the process queue and waits for every send and background task, for at most
   * `deadlineMs` (the shutdown and crash paths).
   */
  async flush(deadlineMs: number): Promise<void> {
    this.shipQueue();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadlineMs));
      timer.unref();
    });
    const settle = async (): Promise<void> => {
      while (this.background.size > 0) await Promise.allSettled([...this.background]);
      this.shipQueue();
      while (this.background.size > 0) await Promise.allSettled([...this.background]);
    };
    await Promise.race([settle(), deadline]);
    if (timer !== undefined) clearTimeout(timer);
  }
}

let installed: Telemetry | undefined;

/** Installs the process's telemetry; main() calls it once. */
export function installTelemetry(telemetry: Telemetry): void {
  installed = telemetry;
}

export function currentTelemetry(): Telemetry | undefined {
  return installed;
}

/** spec 08 §7.3's `log`: through the installed telemetry, or stdout alone before it exists. */
export function log(event: string, fields: Fields = {}, level: Level = "info"): void {
  if (installed !== undefined) installed.log(event, fields, level);
  else writeStdout(JSON.stringify(scrubLine({ message: event, event, level, ...fields })));
}

export function withUnit<T>(unit: UnitStart, fn: () => Promise<T>): Promise<T> {
  return installed !== undefined ? installed.withUnit(unit, fn) : fn();
}

export function shipAfter(work: Promise<unknown>): void {
  if (installed !== undefined) installed.shipAfter(work);
  else void work.catch(() => undefined);
}

export function flush(deadlineMs: number): Promise<void> {
  return installed !== undefined ? installed.flush(deadlineMs) : Promise.resolve();
}
