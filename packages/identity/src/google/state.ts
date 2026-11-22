// A Google callback's OAuth state, as the realm reads it before the request's unit of work opens
// (spec 02 §5.8; ARCHITECTURE principle 14). The library keeps the state in a verification row
// (`auth-state:<state>`) and binds it to the browser with a signed `__Host-fin.state` cookie; it
// checks both itself, but only inside the request's unit, after Fin has made its outbound calls.
// So before any exchange Fin checks the same things the library will, and one thing it does not:
//
//   - the cookie carries this state and the realm's own signature (HMAC-SHA256 under the newest
//     secret, as the library signs and reads it), compared in constant time;
//   - the stored state exists and has not expired;
//   - the state is claimed for this request, under the row's lock, so one state buys at most one
//     code exchange however many callbacks arrive, together or one after another.
//
// The claim is a key Fin adds to the library's stored state (its schema keeps unknown keys); the
// library deletes the row when it parses the state, and the worker's sweep deletes expired ones.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Queryable } from "../ports/db.ts";

/** The key under which `/link-social` puts its step-up intent in the OAuth state. */
export const LINK_INTENT_KEY = "finStepUpIntent";

/** The key Fin adds to a stored state once a callback has claimed its code exchange. */
export const STATE_CLAIM_KEY = "finCodeExchange";

const INTENT_ID = /^sti_[0-9a-hjkmnp-tv-z]{26}$/;
/** A signature as the library writes it: base64 of an HMAC-SHA256, with its padding. */
const SIGNATURE = /^[A-Za-z0-9+/]{43}=$/;

/** The library's verification identifier for an OAuth state (pinned by the realm's tests). */
export function stateIdentifier(state: string): string {
  return `auth-state:${state}`;
}

/** The OAuth state the library keeps in a verification row (only the fields Fin reads). */
export interface StoredState {
  readonly codeVerifier: string;
  readonly idTokenNonce: string;
  /** Server context only (never the client's `additionalData`): the link's intent. */
  readonly linkIntentId: string | null;
  /** Where the library sends a refusal back to: an absolute URL Fin's redirect rule allowed. */
  readonly errorURL: string | null;
  /** Whether a callback has already claimed this state's code exchange. */
  readonly claimed: boolean;
}

/** A stored state Fin may act on, or null when it is unreadable or past its `expiresAt`. */
export function parseStoredState(value: string, nowMs: number): StoredState | null {
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof data.codeVerifier !== "string" || typeof data.idTokenNonce !== "string") return null;
  if (typeof data.expiresAt !== "number" || data.expiresAt <= nowMs) return null;
  const server = data.serverContext;
  const intent =
    typeof server === "object" && server !== null
      ? (server as Record<string, unknown>)[LINK_INTENT_KEY]
      : undefined;
  return {
    codeVerifier: data.codeVerifier,
    idTokenNonce: data.idTokenNonce,
    linkIntentId: typeof intent === "string" && INTENT_ID.test(intent) ? intent : null,
    errorURL: typeof data.errorURL === "string" ? data.errorURL : null,
    claimed: data[STATE_CLAIM_KEY] !== undefined,
  };
}

/**
 * The value of a cookie the library signed (`<value>.<signature>`, URL-encoded), when it carries
 * the realm's signature under `secret`; null when it is absent, malformed or signed otherwise.
 * The first cookie of the name counts, as in the library's own reader.
 */
export function verifiedCookieValue(
  cookieHeader: string | null,
  name: string,
  secret: string,
): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    let raw: string;
    try {
      raw = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
    const dot = raw.lastIndexOf(".");
    if (dot <= 0) return null;
    const value = raw.slice(0, dot);
    const signature = raw.slice(dot + 1);
    if (!SIGNATURE.test(signature)) return null;
    const expected = createHmac("sha256", secret).update(value, "utf8").digest();
    const given = Buffer.from(signature, "base64");
    return given.byteLength === expected.byteLength && timingSafeEqual(given, expected)
      ? value
      : null;
  }
  return null;
}

/** What the realm's short unit found for a callback's state. */
export type StateClaim =
  /** This request holds the state's one exchange. */
  | { readonly kind: "claimed"; readonly stored: StoredState }
  /** Another callback already claimed it: no exchange, and the library must not consume it. */
  | { readonly kind: "spent"; readonly stored: StoredState }
  /** No such state, or an expired or unreadable one: no exchange, and the library refuses it. */
  | { readonly kind: "none" }
  /** The network's exchange allowance is used up (§5.6): no exchange, and nothing claimed. */
  | { readonly kind: "limited"; readonly retryAfter: number };

/**
 * Claims a state's code exchange inside the caller's short unit: locks the state's row, reads it
 * and, when no callback has claimed it yet, marks it claimed for `requestId`. A second callback
 * waits on the lock and then reads the claim, so one state buys at most one exchange. `table` is
 * the realm's verification table.
 */
export async function claimState(
  tx: Queryable,
  state: string,
  now: Date,
  requestId: string,
  table: "identity.verification" | "staff.verification" = "identity.verification",
): Promise<Exclude<StateClaim, { kind: "limited" }>> {
  const found = await tx.query<{ id: string; value: string; expires_at: Date }>(
    `SELECT id, value, expires_at FROM ${table}
      WHERE identifier = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [stateIdentifier(state)],
  );
  const row = found.rows[0];
  if (row === undefined || row.expires_at.getTime() <= now.getTime()) return { kind: "none" };
  const stored = parseStoredState(row.value, now.getTime());
  if (stored === null) return { kind: "none" };
  if (stored.claimed) return { kind: "spent", stored };
  const data = JSON.parse(row.value) as Record<string, unknown>;
  data[STATE_CLAIM_KEY] = requestId;
  await tx.query(`UPDATE ${table} SET value = $2, updated_at = $3 WHERE id = $1`, [
    row.id,
    JSON.stringify(data),
    now,
  ]);
  return { kind: "claimed", stored };
}
