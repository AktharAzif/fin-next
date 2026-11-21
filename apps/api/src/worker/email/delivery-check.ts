// The `email-delivery-check` duty (spec 01 §8.5, S0-09): once after each new release and once a day,
// queue `ops/delivery-check` to the seed inbox through `email.enqueue()`, so the outbox, the sender
// and Cloudflare are proven continuously. The `email-delivery-check` heartbeat is pinged when that
// email is sent (`onDeliveryCheckSent`), so a silent failure anywhere on the path stops the pings.
//
// `email.delivery_check` records each release's check, so replicas and restarts agree. Replicas take
// turns by locking that table, which only the worker's role may write, so no other login can hold the
// check up (ARCHITECTURE §4.6 rules out advisory locks, which any login can take); the wait for the
// lock is bounded, so a stuck holder costs one failed run, never a pooled connection held for long.
// The check is queued in the same transaction as its record. Each run then records its result in
// `ops.duty_state` (spec 01 §6.10), the duty's last success that `fin_probe` and the alerts read.
import {
  type EmailLog,
  enqueue,
  inTransaction,
  newId,
  type PoolLike,
  type Queryable,
} from "@fin/email";

export const DUTY = "email-delivery-check";
export const DAY_MS = 86_400_000;
/** How long a run waits for another replica's check (or for the duty's state row) before failing. */
export const LOCK_TIMEOUT = "5s";

export interface DeliveryCheckOptions {
  readonly db: PoolLike;
  readonly clock: { now(): number };
  readonly release: string;
  readonly seedInbox: string;
  readonly log: EmailLog;
}

export type DeliveryCheckResult =
  | { readonly result: "queued"; readonly trigger: "release" | "daily"; readonly checkId: string }
  | { readonly result: "skipped" }
  | { readonly result: "failed"; readonly code: string };

/** Runs the duty once and writes its `job.run` line. Never throws. */
export async function runDeliveryCheck(o: DeliveryCheckOptions): Promise<DeliveryCheckResult> {
  const started = o.clock.now();
  let outcome: DeliveryCheckResult;
  try {
    outcome = await inTransaction(o.db, async (tx) => {
      await tx.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      // SHARE ROW EXCLUSIVE conflicts with itself, so one replica checks at a time. Taking it needs
      // UPDATE on the table, which only the worker's role holds.
      await tx.query("LOCK TABLE email.delivery_check IN SHARE ROW EXCLUSIVE MODE");
      const seen = await tx.query<{ this_release: boolean; last: Date | null }>(
        `SELECT bool_or(release = $1) AS this_release, max(enqueued_at) AS last FROM email.delivery_check`,
        [o.release],
      );
      const row = seen.rows[0];
      const now = o.clock.now();
      let trigger: "release" | "daily";
      if (row?.this_release !== true) trigger = "release";
      else if (row.last === null || new Date(row.last).getTime() <= now - DAY_MS) trigger = "daily";
      else return { result: "skipped" } as const;

      const checkId = newId("job", o.clock);
      const time = new Date(now).toISOString();
      await tx.query(
        `INSERT INTO email.delivery_check (release, check_id, trigger, enqueued_at)
         VALUES ($1, $2, $3, $4::timestamptz)
         ON CONFLICT (release) DO UPDATE SET check_id = $2, trigger = $3, enqueued_at = $4::timestamptz`,
        [o.release, checkId, trigger, time],
      );
      await enqueue(tx, {
        id: newId("eml", o.clock),
        template: "ops/delivery-check",
        recipientKind: "address",
        recipient: o.seedInbox,
        params: { checkId, release: o.release, trigger, time },
      });
      return { result: "queued", trigger, checkId } as const;
    });
  } catch (error) {
    outcome = { result: "failed", code: codeOf(error) };
  }
  const recorded = await recordDutyState(o.db, o.clock.now(), outcome.result !== "failed");
  const durationMs = o.clock.now() - started;
  // The duty's state row could not be written: the run stands, and the line says so.
  const state = recorded === "ok" ? {} : { dutyState: "failed", dutyStateCode: recorded };
  if (outcome.result === "queued") {
    o.log.log(
      "job.run",
      {
        job: DUTY,
        trigger: outcome.trigger,
        result: "ok",
        checkId: outcome.checkId,
        durationMs,
        ...state,
      },
      recorded === "ok" ? "info" : "warn",
    );
  } else if (outcome.result === "skipped") {
    o.log.log(
      "job.run",
      {
        job: DUTY,
        trigger: "schedule",
        result: "skipped",
        skipReason: "no_work",
        durationMs,
        ...state,
      },
      recorded === "ok" ? "info" : "warn",
    );
  } else {
    o.log.log(
      "job.run",
      {
        job: DUTY,
        trigger: "schedule",
        result: "failed",
        code: outcome.code,
        durationMs,
        ...state,
      },
      "error",
    );
  }
  return outcome;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? `pg_${code}` : "error";
}

/**
 * Records a run in `ops.duty_state` (scheduler `worker`, duty `email-delivery-check`): the attempt,
 * the result, the last success, and the failures in a row. Its own short transaction, after the
 * check's, so a failed check is still recorded. Returns "ok" or the failure's code; never throws.
 */
export async function recordDutyState(db: PoolLike, now: number, ok: boolean): Promise<string> {
  try {
    await inTransaction(db, async (tx: Queryable) => {
      await tx.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      await tx.query(
        `INSERT INTO ops.duty_state AS d
                (scheduler, duty, last_success_at, last_attempt_at, last_result, consecutive_failures)
         VALUES ('worker', $1, CASE WHEN $3::boolean THEN $2::timestamptz END, $2::timestamptz,
                 CASE WHEN $3 THEN 'ok' ELSE 'failed' END, CASE WHEN $3 THEN 0 ELSE 1 END)
         ON CONFLICT (scheduler, duty) DO UPDATE
            SET last_attempt_at = EXCLUDED.last_attempt_at,
                last_result = EXCLUDED.last_result,
                last_success_at = coalesce(EXCLUDED.last_success_at, d.last_success_at),
                consecutive_failures = CASE WHEN $3 THEN 0 ELSE d.consecutive_failures + 1 END`,
        [DUTY, new Date(now).toISOString(), ok],
      );
    });
    return "ok";
  } catch (error) {
    return codeOf(error);
  }
}

export interface HeartbeatOptions {
  readonly url: string | undefined;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Pings the heartbeat once. The URL is a secret: it is never logged, only whether the ping worked. */
export async function pingHeartbeat(o: HeartbeatOptions): Promise<"ok" | "failed" | "unset"> {
  if (o.url === undefined) return "unset";
  try {
    const response = await (o.fetch ?? fetch)(o.url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

/** The sender's `onSent` hook: after a delivery-check email goes, ping the heartbeat and say so. */
export function onDeliveryCheckSent(log: EmailLog, heartbeat: HeartbeatOptions) {
  return async (info: { readonly template: string; readonly emailId: string }): Promise<void> => {
    if (info.template !== "ops/delivery-check") return;
    const result = await pingHeartbeat(heartbeat);
    log.log(
      "job.run",
      {
        job: DUTY,
        trigger: "sent",
        result: result === "failed" ? "failed" : "ok",
        heartbeat: result,
        emailId: info.emailId,
      },
      result === "failed" ? "error" : "info",
    );
  };
}
