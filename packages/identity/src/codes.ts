// Emailed codes in the developer realm (spec 02 §5.2, [SA-35], S2-38, S2-39): one live code per
// address and purpose; a browser that is not known for the address never supersedes a code a
// known browser asked for, and may use only part of the per-recipient allowance; each code has 3
// tries in the browser that asked and one shared allowance of 3 elsewhere, and a right code from
// elsewhere signs in only an account that already exists. Every outcome answers the same way.

import { isKnownBrowserForEmail } from "./browsers.ts";
import type { KeyedHasher } from "./crypto/keyed.ts";
import { constantTimeEqual } from "./crypto/keyed.ts";
import type { LimitStore } from "./limits.ts";
import type { Clock } from "./ports/clock.ts";
import { MINUTE } from "./ports/clock.ts";
import type { Queryable } from "./ports/db.ts";
import { newId } from "./ports/ids.ts";
import type { LineSink } from "./ports/log.ts";

export const CODE_LIFETIME_MS = 15 * MINUTE;
export const TRIES_PER_CLASS = 3;

export interface LiveCodeRequest {
  id: string;
  browserHash: Buffer;
  browserKnown: boolean;
  browserTries: number;
  otherTries: number;
}

export async function liveCodeRequest(
  db: Queryable,
  hasher: KeyedHasher,
  email: string,
  now: Date,
  options: { lock?: boolean } = {},
): Promise<LiveCodeRequest | null> {
  const result = await db.query<{
    id: string;
    browser_hash: Buffer;
    browser_known: boolean;
    browser_tries: number;
    other_tries: number;
  }>(
    `SELECT id, browser_hash, browser_known, browser_tries, other_tries
       FROM identity.email_code_request
      WHERE email_hash = ANY($1) AND purpose = 'sign_in' AND superseded_at IS NULL
        AND used_at IS NULL AND expires_at > $2
      ORDER BY created_at DESC LIMIT 1${options.lock === true ? " FOR UPDATE" : ""}`,
    [hasher.hashes("email", email.toLowerCase()), now],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    browserHash: row.browser_hash,
    browserKnown: row.browser_known,
    browserTries: Number(row.browser_tries),
    otherTries: Number(row.other_tries),
  };
}

function sameBrowser(hasher: KeyedHasher, live: LiveCodeRequest, token: string | null): boolean {
  if (token === null) return false;
  return hasher.hashes("browser", token).some((h) => constantTimeEqual(h, live.browserHash));
}

export type CodeRequestOutcome =
  | { send: true; requestId: string }
  | { send: false; reason: "supersede_refused" | "unknown_share_used" | "allowance_used" }
  | { send: false; reason: "rate_limited"; retryAfter: number };

export interface CodeRequestDeps {
  clock: Clock;
  hasher: KeyedHasher;
  limits: LimitStore;
  lines: LineSink;
}

/** The per-address `code_send` subject: browsers known for the address count apart (S2-38). */
export function codeSendSubject(hasher: KeyedHasher, email: string, known: boolean): string {
  return `${hasher.bucket("email", email.toLowerCase())}:${known ? "known" : "other"}`;
}

/**
 * Decides whether a code may be sent for `email` to the browser holding `browserToken`, and
 * records the request. The caller answers the same way whatever this returns, but for
 * `rate_limited` (the address's request limit, §5.6), which is its 429.
 *
 * A browser is known for the address when its `known_browser` cookie names a known browser of the
 * account; a browser asking again for the live code it asked for keeps that request's standing, so
 * a stranger who asks twice is still a stranger: it never draws on what S2-38 keeps for known
 * browsers (the allowance past the strangers' share, the address's own request limit) and never
 * makes its code one an unknown browser of the owner cannot supersede.
 */
export async function requestCode(
  db: Queryable,
  deps: CodeRequestDeps,
  input: {
    email: string;
    browserToken: string;
    knownBrowserToken: string | null;
    userId: string | null;
    /** Count the address's `code_send` here (false when signUp() already counted it). */
    countRequest: boolean;
  },
): Promise<CodeRequestOutcome> {
  const now = deps.clock.now();
  const email = input.email.toLowerCase();
  const subject = deps.hasher.bucket("email", email);
  const live = await liveCodeRequest(db, deps.hasher, email, now, { lock: true });
  const askedBefore = live !== null && sameBrowser(deps.hasher, live, input.browserToken);
  const known =
    (askedBefore && live.browserKnown) ||
    (await isKnownBrowserForEmail(db, deps.hasher, email, input.knownBrowserToken));

  if (input.countRequest) {
    const requests = await deps.limits.consume(
      db,
      "code_send",
      codeSendSubject(deps.hasher, email, known),
    );
    if (!requests.allowed) {
      return { send: false, reason: "rate_limited", retryAfter: requests.retryAfter };
    }
  }

  const contest = (reason: "supersede_refused" | "unknown_share_used"): CodeRequestOutcome => {
    deps.lines.write("auth.code_contested", "warn", {
      reason,
      ...(input.userId === null ? {} : { userId: input.userId }),
    });
    return { send: false, reason };
  };

  // A stranger never cancels a code the owner's browser asked for (S2-38).
  if (live?.browserKnown === true && !known) return contest("supersede_refused");

  // A pause recorded in the logged table outlives a restart that empties the counters.
  const lockKey = `code_email:${subject}`;
  if ((await deps.limits.lockedUntil(db, lockKey)) !== null) {
    return { send: false, reason: "allowance_used" };
  }
  if (!known) {
    const share = await deps.limits.consume(db, "code_email_unknown", subject);
    if (!share.allowed) return contest("unknown_share_used");
  }
  const allowance = await deps.limits.consume(db, "code_email", subject);
  if (!allowance.allowed) {
    // Paused until the window that refused ends: the hour's, or the day's once its 12 are used.
    const until = allowance.resetAt ?? new Date(now.getTime() + allowance.retryAfter * 1000);
    await deps.limits.lock(db, lockKey, "code_email", until);
    return { send: false, reason: "allowance_used" };
  }

  if (live !== null) {
    await db.query("UPDATE identity.email_code_request SET superseded_at = $2 WHERE id = $1", [
      live.id,
      now,
    ]);
  }
  const id = newId("emr", deps.clock);
  await db.query(
    `INSERT INTO identity.email_code_request
       (id, email_hash, purpose, browser_hash, browser_known, created_at, expires_at)
     VALUES ($1, $2, 'sign_in', $3, $4, $5, $6)`,
    [
      id,
      deps.hasher.hash("email", email),
      deps.hasher.hash("browser", input.browserToken),
      known,
      now,
      new Date(now.getTime() + CODE_LIFETIME_MS),
    ],
  );
  return { send: true, requestId: id };
}

export type CodeAttempt =
  | { allowed: true; requestId: string | null; askingBrowser: boolean }
  | { allowed: false; reason: "too_many_tries" | "other_browser_no_account" };

/**
 * Counts one try against the live code before the library checks it (§5.2): the asking browser
 * has its own 3 tries; every other browser shares 3. A right code from another browser never
 * creates an account, so such a try fails as a wrong code would.
 */
export async function attemptCode(
  db: Queryable,
  deps: { clock: Clock; hasher: KeyedHasher },
  input: { email: string; browserToken: string | null; accountExists: boolean },
): Promise<CodeAttempt> {
  const now = deps.clock.now();
  const live = await liveCodeRequest(db, deps.hasher, input.email, now, { lock: true });
  if (live === null) return { allowed: true, requestId: null, askingBrowser: false };
  const asking = sameBrowser(deps.hasher, live, input.browserToken);
  if (asking) {
    if (live.browserTries >= TRIES_PER_CLASS) return { allowed: false, reason: "too_many_tries" };
    await db.query(
      "UPDATE identity.email_code_request SET browser_tries = browser_tries + 1 WHERE id = $1",
      [live.id],
    );
    return { allowed: true, requestId: live.id, askingBrowser: true };
  }
  if (live.otherTries >= TRIES_PER_CLASS) return { allowed: false, reason: "too_many_tries" };
  await db.query(
    "UPDATE identity.email_code_request SET other_tries = other_tries + 1 WHERE id = $1",
    [live.id],
  );
  if (!input.accountExists) return { allowed: false, reason: "other_browser_no_account" };
  return { allowed: true, requestId: live.id, askingBrowser: false };
}

export async function markCodeUsed(db: Queryable, requestId: string, now: Date): Promise<void> {
  await db.query("UPDATE identity.email_code_request SET used_at = $2 WHERE id = $1", [
    requestId,
    now,
  ]);
}

/**
 * The sign-in link check (POST /api/sign-in/code-link, §5.2): whether this browser asked the
 * live code for this address. It says nothing about any other browser, address or account.
 */
export async function codeLinkAsking(
  db: Queryable,
  deps: { clock: Clock; hasher: KeyedHasher },
  email: string,
  browserToken: string | null,
): Promise<boolean> {
  const live = await liveCodeRequest(db, deps.hasher, email, deps.clock.now());
  return live !== null && sameBrowser(deps.hasher, live, browserToken);
}
