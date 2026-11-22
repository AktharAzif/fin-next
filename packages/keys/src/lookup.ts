// The edge's statements (spec 05 §2.1 steps 15, 16, 19 and 23; §3.7; §4.9). Step 15 is one statement:
// the key record from `keys.key_lookup`, the caller's refused-key window from `ops.rate_window` and
// the `live_keys` switch from `ops.kill_switch`, read together, with no positive cache. The windows
// are fixed 60-second windows by the database's clock and fail closed: a statement that fails is an
// error the edge answers 503 for (`rate-limiter-failing`), never a pass. A count answers the window's
// new count and the time left in it, in milliseconds rounded down, from which the seconds for
// `Retry-After` are rounded up: the edge's negative filter keeps a refused-key window Postgres
// answered full, and must never keep it past the window's end (apps/edge/src/shed.ts).
//
// Window keys never hold an address: the refused-key window is keyed by a keyed hash of the address
// (the caller passes it), the key window by the key ID, which is safe to store and log.
import type { KeyRecord } from "./verify.ts";

/** The narrow statement interface a pg Pool or client satisfies. */
export interface Queryable {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
}

/** The refused-key window (spec 05 §3.7): past it, a refused key gets 429 instead of 401. */
export const REFUSED_KEYS_LIMIT = 30;
/** The key window: 600 calls a minute per working key. */
export const KEY_WINDOW_LIMIT = 600;
export const WINDOW_SECONDS = 60;

export const LOOKUP_SQL = `SELECT k.id, k.organization_id, k.mode, k.kind, k.scopes, k.ip_allowlist::text[] AS ip_allowlist,
       k.hash, k.pepper_versions, k.expires_at, k.revoked_at, k.rolling_until, k.org_live_status,
       coalesce((SELECT w.count FROM ops.rate_window w
                  WHERE w.key = $2 AND w.window_start = date_trunc('minute', now())), 0) AS refused_count,
       coalesce((SELECT s.state = 'on' FROM ops.kill_switch s WHERE s.name = 'live_keys'), false)
         AS live_keys_on
  FROM (SELECT 1) AS one
  LEFT JOIN keys.key_lookup k ON k.id = $1`;

const COUNT_SQL = `INSERT INTO ops.rate_window (key, window_start, count)
VALUES ($1, date_trunc('minute', now()), 1)
ON CONFLICT (key, window_start) DO UPDATE SET count = ops.rate_window.count + 1
RETURNING count,
  floor(extract(epoch FROM date_trunc('minute', now()) + interval '1 minute' - now()) * 1000)::int
  AS ms_left`;

const TOUCH_SQL = "SELECT keys.touch_last_used($1) AS touched";

export interface Lookup {
  /** The key record, or null for a key ID with no row (or a deleted organisation's key). */
  record: KeyRecord | null;
  /** Refusals already counted for the caller's address in this window. */
  refusedCount: number;
  /** The `live_keys` switch is on: Production keys are stopped. */
  liveKeysOn: boolean;
}

export interface WindowCount {
  count: number;
  /** Seconds until the window ends (at least 1), for `Retry-After` and `RateLimit`'s `t`. */
  secondsLeft: number;
  /**
   * Milliseconds until the window ends when the statement ran, rounded down (0 to 60,000): added to
   * a time read before the statement was sent, it is never past the window's real end, whichever
   * clock the caller keeps (the edge's filter relies on it, apps/edge/src/shed.ts).
   */
  msLeft: number;
}

/** The refused-key window's key for an address's keyed hash. */
export function refusedWindowKey(addressHash: string): string {
  return `edge:refused_keys:${addressHash}`;
}

/** The key window's key. */
export function keyWindowKey(keyId: string): string {
  return `edge:key:${keyId}`;
}

type LookupRow = KeyRecord & { refused_count: unknown; live_keys_on: unknown };

/** A count as node-postgres reads it (an int, or a bigint as text), or null when it is not one. */
function countOf(value: unknown): number | null {
  const n = typeof value === "string" && /^[0-9]{1,15}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export interface KeyStore {
  lookup(keyId: string, refusedWindow: string): Promise<Lookup>;
  /** Counts one more in a window and answers the new count. */
  count(windowKey: string): Promise<WindowCount>;
  /** Writes "last used" (at most once a minute per key); true when it wrote. */
  touch(keyId: string): Promise<boolean>;
}

/**
 * The store over a pool: each method is one statement on a client taken and returned at once. A
 * switch or a window that does not read as one is an error the edge answers 503 for, never "off"
 * or "zero": the check never fails open (the key record itself is judged by verify.ts, where a
 * missing field reads as unknown).
 */
export function keyStore(db: Queryable): KeyStore {
  return {
    async lookup(keyId, refusedWindow) {
      const result = await db.query<LookupRow>(LOOKUP_SQL, [keyId, refusedWindow]);
      const row = result.rows[0];
      if (row === undefined) throw new Error("keys: the lookup answered no row");
      const { refused_count, live_keys_on, ...record } = row;
      const refusedCount = countOf(refused_count);
      if (typeof live_keys_on !== "boolean" || refusedCount === null) {
        throw new Error("keys: the lookup's switch or window did not read");
      }
      return {
        record: record.id === null ? null : record,
        refusedCount,
        liveKeysOn: live_keys_on,
      };
    },
    async count(windowKey) {
      const result = await db.query<{ count: unknown; ms_left: unknown }>(COUNT_SQL, [windowKey]);
      const row = result.rows[0];
      if (row === undefined) throw new Error("keys: the window answered no row");
      const count = countOf(row.count);
      const msLeft = countOf(row.ms_left);
      if (count === null || count < 1 || msLeft === null || msLeft > WINDOW_SECONDS * 1000) {
        throw new Error("keys: the window's count did not read");
      }
      return { count, secondsLeft: Math.max(1, Math.ceil(msLeft / 1000)), msLeft };
    },
    async touch(keyId) {
      const result = await db.query<{ touched: boolean }>(TOUCH_SQL, [keyId]);
      return result.rows[0]?.touched === true;
    },
  };
}
