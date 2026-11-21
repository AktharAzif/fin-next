// Limits in Postgres ([DA-16], spec 02 §5.6). Counting is one atomic statement on
// `ops.rate_window` (UNLOGGED, fixed windows); lockouts and pauses that must survive a restart
// live in the logged `ops.lockout`. The limiter fails closed: a store error refuses the request
// with 503 and writes `limits.store_failed`. Keys never carry an address or a token in clear:
// callers pass keyed hashes (crypto/keyed.ts).
import type { Clock } from "./ports/clock.ts";
import { DAY, HOUR, MINUTE, SECOND } from "./ports/clock.ts";
import type { Queryable } from "./ports/db.ts";
import type { LineSink } from "./ports/log.ts";

export interface LimitWindow {
  /** Window length in milliseconds. */
  readonly ms: number;
  readonly max: number;
}

/** The buckets of §5.6. Each lists every window it counts, keyed per its own subject. */
export const LIMITS = {
  default: [{ ms: 10 * SECOND, max: 100 }],
  code_send: [{ ms: 10 * MINUTE, max: 6 }],
  code_sign_in: [{ ms: 10 * MINUTE, max: 12 }],
  factor_code: [{ ms: 10 * MINUTE, max: 12 }],
  password_sign_in: [{ ms: 10 * MINUTE, max: 8 }],
  passkey_options: [{ ms: MINUTE, max: 30 }],
  method_add: [
    { ms: HOUR, max: 10 },
    { ms: DAY, max: 20 },
  ],
  backup_codes: [
    { ms: HOUR, max: 5 },
    { ms: DAY, max: 10 },
  ],
  sign_up_network: [{ ms: HOUR, max: 5 }],
  sign_up_address: [{ ms: DAY, max: 3 }],
  /** Code emails to one address, of one kind (§5.6, S2-38). */
  code_email: [
    { ms: HOUR, max: 5 },
    { ms: DAY, max: 12 },
  ],
  /** The share of `code_email` that browsers not known for the address may use. */
  code_email_unknown: [
    { ms: HOUR, max: 3 },
    { ms: DAY, max: 8 },
  ],
  staff_code_send: [{ ms: HOUR, max: 20 }],
  staff_code_email: [{ ms: HOUR, max: 5 }],
  staff_code_sign_in: [{ ms: 10 * MINUTE, max: 12 }],
  step_up_intents: [{ ms: 10 * MINUTE, max: 30 }],
} as const satisfies Record<string, readonly LimitWindow[]>;

export type LimitBucket =
  | "default"
  | "code_send"
  | "code_sign_in"
  | "factor_code"
  | "password_sign_in"
  | "passkey_options"
  | "method_add"
  | "backup_codes"
  | "staff_code_send"
  | "staff_code_sign_in";

export type CountedBucket = keyof typeof LIMITS;

export interface ConsumeResult {
  allowed: boolean;
  /** Seconds until the last refusing window ends (0 when allowed). */
  retryAfter: number;
  /** When the last refusing window ends (null when allowed): a pause lasts until then. */
  resetAt: Date | null;
}

export class LimitStoreError extends Error {
  readonly bucket: string;
  constructor(bucket: string, options?: { cause?: unknown }) {
    super(`the limit store failed for ${bucket}`, options);
    this.name = "LimitStoreError";
    this.bucket = bucket;
  }
}

export interface LimitStore {
  /** Counts one use of `bucket` for `subject` in every window; refuses past any maximum. */
  consume(db: Queryable, bucket: CountedBucket, subject: string): Promise<ConsumeResult>;
  /** The same over windows the caller names (the library's own limiter, through its storage). */
  consumeWindows(
    db: Queryable,
    name: string,
    windows: readonly LimitWindow[],
    subject: string,
  ): Promise<ConsumeResult>;
  /** Reads how many uses are left in the tightest window, without counting. */
  remaining(db: Queryable, bucket: CountedBucket, subject: string): Promise<number>;
  /** Records a lockout that survives a restart (`ops.lockout`). */
  lock(db: Queryable, key: string, kind: string, until: Date): Promise<void>;
  /** The time a live lockout ends, or null. */
  lockedUntil(db: Queryable, key: string): Promise<Date | null>;
  /**
   * Counts one failure toward a lockout kept in the logged table; at `threshold` failures the key
   * is locked for `lockMs`. A lapsed lockout starts counting again from one.
   */
  recordFailure(
    db: Queryable,
    key: string,
    kind: string,
    threshold: number,
    lockMs: number,
  ): Promise<{ count: number; lockedUntil: Date | null; justLocked: boolean }>;
  /** Forgets the failures of a key that is not locked (a right code resets the count). */
  clearFailures(db: Queryable, key: string): Promise<void>;
}

export function windowStart(at: Date, ms: number): Date {
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

export function createLimitStore(deps: { clock: Clock; lines: LineSink }): LimitStore {
  const fail = (bucket: string, error: unknown): never => {
    deps.lines.write("limits.store_failed", "error", { bucket });
    throw new LimitStoreError(bucket, { cause: error });
  };
  async function consumeWindows(
    db: Queryable,
    bucket: string,
    windows: readonly LimitWindow[],
    subject: string,
  ): Promise<ConsumeResult> {
    const now = deps.clock.now();
    let resetAt: Date | null = null;
    for (const window of windows) {
      const start = windowStart(now, window.ms);
      let count: number;
      try {
        const result = await db.query<{ count: number }>(
          `INSERT INTO ops.rate_window (key, window_start, count) VALUES ($1, $2, 1)
           ON CONFLICT (key, window_start) DO UPDATE SET count = ops.rate_window.count + 1
           RETURNING count`,
          [`${bucket}:${window.ms}:${subject}`, start],
        );
        count = Number(result.rows[0]?.count ?? Number.POSITIVE_INFINITY);
      } catch (error) {
        return fail(bucket, error);
      }
      if (count > window.max) {
        const ends = new Date(start.getTime() + window.ms);
        if (resetAt === null || ends.getTime() > resetAt.getTime()) resetAt = ends;
      }
    }
    if (resetAt === null) return { allowed: true, retryAfter: 0, resetAt: null };
    deps.lines.write("limits.refused", "info", { bucket });
    const retryAfter = Math.ceil((resetAt.getTime() - now.getTime()) / 1000);
    return { allowed: false, retryAfter, resetAt };
  }
  return {
    consume: (db, bucket, subject) => consumeWindows(db, bucket, LIMITS[bucket], subject),
    consumeWindows,
    async remaining(db, bucket, subject) {
      const now = deps.clock.now();
      let left = Number.POSITIVE_INFINITY;
      for (const window of LIMITS[bucket]) {
        try {
          const result = await db.query<{ count: number }>(
            "SELECT count FROM ops.rate_window WHERE key = $1 AND window_start = $2",
            [`${bucket}:${window.ms}:${subject}`, windowStart(now, window.ms)],
          );
          left = Math.min(left, window.max - Number(result.rows[0]?.count ?? 0));
        } catch (error) {
          return fail(bucket, error);
        }
      }
      return Math.max(0, left);
    },
    async lock(db, key, kind, until) {
      try {
        await db.query(
          `INSERT INTO ops.lockout (key, kind, count, locked_until, updated_at)
           VALUES ($1, $2, 1, $3, $4)
           ON CONFLICT (key) DO UPDATE
             SET count = ops.lockout.count + 1,
                 locked_until = GREATEST(ops.lockout.locked_until, EXCLUDED.locked_until),
                 kind = EXCLUDED.kind, updated_at = EXCLUDED.updated_at`,
          [key, kind, until, deps.clock.now()],
        );
      } catch (error) {
        fail(kind, error);
      }
    },
    async lockedUntil(db, key) {
      try {
        const result = await db.query<{ locked_until: Date | null }>(
          "SELECT locked_until FROM ops.lockout WHERE key = $1",
          [key],
        );
        const until = result.rows[0]?.locked_until ?? null;
        return until !== null && until.getTime() > deps.clock.now().getTime() ? until : null;
      } catch (error) {
        return fail("lockout", error);
      }
    },
    async recordFailure(db, key, kind, threshold, lockMs) {
      const now = deps.clock.now();
      try {
        const result = await db.query<{ count: number; locked_until: Date | null }>(
          `INSERT INTO ops.lockout (key, kind, count, locked_until, updated_at) VALUES ($1, $2, 1, NULL, $3)
           ON CONFLICT (key) DO UPDATE SET
             count = CASE WHEN ops.lockout.locked_until IS NOT NULL AND ops.lockout.locked_until <= $3
                          THEN 1 ELSE ops.lockout.count + 1 END,
             locked_until = CASE WHEN ops.lockout.locked_until IS NOT NULL AND ops.lockout.locked_until <= $3
                                 THEN NULL ELSE ops.lockout.locked_until END,
             kind = EXCLUDED.kind, updated_at = $3
           RETURNING count, locked_until`,
          [key, kind, now],
        );
        const row = result.rows[0];
        const count = Number(row?.count ?? threshold);
        const current = row?.locked_until ?? null;
        if (current === null && count >= threshold) {
          const until = new Date(now.getTime() + lockMs);
          await db.query("UPDATE ops.lockout SET locked_until = $2 WHERE key = $1", [key, until]);
          return { count, lockedUntil: until, justLocked: true };
        }
        return { count, lockedUntil: current, justLocked: false };
      } catch (error) {
        return fail(kind, error);
      }
    },
    async clearFailures(db, key) {
      try {
        await db.query(
          "UPDATE ops.lockout SET count = 0, updated_at = $2 WHERE key = $1 AND locked_until IS NULL",
          [key, deps.clock.now()],
        );
      } catch (error) {
        fail("lockout", error);
      }
    },
  };
}
