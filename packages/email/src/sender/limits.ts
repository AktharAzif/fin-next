// The sender's numbers (ARCHITECTURE §9.4, §9.5; spec 08 §4.3). Every limit that must agree across
// replicas or survive a restart is counted in Postgres; these are only the thresholds.
import type { BucketSettings } from "../outbox/store.ts";

export interface SenderLimits {
  /** Messages in flight at once in one loop run. */
  readonly concurrency: number;
  /** Of `concurrency`, the share ordinary mail may never use: kept for codes and security notices. */
  readonly reservedUrgent: number;
  readonly leaseMs: number;
  /** Security notices to one recipient per hour before they fold into a digest ([SA-41]). */
  readonly securityPerHour: number;
  /** The backstop for every other class, per recipient per hour (the asking endpoints limit first). */
  readonly otherPerHour: number;
  /** A digest goes at the end of the hour, or this long after its first fold, whichever is sooner. */
  readonly digestDelayMs: number;
  /**
   * Cloudflare blocks a token for 5 minutes after 1,200 calls in 5 minutes. capacity + 300 × rate
   * must stay below 1,200: 150 + 300 × 3 = 1,050.
   */
  readonly bucket: BucketSettings;
  /** Tokens ordinary mail must leave in the bucket for codes and security notices. */
  readonly bucketReserve: number;
  /** The environment's daily send budget, and the share only codes, security and ops may use. */
  readonly dailyBudget: number;
  readonly dailySecurityReserve: number;
  /** Per organisation per day, for rows whose params name an organisation ([SA-40]). */
  readonly dailyPerOrganisation: number;
  /** Retry backoff: base × 2^(attempt-1), capped; half of it fixed and half jittered. */
  readonly retryBaseMs: number;
  readonly retryCapMs: number;
  /** Wait after a token, entitlement or account refusal (they page; the row keeps waiting). */
  readonly blockedWaitMs: number;
  /** Ordinary rows end after this many attempts; security rows never end on a retryable failure. */
  readonly maxAttempts: number;
  /** After this many failed attempts a security row writes `email.security_unsent` (once). */
  readonly securityUnsentAfter: number;
  /** How long a security or ops row waits when the daily budget is used up. */
  readonly budgetWaitMs: number;
}

export const DEFAULT_LIMITS: SenderLimits = Object.freeze({
  concurrency: 4,
  reservedUrgent: 1,
  leaseMs: 60_000,
  securityPerHour: 5,
  otherPerHour: 20,
  digestDelayMs: 10 * 60_000,
  bucket: Object.freeze({ name: "cloudflare", capacity: 150, ratePerSecond: 3 }),
  bucketReserve: 50,
  dailyBudget: 2_000,
  dailySecurityReserve: 500,
  dailyPerOrganisation: 300,
  retryBaseMs: 30_000,
  retryCapMs: 30 * 60_000,
  blockedWaitMs: 5 * 60_000,
  maxAttempts: 10,
  securityUnsentAfter: 5,
  budgetWaitMs: 15 * 60_000,
});

/** Exponential backoff with jitter for a row's `attempt`th failure. */
export function backoffMs(limits: SenderLimits, attempt: number, random: () => number): number {
  const ceiling = Math.min(limits.retryCapMs, limits.retryBaseMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(1_000, Math.round(ceiling / 2 + (random() * ceiling) / 2));
}
