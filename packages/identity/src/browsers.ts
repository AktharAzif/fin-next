// Known and trusted browsers (spec 02 §5.5, §6.6, [SA-31], S2-40). Both are a random cookie whose
// keyed hash names a row; neither ever holds the token itself.

import type { KeyedHasher } from "./crypto/keyed.ts";
import type { Clock } from "./ports/clock.ts";
import { DAY } from "./ports/clock.ts";
import type { Queryable } from "./ports/db.ts";
import { newId } from "./ports/ids.ts";

export const TRUSTED_BROWSER_LIFETIME_MS = 30 * DAY;

export type TrustRevokedReason =
  | "factor_changed"
  | "password_reset"
  | "signed_out_everywhere"
  | "role_elevated"
  | "production_access"
  | "by_person"
  | "removed";

/** The live known-browser row of this person that the cookie names, if any. */
export async function knownBrowserOf(
  db: Queryable,
  hasher: KeyedHasher,
  userId: string,
  token: string | null,
): Promise<string | null> {
  if (token === null) return null;
  const result = await db.query<{ id: string }>(
    "SELECT id FROM identity.known_browser WHERE token_hash = ANY($1) AND user_id = $2",
    [hasher.hashes("known_browser", token), userId],
  );
  return result.rows[0]?.id ?? null;
}

/** Whether the cookie names a known browser of the account with this address (§5.2). */
export async function isKnownBrowserForEmail(
  db: Queryable,
  hasher: KeyedHasher,
  email: string,
  token: string | null,
): Promise<boolean> {
  if (token === null) return false;
  const result = await db.query<{ known: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM identity.known_browser kb JOIN identity."user" u ON u.id = kb.user_id
        WHERE kb.token_hash = ANY($1) AND u.email = $2) AS known`,
    [hasher.hashes("known_browser", token), email.toLowerCase()],
  );
  return result.rows[0]?.known === true;
}

/** Moves `last_seen_at` of a known row, or makes one; returns the token to set when new. */
export async function touchKnownBrowser(
  db: Queryable,
  deps: { clock: Clock; hasher: KeyedHasher },
  userId: string,
  token: string | null,
  label: string,
  newToken: () => string,
): Promise<{ known: boolean; setToken: string | null }> {
  const now = deps.clock.now();
  const existing = await knownBrowserOf(db, deps.hasher, userId, token);
  if (existing !== null) {
    await db.query("UPDATE identity.known_browser SET last_seen_at = $2 WHERE id = $1", [
      existing,
      now,
    ]);
    return { known: true, setToken: null };
  }
  const fresh = newToken();
  await db.query(
    `INSERT INTO identity.known_browser (id, user_id, token_hash, label, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [newId("brw", deps.clock), userId, deps.hasher.hash("known_browser", fresh), label, now],
  );
  return { known: false, setToken: fresh };
}

/** "Sign out everywhere else" forgets every known browser but the current one (§5.5). */
export async function forgetKnownBrowsersExcept(
  db: Queryable,
  hasher: KeyedHasher,
  userId: string,
  keepToken: string | null,
): Promise<number> {
  const keep = keepToken === null ? [] : hasher.hashes("known_browser", keepToken);
  const result = await db.query(
    "DELETE FROM identity.known_browser WHERE user_id = $1 AND NOT (token_hash = ANY($2))",
    [userId, keep],
  );
  return result.rowCount;
}

export interface TrustedBrowserRow {
  id: string;
  userId: string;
}

/** The live, unrevoked trusted-browser row of this person that the cookie names, if any. */
export async function trustedBrowserOf(
  db: Queryable,
  hasher: KeyedHasher,
  userId: string,
  token: string | null,
  now: Date,
): Promise<TrustedBrowserRow | null> {
  if (token === null) return null;
  const result = await db.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM identity.trusted_browser
      WHERE token_hash = ANY($1) AND user_id = $2 AND revoked_at IS NULL AND expires_at > $3`,
    [hasher.hashes("trusted_browser", token), userId, now],
  );
  const row = result.rows[0];
  return row === undefined ? null : { id: row.id, userId: row.user_id };
}

export async function createTrustedBrowser(
  db: Queryable,
  deps: { clock: Clock; hasher: KeyedHasher },
  userId: string,
  token: string,
  label: string,
): Promise<string> {
  const now = deps.clock.now();
  const id = newId("tbr", deps.clock);
  await db.query(
    `INSERT INTO identity.trusted_browser (id, user_id, token_hash, label, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      userId,
      deps.hasher.hash("trusted_browser", token),
      label,
      now,
      new Date(now.getTime() + TRUSTED_BROWSER_LIFETIME_MS),
    ],
  );
  return id;
}

export async function markTrustedBrowserUsed(db: Queryable, id: string, now: Date): Promise<void> {
  await db.query("UPDATE identity.trusted_browser SET last_used_at = $2 WHERE id = $1", [id, now]);
}

/**
 * Revokes a person's live trusted browsers with a reason: all of them, only one (`only`), or all
 * but some (`except`, "sign out everywhere else" keeping this browser's, §11.4). Returns the
 * revoked IDs; the caller records one `browser.trust_revoked` per ID in the same transaction
 * (§6.6).
 */
export async function revokeTrustedBrowsers(
  db: Queryable,
  userId: string,
  reason: TrustRevokedReason,
  now: Date,
  scope: { only?: string; except?: readonly string[] } = {},
): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `UPDATE identity.trusted_browser SET revoked_at = $3, revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL AND ($4::text IS NULL OR id = $4)
        AND NOT (id = ANY($5::text[]))
      RETURNING id`,
    [userId, reason, now, scope.only ?? null, [...(scope.except ?? [])]],
  );
  return result.rows.map((r) => r.id);
}

/**
 * The trusted-browser rows that are this browser's (§11.4): the one the session was made from
 * (or inherited on replacement), and the live one the browser's own cookie names.
 */
export async function thisBrowsersTrust(
  db: Queryable,
  hasher: KeyedHasher,
  userId: string,
  sessionId: string,
  token: string | null,
  now: Date,
): Promise<string[]> {
  const session = await db.query<{ trusted_browser_id: string | null }>(
    "SELECT trusted_browser_id FROM identity.session WHERE id = $1 AND user_id = $2",
    [sessionId, userId],
  );
  const fromSession = session.rows[0]?.trusted_browser_id ?? null;
  const fromCookie = (await trustedBrowserOf(db, hasher, userId, token, now))?.id ?? null;
  return [...new Set([fromSession, fromCookie].filter((id): id is string => id !== null))];
}
