// Emailed codes in the developer realm (spec 02 §5.2, [SA-35], S2-38, S2-39): one live code per
// address and purpose; a browser that is not known for the address never supersedes a code a
// known browser asked for, and may use only part of the per-recipient allowance; each code has 3
// tries in the browser that asked and one shared allowance of 3 elsewhere, and a right code from
// elsewhere signs in only an account that already exists. Every outcome answers the same way.
//
// A request can also be codeless. Sign-up gives an unknown address a code bound to the browser
// that asked; for an address that already has an account it sends `already-registered` and no
// code (§5.1), and records a codeless request bound to that browser in the code's place, so that
// what the browser sees next (its tries, the code-link check, the allowance left) is the same for
// both (T-SAT-32). No code is right for a codeless request, and it never supersedes a code that a
// known browser of the account asked for. A browser known for the account records none: it
// already knows the account exists, so there is nothing to keep alike, and its sign-up leaves the
// live code and its tries alone.
//
// Every request, codeless request and try for one address takes the address's lock before it reads
// the live requests, so they run one after another and "one live code" holds when they overlap.
// The lock is a row only the console's role may lock (see lockAddress()).

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
  /** Recorded in place of a code (a registered address's sign-up): no code is right for it. */
  codeless: boolean;
}

/**
 * Holds the address's lock until the unit ends: every request, codeless request and try for the
 * address takes it before it reads the live requests, so two that overlap run one after the other
 * and the second sees what the first recorded. Without it, two code requests for one address could
 * each find no live code and both record one.
 *
 * The lock is a row lock (`FOR UPDATE`) on the address's slot in `identity.email_code_lock`, held
 * until commit. The table is a fixed set of `ADDRESS_LOCK_SLOTS` rows its migration makes, and a
 * slot is the first two bytes of the address's keyed hash, so taking a lock writes nothing about
 * the address and the table never grows, whatever addresses callers send. Two addresses that share
 * a slot only wait on each other for the length of a unit. Only fin_console may lock that table,
 * and no function another login may run touches it (identity.sweep() never does: its slots need
 * no sweep, and a delete is a lock held to the end of the sweeper's transaction), so no other
 * login can take the lock and hold it open to stall the address's sign-ins, nor watch it. Never an
 * advisory lock: any login may take one, and its key shows in pg_locks. A missing slot fails the
 * unit rather than going unlocked.
 *
 * Every path takes its locks in one order, so that two units never wait on each other in a circle:
 * sign-up's own limits first (`sign_up_network`, then `sign_up_address`, which only sign-up takes);
 * then the network's code limit (`code_send`, or `code_sign_in` for a try); then this lock; then
 * the address's code limits (`code_send` for the address, the strangers' share and the allowance of
 * code emails, and their pause) and its requests. Nothing per address comes before this lock but
 * `sign_up_address`, which no unit takes after it, and no unit takes two addresses' locks, so a
 * shared slot adds no circle either.
 */
export async function lockAddress(
  db: Queryable,
  deps: { hasher: KeyedHasher },
  email: string,
): Promise<void> {
  const locked = await db.query(
    "SELECT slot FROM identity.email_code_lock WHERE slot = $1 FOR UPDATE",
    [addressLockSlot(deps.hasher, email)],
  );
  if (locked.rowCount !== 1) throw new Error("identity.email_code_lock is missing an address slot");
}

/** The number of slots in `identity.email_code_lock` (its migration makes exactly these). */
export const ADDRESS_LOCK_SLOTS = 65_536;

/** The address's slot: the first two bytes of its keyed hash under the newest key. */
export function addressLockSlot(hasher: KeyedHasher, email: string): number {
  return hasher.hash("email", email.toLowerCase()).readUInt16BE(0);
}

/**
 * The address's live requests, newest first: at most one with a code (the one whose code the
 * library holds) and at most one codeless one, given every caller that writes them holds
 * lockAddress(). `lock` holds the rows until the unit ends.
 */
async function liveRequests(
  db: Queryable,
  hasher: KeyedHasher,
  email: string,
  now: Date,
  options: { lock?: boolean } = {},
): Promise<LiveCodeRequest[]> {
  const result = await db.query<{
    id: string;
    browser_hash: Buffer;
    browser_known: boolean;
    browser_tries: number;
    other_tries: number;
    codeless: boolean;
  }>(
    `SELECT id, browser_hash, browser_known, browser_tries, other_tries, codeless
       FROM identity.email_code_request
      WHERE email_hash = ANY($1) AND purpose = 'sign_in' AND superseded_at IS NULL
        AND used_at IS NULL AND expires_at > $2
      ORDER BY created_at DESC, id DESC${options.lock === true ? " FOR UPDATE" : ""}`,
    [hasher.hashes("email", email.toLowerCase()), now],
  );
  return result.rows.map((row) => ({
    id: row.id,
    browserHash: row.browser_hash,
    browserKnown: row.browser_known,
    browserTries: Number(row.browser_tries),
    otherTries: Number(row.other_tries),
    codeless: row.codeless,
  }));
}

/** The live request with a code, if any. */
export async function liveCodeRequest(
  db: Queryable,
  hasher: KeyedHasher,
  email: string,
  now: Date,
  options: { lock?: boolean } = {},
): Promise<LiveCodeRequest | null> {
  return (await liveRequests(db, hasher, email, now, options)).find((r) => !r.codeless) ?? null;
}

function sameBrowser(hasher: KeyedHasher, live: LiveCodeRequest, token: string | null): boolean {
  if (token === null) return false;
  return hasher.hashes("browser", token).some((h) => constantTimeEqual(h, live.browserHash));
}

export type CodeRequestOutcome =
  | { send: true; requestId: string }
  | { send: false; reason: "supersede_refused" | "unknown_share_used" | "allowance_used" }
  | { send: false; reason: "rate_limited"; retryAfter: number };

export type CodelessOutcome =
  | { recorded: true; requestId: string }
  | { recorded: false; reason: "unknown_share_used" | "allowance_used" | "known_browser" };

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
 * Whether the asking browser is known for the address: its `known_browser` cookie names a known
 * browser of the account, or it asked the live code itself as a known browser. Asking again keeps
 * a request's standing, so a stranger who asks twice is still a stranger.
 */
async function askerKnown(
  db: Queryable,
  hasher: KeyedHasher,
  email: string,
  code: LiveCodeRequest | null,
  input: { browserToken: string; knownBrowserToken: string | null },
): Promise<boolean> {
  const askedBefore = code !== null && sameBrowser(hasher, code, input.browserToken);
  return (
    (askedBefore && code.browserKnown) ||
    (await isKnownBrowserForEmail(db, hasher, email, input.knownBrowserToken))
  );
}

/** The `auth.code_contested` line (§18.2's `sign-in-code-contested` watches it). */
function noteContest(
  deps: CodeRequestDeps,
  reason: "supersede_refused" | "unknown_share_used",
  userId: string | null,
): void {
  deps.lines.write("auth.code_contested", "warn", {
    reason,
    ...(userId === null ? {} : { userId }),
  });
}

/**
 * Uses one of the address's code emails (§5.6, S2-38): the strangers' share first for a browser
 * that is not known, then the allowance, pausing the address until the window that refused ends.
 * Returns the refusal, or null when the request may go ahead.
 */
async function spendCodeEmail(
  db: Queryable,
  deps: CodeRequestDeps,
  input: { subject: string; known: boolean; userId: string | null; now: Date },
): Promise<{ send: false; reason: "unknown_share_used" | "allowance_used" } | null> {
  // A pause recorded in the logged table outlives a restart that empties the counters.
  const lockKey = `code_email:${input.subject}`;
  if ((await deps.limits.lockedUntil(db, lockKey)) !== null) {
    return { send: false, reason: "allowance_used" };
  }
  if (!input.known) {
    const share = await deps.limits.consume(db, "code_email_unknown", input.subject);
    if (!share.allowed) {
      noteContest(deps, "unknown_share_used", input.userId);
      return { send: false, reason: "unknown_share_used" };
    }
  }
  const allowance = await deps.limits.consume(db, "code_email", input.subject);
  if (!allowance.allowed) {
    // Paused until the window that refused ends: the hour's, or the day's once its 12 are used.
    const until = allowance.resetAt ?? new Date(input.now.getTime() + allowance.retryAfter * 1000);
    await deps.limits.lock(db, lockKey, "code_email", until);
    return { send: false, reason: "allowance_used" };
  }
  return null;
}

async function supersede(db: Queryable, ids: readonly string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    "UPDATE identity.email_code_request SET superseded_at = $2 WHERE id = ANY($1::text[])",
    [[...ids], now],
  );
}

async function insertRequest(
  db: Queryable,
  deps: CodeRequestDeps,
  input: { email: string; browserToken: string; known: boolean; codeless: boolean; now: Date },
): Promise<string> {
  const id = newId("emr", deps.clock);
  await db.query(
    `INSERT INTO identity.email_code_request
       (id, email_hash, purpose, browser_hash, browser_known, codeless, created_at, expires_at)
     VALUES ($1, $2, 'sign_in', $3, $4, $5, $6, $7)`,
    [
      id,
      deps.hasher.hash("email", input.email),
      deps.hasher.hash("browser", input.browserToken),
      input.known,
      input.codeless,
      input.now,
      new Date(input.now.getTime() + CODE_LIFETIME_MS),
    ],
  );
  return id;
}

/**
 * Decides whether a code may be sent for `email` to the browser holding `browserToken`, and
 * records the request. The caller answers the same way whatever this returns, but for
 * `rate_limited` (the address's request limit, §5.6), which is its 429.
 *
 * A browser that is not known never draws on what S2-38 keeps for known browsers (the allowance
 * past the strangers' share, the address's own request limit) and never supersedes a code a
 * known browser asked for. A new code replaces the live one and any codeless request.
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
  const email = input.email.toLowerCase();
  await lockAddress(db, deps, email);
  const now = deps.clock.now();
  const subject = deps.hasher.bucket("email", email);
  const live = await liveRequests(db, deps.hasher, email, now, { lock: true });
  const code = live.find((r) => !r.codeless) ?? null;
  const known = await askerKnown(db, deps.hasher, email, code, input);

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

  // A stranger never cancels a code the owner's browser asked for (S2-38).
  if (code?.browserKnown === true && !known) {
    noteContest(deps, "supersede_refused", input.userId);
    return { send: false, reason: "supersede_refused" };
  }
  const refused = await spendCodeEmail(db, deps, { subject, known, userId: input.userId, now });
  if (refused !== null) return refused;

  await supersede(
    db,
    live.map((r) => r.id),
    now,
  );
  const id = await insertRequest(db, deps, {
    email,
    browserToken: input.browserToken,
    known,
    codeless: false,
    now,
  });
  return { send: true, requestId: id };
}

/**
 * Records a codeless request for `email`, bound to the browser holding `browserToken`: what a code
 * request from that browser would record, counted against the same share and allowance, but with
 * no code (signUp()'s registered branch, §5.1). It replaces what that request would replace, and
 * where that request would be refused for a known browser's live code (S2-38), it leaves the code
 * alone and is recorded beside it, so the asking browser holds a request either way.
 *
 * A browser known for the account records nothing and touches nothing: it already knows the
 * account exists, an unknown address never has a known browser, so there is nothing to keep alike,
 * and the live code (its own or another known browser's) keeps its tries.
 */
export async function requestCodeless(
  db: Queryable,
  deps: CodeRequestDeps,
  input: {
    email: string;
    browserToken: string;
    knownBrowserToken: string | null;
    userId: string | null;
  },
): Promise<CodelessOutcome> {
  const email = input.email.toLowerCase();
  await lockAddress(db, deps, email);
  const now = deps.clock.now();
  const subject = deps.hasher.bucket("email", email);
  const live = await liveRequests(db, deps.hasher, email, now, { lock: true });
  const code = live.find((r) => !r.codeless) ?? null;
  const known = await askerKnown(db, deps.hasher, email, code, input);
  if (known) return { recorded: false, reason: "known_browser" };
  const refused = await spendCodeEmail(db, deps, { subject, known, userId: input.userId, now });
  if (refused !== null) return { recorded: false, reason: refused.reason };

  // Where a code request from this browser would be refused (S2-38), the live code stays, and the
  // request is watched the same way; anything else it replaces as that request would.
  const keepsCode = code?.browserKnown === true;
  if (keepsCode) noteContest(deps, "supersede_refused", input.userId);
  await supersede(
    db,
    live.filter((r) => r.codeless || !keepsCode).map((r) => r.id),
    now,
  );
  const id = await insertRequest(db, deps, {
    email,
    browserToken: input.browserToken,
    known: false,
    codeless: true,
    now,
  });
  return { recorded: true, requestId: id };
}

export type CodeAttempt =
  | { allowed: true; requestId: string | null; askingBrowser: boolean }
  | { allowed: false; reason: "too_many_tries" | "other_browser_no_account" | "codeless" };

/**
 * Counts one try against the live request before the library checks the code (§5.2): the asking
 * browser has its own 3 tries; every other browser shares 3. A right code from another browser
 * never creates an account, so such a try fails as a wrong code would; and no code is right for a
 * codeless request, so a try against one fails the same way without reaching the library.
 *
 * The request tried is this browser's own when it holds one, else the live code, else a codeless
 * request of another browser.
 */
export async function attemptCode(
  db: Queryable,
  deps: { clock: Clock; hasher: KeyedHasher },
  input: { email: string; browserToken: string | null; accountExists: boolean },
): Promise<CodeAttempt> {
  await lockAddress(db, deps, input.email);
  const now = deps.clock.now();
  const live = await liveRequests(db, deps.hasher, input.email, now, { lock: true });
  const own = live.find((r) => sameBrowser(deps.hasher, r, input.browserToken));
  const target = own ?? live.find((r) => !r.codeless) ?? live[0];
  if (target === undefined) return { allowed: true, requestId: null, askingBrowser: false };
  const asking = own !== undefined;
  if ((asking ? target.browserTries : target.otherTries) >= TRIES_PER_CLASS) {
    return { allowed: false, reason: "too_many_tries" };
  }
  await db.query(
    asking
      ? "UPDATE identity.email_code_request SET browser_tries = browser_tries + 1 WHERE id = $1"
      : "UPDATE identity.email_code_request SET other_tries = other_tries + 1 WHERE id = $1",
    [target.id],
  );
  if (target.codeless) return { allowed: false, reason: "codeless" };
  if (!asking && !input.accountExists)
    return { allowed: false, reason: "other_browser_no_account" };
  return { allowed: true, requestId: target.id, askingBrowser: asking };
}

export async function markCodeUsed(db: Queryable, requestId: string, now: Date): Promise<void> {
  await db.query("UPDATE identity.email_code_request SET used_at = $2 WHERE id = $1", [
    requestId,
    now,
  ]);
}

/**
 * The sign-in link check (POST /api/sign-in/code-link, §5.2): whether this browser asked the
 * live request for this address. It says nothing about any other browser, address or account.
 */
export async function codeLinkAsking(
  db: Queryable,
  deps: { clock: Clock; hasher: KeyedHasher },
  email: string,
  browserToken: string | null,
): Promise<boolean> {
  const live = await liveRequests(db, deps.hasher, email, deps.clock.now());
  return live.some((r) => sameBrowser(deps.hasher, r, browserToken));
}
