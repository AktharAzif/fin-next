// The sequencer's loop (spec 08 §3.6; ARCHITECTURE §8.3): every second, while this replica holds the
// worker's scheduler lease, one unit of work calls audit.sequence(), which chains committed rows in a
// fixed order and moves the head. It writes one `job.run` line a minute, not one a second (D08-06):
// `job: "audit-sequencer"`, `processed`, `runs`, `failed`, `oldestUnsequencedS`, `result`.
//
// The worker's entry (apps/api/src/worker/) starts it with the lease check and the shutdown signal;
// nothing here starts a timer at module scope.
import type { Clock, FinDatabase, LineSink, Queryable, UnitContext } from "@fin/db";

export const SEQUENCER_BATCH = 5000;

/** One pass: chains up to `max` rows and returns how many. */
export async function sequencePass(q: Queryable, max: number = SEQUENCER_BATCH): Promise<number> {
  const result = await q.query<{ n: number }>("SELECT audit.sequence($1) AS n", [max]);
  return result.rows[0]?.n ?? 0;
}

/** Seconds since the oldest unchained row (the worker's own reading; the probe has its own). */
export async function oldestUnsequencedSeconds(q: Queryable): Promise<number> {
  const result = await q.query<{ s: number | null }>(
    "SELECT floor(extract(epoch FROM (now() - min(recorded_at))))::int AS s FROM audit.event WHERE seq IS NULL",
  );
  return Math.max(0, result.rows[0]?.s ?? 0);
}

export interface SequencerOptions {
  db: FinDatabase;
  clock: Clock;
  log: LineSink;
  /** A fresh unit context per pass (the worker's, with its run ID). */
  context: () => UnitContext;
  /** True while this replica holds the worker's scheduler lease. */
  holdsLease: () => boolean;
  /** Resolves after `ms`, or early when the signal aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  intervalMs?: number;
  reportEveryMs?: number;
}

export async function runSequencer(options: SequencerOptions, signal: AbortSignal): Promise<void> {
  const interval = options.intervalMs ?? 1_000;
  const reportEvery = options.reportEveryMs ?? 60_000;
  let windowStart = options.clock.now();
  let processed = 0;
  let runs = 0;
  let failed = 0;
  let skipped = 0;

  const report = async () => {
    let oldest = 0;
    try {
      oldest = await options.db.read(options.context(), (q) => oldestUnsequencedSeconds(q));
    } catch {
      failed += 1;
    }
    options.log.write({
      event: "job.run",
      level: failed > 0 ? "error" : "info",
      fields: {
        job: "audit-sequencer",
        trigger: "schedule",
        processed,
        runs,
        failed,
        oldestUnsequencedS: oldest,
        result: failed > 0 ? "failed" : runs === 0 ? "skipped" : "ok",
        ...(failed === 0 && runs === 0 && skipped > 0 ? { skipReason: "leased" } : {}),
      },
    });
    processed = 0;
    runs = 0;
    failed = 0;
    skipped = 0;
  };

  while (!signal.aborted) {
    if (options.holdsLease()) {
      try {
        processed += await options.db.unit(options.context(), (tx) => sequencePass(tx));
        runs += 1;
      } catch {
        failed += 1;
      }
    } else {
      skipped += 1;
    }
    if (options.clock.now() - windowStart >= reportEvery) {
      await report();
      windowStart = options.clock.now();
    }
    await options.sleep(interval, signal);
  }
}
