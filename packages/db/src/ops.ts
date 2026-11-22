// Typed access to Phase 0's ops tables (spec 01 §6.10; ARCHITECTURE §4.6, §15.1): the scheduler lease,
// duty state, kill-switch reads and the checked job enqueue. Every statement runs on the caller's
// unit (a `Queryable`), so it shares the caller's transaction and grants.
import type { Queryable, UnitTx } from "./unit.ts";

export type Scheduler = "worker" | "payments";

export const LEASE_SECONDS = 90;

/**
 * Takes or renews the scheduler's lease (ARCHITECTURE §4.6): the row moves to `holder` when the lease
 * has lapsed or `holder` already holds it. Returns the lease's end, or null when another replica holds
 * it. Row-level security limits each scheduler's role to its own row.
 */
export async function acquireLease(
  q: Queryable,
  scheduler: Scheduler,
  holder: string,
  seconds: number = LEASE_SECONDS,
): Promise<Date | null> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(holder)) throw new TypeError("lease holder shape");
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600)
    throw new RangeError("lease seconds");
  const result = await q.query<{ until: Date }>(
    `UPDATE ops.scheduler_lease
     SET holder = $2, until = statement_timestamp() + make_interval(secs => $3), renewed_at = statement_timestamp()
     WHERE name = $1 AND (until IS NULL OR until < statement_timestamp() OR holder = $2)
     RETURNING until`,
    [scheduler, holder, seconds],
  );
  return result.rows[0]?.until ?? null;
}

/** Releases the lease on shutdown, so another replica can take it at once. */
export async function releaseLease(
  q: Queryable,
  scheduler: Scheduler,
  holder: string,
): Promise<boolean> {
  const result = await q.query(
    `UPDATE ops.scheduler_lease SET holder = NULL, until = NULL, renewed_at = statement_timestamp()
     WHERE name = $1 AND holder = $2`,
    [scheduler, holder],
  );
  return result.rowCount === 1;
}

export interface DutyResult {
  scheduler: Scheduler;
  duty: string;
  result: "ok" | "failed";
}

/** Records one run of a duty: its last attempt, its last success and the failure streak. */
export async function recordDutyRun(q: Queryable, run: DutyResult): Promise<void> {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(run.duty)) throw new TypeError("duty name shape");
  await q.query(
    `INSERT INTO ops.duty_state AS d (scheduler, duty, last_success_at, last_attempt_at, last_result, consecutive_failures)
     VALUES ($1, $2, CASE WHEN $3 = 'ok' THEN statement_timestamp() END, statement_timestamp(), $3,
             CASE WHEN $3 = 'ok' THEN 0 ELSE 1 END)
     ON CONFLICT (scheduler, duty) DO UPDATE SET
       last_attempt_at = excluded.last_attempt_at,
       last_result = excluded.last_result,
       last_success_at = coalesce(excluded.last_success_at, d.last_success_at),
       consecutive_failures = CASE WHEN excluded.last_result = 'ok' THEN 0 ELSE d.consecutive_failures + 1 END`,
    [run.scheduler, run.duty, run.result],
  );
}

export interface DutyState {
  duty: string;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  lastResult: "ok" | "failed" | null;
  consecutiveFailures: number;
}

export async function readDutyStates(q: Queryable, scheduler: Scheduler): Promise<DutyState[]> {
  const result = await q.query<{
    duty: string;
    last_success_at: Date | null;
    last_attempt_at: Date | null;
    last_result: "ok" | "failed" | null;
    consecutive_failures: number;
  }>(
    `SELECT duty, last_success_at, last_attempt_at, last_result, consecutive_failures
     FROM ops.duty_state WHERE scheduler = $1 ORDER BY duty`,
    [scheduler],
  );
  return result.rows.map((row) => ({
    duty: row.duty,
    lastSuccessAt: row.last_success_at,
    lastAttemptAt: row.last_attempt_at,
    lastResult: row.last_result,
    consecutiveFailures: row.consecutive_failures,
  }));
}

export const KILL_SWITCHES = [
  "live_keys",
  "live_money",
  "signups",
  "hosted_verify",
  "outbound_webhooks",
  "sumsub_writes",
] as const;
export type KillSwitch = (typeof KILL_SWITCHES)[number] | `provider_instance:${string}`;

/** Whether a switch is on (the work it names stops). Read on every request, never cached (OP-01). */
export async function isSwitchOn(q: Queryable, name: KillSwitch): Promise<boolean> {
  const result = await q.query<{ state: "on" | "off" }>(
    "SELECT state FROM ops.kill_switch WHERE name = $1",
    [name],
  );
  // A switch that is not there fails closed: its work stops.
  return result.rows[0]?.state !== "off";
}

export interface EnqueueJob {
  kind: string;
  payload?: Readonly<Record<string, string | number | boolean | null>>;
  dueAt?: Date;
}

/** Enqueues a job through ops.enqueue_job(), in the caller's transaction. Returns the `job_` ID. */
export async function enqueueJob(tx: UnitTx, job: EnqueueJob): Promise<string> {
  const id = tx.ids.newId("job");
  await tx.query("SELECT ops.enqueue_job($1, $2, $3::jsonb, $4)", [
    id,
    job.kind,
    JSON.stringify(job.payload ?? {}),
    job.dueAt ?? null,
  ]);
  return id;
}
