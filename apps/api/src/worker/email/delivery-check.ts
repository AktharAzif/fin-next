// The `email-delivery-check` duty (spec 01 §8.5, S0-09): once after each new release and once a day,
// queue `ops/delivery-check` to the seed inbox through `email.enqueue()`, so the outbox, the sender
// and Cloudflare are proven continuously. The `email-delivery-check` heartbeat is pinged when that
// email is sent (`onDeliveryCheckSent`), so a silent failure anywhere on the path stops the pings.
//
// `email.delivery_check` records each release's check, so replicas and restarts agree: the check
// runs under a transaction-level advisory lock and is queued in the same transaction as its record.
import { type EmailLog, enqueue, inTransaction, newId, type PoolLike } from "@fin/email";

export const DUTY = "email-delivery-check";
export const DAY_MS = 86_400_000;

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
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('fin:email-delivery-check'))");
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
    const code = (error as { code?: unknown }).code;
    outcome = { result: "failed", code: typeof code === "string" ? `pg_${code}` : "error" };
  }
  const durationMs = o.clock.now() - started;
  if (outcome.result === "queued") {
    o.log.log("job.run", {
      job: DUTY,
      trigger: outcome.trigger,
      result: "ok",
      checkId: outcome.checkId,
      durationMs,
    });
  } else if (outcome.result === "skipped") {
    o.log.log("job.run", {
      job: DUTY,
      trigger: "schedule",
      result: "skipped",
      skipReason: "no_work",
      durationMs,
    });
  } else {
    o.log.log(
      "job.run",
      { job: DUTY, trigger: "schedule", result: "failed", code: outcome.code, durationMs },
      "error",
    );
  }
  return outcome;
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
