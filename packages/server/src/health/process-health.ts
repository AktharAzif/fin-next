// `process.health` every minute (ARCHITECTURE §10.2; spec 01 §8.3): event-loop p99, heap and RSS,
// background work, the HTTP server's open connections (`httpConnections`), and whatever the
// process adds (the pool, `listenConnected` from the LISTEN client, `dbOk`, `doorOk` and
// `clockSkewMs` once P0-E's pool and the database probe exist). `listenConnected` means the Postgres
// LISTEN connection (ARCHITECTURE §4.5) and only the database layer writes it. Node-only
// diagnostics report null, never zeros, when unavailable (ARCHITECTURE §3.2).
import { monitorEventLoopDelay } from "node:perf_hooks";
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
