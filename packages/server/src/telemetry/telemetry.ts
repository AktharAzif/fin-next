// One structured line per unit of work (ARCHITECTURE §10.2, §10.3; spec 08 §7.2, §7.3). Each unit
// keeps its batch in AsyncLocalStorage; every line is scrubbed and capped before stdout and before
// shipping; a unit's batch is POSTed after its answer, and lines outside a unit go to a bounded
// process queue sent every 5 seconds. Shipping failures are swallowed: `telemetry.ship_failed` goes
// to stdout and the next good batch carries `telemetry.recovered`. Monitoring never breaks the work.
//
// Three rules keep the direct shipment the record:
//   - a process line (`logUnit`) is registered for sending before the call returns, so the flush
//     that follows it on shutdown and on a crash waits for it;
//   - once a unit's batch is taken, lines its background work writes later (`shipAfter`) go to the
//     process queue with the unit's IDs, never into the batch already sent;
//   - a send claims the gap it reports before its first await, so concurrent sends after an outage
//     report it once, and a failed send hands it back;
//   - a line whose stdout write fails (Railway's copy) still ships.
import { AsyncLocalStorage } from "node:async_hooks";
import { type Clock, isBoundedCode, rfc3339, safeError, scrubLine } from "@fin/core";
import type { Environment, ServiceName } from "../config/index.ts";
import { type StdoutWriter, writeStdout } from "../log/stdout.ts";
import { capLine } from "./cap.ts";
import { ENVELOPE_KEYS, type Fields, type Level } from "./lines.ts";
import { batches, gzipLines, type SendResult, sendWithRetry, type Transport } from "./ship.ts";

export const QUEUE_LIMIT = 1000;
export const QUEUE_INTERVAL_MS = 5000;

export interface UnitStart {
  requestId?: string;
  runId?: string;
}

interface UnitState extends UnitStart {
  lines: string[];
  dropped: number;
  /** Set when the unit ends and its batch is taken. */
  closed: boolean;
}

/** Sends that failed and lines lost since the last good batch reported them. */
interface Gap {
  failedSends: number;
  linesLost: number;
  statuses: Set<number>;
}

const noGap = (): Gap => ({ failedSends: 0, linesLost: 0, statuses: new Set() });

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
  private gap: Gap = noGap();
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

  /** Railway's copy: a writer that throws loses it, never the shipment that follows. */
  private writeLocal(text: string): void {
    try {
      this.stdout(text);
    } catch {
      // The line still ships: Better Stack's copy is the record.
    }
  }

  /** Writes a scrubbed line to stdout only (Railway's copy), never shipped. */
  logLocal(event: string, fields: Fields = {}, level: Level = "info"): void {
    try {
      this.writeLocal(this.format(event, fields, level, this.storage.getStore()));
    } catch {
      // Monitoring never breaks the work.
    }
  }

  /** Writes one line: stdout now, and Better Stack with its unit's batch or the process queue. */
  log(event: string, fields: Fields = {}, level: Level = "info"): void {
    try {
      const unit = this.storage.getStore();
      const text = this.format(event, fields, level, unit);
      this.writeLocal(text);
      if (this.transport === undefined) return;
      if (unit !== undefined && !unit.closed) {
        if (unit.lines.length < this.queueLimit) unit.lines.push(text);
        else unit.dropped++;
      } else {
        // Outside a unit, or after the unit's batch went: background work that logs after the
        // answer (spec 08 §7.3) still reaches Better Stack, with the unit's IDs on the line.
        this.enqueue(text);
      }
    } catch {
      // Monitoring never breaks the work.
    }
  }

  /** Runs `fn` as one unit of work; its batch ships after it ends, even when it throws. */
  async withUnit<T>(unit: UnitStart, fn: () => Promise<T>): Promise<T> {
    const state: UnitState = { ...unit, lines: [], dropped: 0, closed: false };
    try {
      return await this.storage.run(state, fn);
    } finally {
      this.closeUnit(state);
    }
  }

  /**
   * Writes a line in a unit of its own (process lines: spec 08 §7.2). Its send is registered
   * before this returns, so `flush` called next (shutdown, the crash path, a failed start) waits
   * for it.
   */
  logUnit(event: string, fields: Fields = {}, level: Level = "info", unit: UnitStart = {}): void {
    try {
      const text = this.format(event, fields, level, unit);
      this.writeLocal(text);
      if (this.transport !== undefined) this.shipLines([text], "telemetry.unit");
    } catch {
      // Monitoring never breaks the work.
    }
  }

  private enqueue(text: string): void {
    this.queue.push(text);
    if (this.queue.length > this.queueLimit) {
      this.queue.shift();
      this.queueDropped++;
    }
  }

  private closeUnit(state: UnitState): void {
    state.closed = true;
    if (this.transport === undefined) return;
    const lines = state.lines.splice(0);
    if (state.dropped > 0) this.gap.linesLost += state.dropped;
    if (lines.length > 0) this.shipLines(lines, "telemetry.unit");
  }

  /** Registers a send now; it starts on the next turn of the event loop, after the answer. */
  private shipLines(lines: string[], name: string): void {
    this.shipAfter(
      nextTurn().then(() => this.send(lines)),
      name,
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

  /** Takes the gap to report: whoever claims it reports it, once. */
  private claimGap(): Gap | undefined {
    if (this.gap.failedSends === 0 && this.gap.linesLost === 0) return undefined;
    const claimed = this.gap;
    this.gap = noGap();
    return claimed;
  }

  /** Hands a claimed gap back when the batch that reported it failed. */
  private returnGap(claimed: Gap): void {
    this.gap.failedSends += claimed.failedSends;
    this.gap.linesLost += claimed.linesLost;
    for (const status of claimed.statuses) this.gap.statuses.add(status);
  }

  private async send(lines: string[]): Promise<void> {
    const transport = this.transport;
    if (transport === undefined) return;
    // Claimed before the first await: a send running beside this one reports no gap of its own.
    const claimed = this.claimGap();
    const all =
      claimed !== undefined
        ? [
            this.format(
              "telemetry.recovered",
              {
                failedSends: claimed.failedSends,
                linesLost: claimed.linesLost,
                statuses: [...claimed.statuses].sort((a, b) => a - b),
              },
              "warn",
            ),
            ...lines,
          ]
        : lines;
    let first = true;
    for (const batch of batches(all)) {
      const reports = first && claimed !== undefined;
      first = false;
      let result: SendResult;
      try {
        result = await sendWithRetry(transport, await gzipLines(batch), this.sendTimeoutMs);
      } catch {
        result = { ok: false, status: 0 };
      }
      if (result.ok) continue;
      const real = reports ? batch.length - 1 : batch.length;
      if (reports) this.returnGap(claimed);
      this.gap.failedSends++;
      this.gap.linesLost += real;
      this.gap.statuses.add(result.status);
      this.writeLocal(
        this.format("telemetry.ship_failed", { status: result.status, linesLost: real }, "warn"),
      );
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
   * Sends the process queue and waits for every send and background task, and for the lines they
   * write in turn, for at most `deadlineMs` (the shutdown and crash paths).
   */
  async flush(deadlineMs: number): Promise<void> {
    this.shipQueue();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadlineMs));
      timer.unref();
    });
    const settle = async (): Promise<void> => {
      // A unit that is ending now hands over its batch in a `finally` still queued: let it run.
      await nextTurn();
      while (this.background.size > 0 || this.queue.length > 0) {
        this.shipQueue();
        await Promise.allSettled([...this.background]);
      }
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
