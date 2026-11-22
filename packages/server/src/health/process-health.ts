// `process.health` every minute (ARCHITECTURE §10.2; spec 01 §8.3): event-loop p99, heap and RSS,
// background work, the HTTP server's open connections (`httpConnections`), and whatever the
// process adds (the pool, `listenConnected` from the LISTEN client, `dbOk`, `doorOk`, and
// `clockSkewMs` from sampleDatabaseClock below through the service's own pool). `listenConnected`
// means the Postgres LISTEN connection (ARCHITECTURE §4.5) and only the database layer writes it.
// Node-only diagnostics report null, never zeros, when unavailable (ARCHITECTURE §3.2).
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Clock } from "@fin/core";
import type { Fields } from "../telemetry/lines.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";

export const HEALTH_INTERVAL_MS = 60_000;

export interface ProcessHealthOptions {
  telemetry: Telemetry;
  /** The open sockets of the service's HTTP server, where it has one. */
  httpConnections?: () => Promise<number>;
  /** Fields the process adds; they never replace the ones above. */
  extra?: () => Promise<Fields>;
  intervalMs?: number;
}

export interface ProcessHealth {
  sample(): Promise<Fields>;
  stop(): void;
}

const MB = 1024 * 1024;

export function startProcessHealth(options: ProcessHealthOptions): ProcessHealth {
  let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
  try {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  } catch {
    histogram = undefined;
  }

  const sample = async (): Promise<Fields> => {
    const memory = process.memoryUsage();
    const p99 =
      histogram !== undefined && histogram.count > 0 ? histogram.percentile(99) / 1e6 : null;
    histogram?.reset();
    let httpConnections: number | null = null;
    try {
      httpConnections =
        options.httpConnections !== undefined ? await options.httpConnections() : null;
    } catch {
      httpConnections = null;
    }
    let extra: Fields = {};
    try {
      extra = options.extra !== undefined ? await options.extra() : {};
    } catch {
      extra = {};
    }
    return {
      ...extra,
      eventLoopP99Ms: p99 === null ? null : Math.round(p99 * 100) / 100,
      heapUsedMb: Math.round((memory.heapUsed / MB) * 10) / 10,
      rssMb: Math.round((memory.rss / MB) * 10) / 10,
      background: options.telemetry.backgroundCount,
      httpConnections,
    };
  };

  const timer = setInterval(() => {
    void sample().then((fields) => options.telemetry.logUnit("process.health", fields));
  }, options.intervalMs ?? HEALTH_INTERVAL_MS);
  timer.unref();

  return {
    sample,
    stop: () => {
      clearInterval(timer);
      histogram?.disable();
    },
  };
}

/**
 * The database's time when the server evaluates the statement, in milliseconds since the epoch.
 * clock_timestamp(), never now(): now() is the start of the client's transaction, so a client that
 * ever arrived inside one would report a time as old as that transaction.
 */
export const DATABASE_CLOCK_SQL =
  "SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS at_ms";

/** A pooled client as sampleDatabaseClock uses it, so pg's declaration in each package fits it. */
export interface ClockClient {
  query(text: string): Promise<{ rows: readonly unknown[] }>;
  release(error?: Error): void;
}

/** The service's own pool (packages/db's createPool, or the pool a realm's unit of work runs on). */
export interface ClockPool {
  connect(): Promise<ClockClient>;
}

/** What sampleDatabaseClock adds to `process.health`. */
export interface DatabaseClock {
  /** The database answered the clock query. */
  dbOk: boolean;
  /**
   * The process's clock less the database's, in whole milliseconds: above zero when the process is
   * ahead. Null when it could not be read. The `clock-skew` alert reads its absolute value.
   */
  clockSkewMs: number | null;
}

/**
 * `clockSkewMs` and `dbOk` for a service's health hook (DECISIONS CF-72; ARCHITECTURE §10.2): one
 * DATABASE_CLOCK_SQL on a client of the service's own pool, held for that one query and no other
 * I/O, against the injected Clock read just before and just after it, so the database's time is
 * compared with the midpoint of the round trip (half the round trip corrects it). Never throws: a
 * failure is `dbOk: false` with `clockSkewMs: null`, and a client whose query failed is destroyed,
 * not returned to the pool.
 */
export async function sampleDatabaseClock(pool: ClockPool, clock: Clock): Promise<DatabaseClock> {
  let client: ClockClient;
  try {
    client = await pool.connect();
  } catch {
    return { dbOk: false, clockSkewMs: null };
  }
  let failed: Error | undefined;
  try {
    const sent = clock.now();
    const result = await client.query(DATABASE_CLOCK_SQL);
    const received = clock.now();
    const at = millis((result.rows[0] as { at_ms?: unknown } | undefined)?.at_ms);
    if (at === null) return { dbOk: true, clockSkewMs: null };
    return { dbOk: true, clockSkewMs: Math.round(sent + (received - sent) / 2 - at) };
  } catch (error) {
    failed = error instanceof Error ? error : new Error("the clock query failed");
    return { dbOk: false, clockSkewMs: null };
  } finally {
    client.release(failed);
  }
}

/** The query's value as a finite number (pg gives float8 as a number unless a parser says else). */
function millis(value: unknown): number | null {
  let n = Number.NaN;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "") n = Number(value);
  return Number.isFinite(n) ? n : null;
}
