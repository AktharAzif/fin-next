// Passwords in the developer realm (spec 02 §5.7, [SA-06], [SA-07]): Fin's rules around the
// library's `/sign-in/email`, `/email-otp/request-password-reset`, `/email-otp/reset-password` and
// `/change-password`. The before-hook calls `passwordBefore`, the after-hook `passwordAfter`; each
// runs in the request's unit of work, so every row, event and notice below commits together or
// not at all.
//
// - **Sign-in.** It takes the address's password turn first (codes.ts), the one a reset takes, so
//   a sign-in and a reset of one address take turns: a sign-in that read the old password never
//   commits a session after the reset that ended them all, and each try sees the count and the
//   pause the try before it left. It never waits for its turn: a sign-in that finds it held
//   (another sign-in of the address being checked, a reset) is answered `503` at once, so one
//   address's tries never queue on it, each holding a database client (passwords/hasher.ts). The
//   turn is not the address's code lock, so no code request or try waits on a sign-in's check.
//   Then the address's pause (passwords/pause.ts), for browsers its account does not know. A right
//   password makes an `aal1` session that never proves the mailbox,
//   so a password alone never enrols a first factor (§6.3); a person with a factor is at the factor
//   step, exactly as after a code sign-in (§6.2), unless a live trusted browser of theirs holds the
//   session (§6.6). That session is kept: the library's two-factor plugin would replace it with its
//   own password challenge (`__Host-fin.two_factor`), which Fin never sets, so the factor step has
//   one path, the signed-in one, with its replay, lockout and audit rules (S2-07).
// - **Reset.** A code, emailed to the address, sent and tried under the emailed-code rules of §5.2
//   with its own live request, tries and allowances (codes.ts, purpose `password_reset`). It works
//   only in the browser that asked for it. Every session of the person ends (Fin deletes them
//   itself, after the new password is written, and writes `session.ended` for exactly the ones the
//   delete returned), their trusted browsers are revoked, every known browser but the one that
//   reset is forgotten (a browser that once signed in with the old password no longer escapes the
//   pause), the authenticator lockout and the address's pauses lift, and
//   `sign-in-methods-changed` (kind `password_reset`) tells them. The same answer for every address.
// - **Load.** Each path that may hash is admitted by the hasher before its unit of work opens
//   (PASSWORD_HASHING_PATHS, passwords/hasher.ts), and a hash or a check for a request that was
//   not admitted fails closed (hashWhenAdmitted(), verifyWithWaiver()). A reset and a change do
//   their hashing in the before-hook, before they take any row a request that never hashes may
//   wait on, and the library is given those results (passwordAhead()).
// - **Change.** With a step-up intent (`account.password_change`, §7.6) and the current password.
// - **Factor changes.** The library re-asks a person with a password for it before an
//   authenticator or backup-code change; Fin's step-up stands in for that (see RECHECKED_PATHS).
import {
  forgetKnownBrowsersExcept,
  isKnownBrowserForEmail,
  markTrustedBrowserUsed,
  trustedBrowserOf,
} from "../browsers.ts";
import {
  attemptCode,
  lockPasswordTurn,
  markCodeUsed,
  requestCode,
  tryLockPasswordTurn,
} from "../codes.ts";
import { finCookieAttributes, finCookieName } from "../cookies.ts";
import { constantTimeEqual, randomToken } from "../crypto/keyed.ts";
import { AuthRefusal } from "../errors.ts";
import { factorMethods, personGate, trustedBrowserEligible } from "../gate.ts";
import { bodyOf, type HookContext, tokenCookie } from "../hooks/context.ts";
import {
  audit,
  device,
  factorLockKey,
  LIB_ERRORS,
  notify,
  nowIso,
  revokeTrust,
} from "../hooks/shared.ts";
import type { CountedBucket } from "../limits.ts";
import type { UnitTx } from "../ports/db.ts";
import type { PasswordRequest, RequestState } from "../request.ts";
import type { RealmRuntime } from "../runtime.ts";
import { factorFacts, personByEmail } from "../store.ts";
import {
  countWrongPassword,
  liftFactorLockout,
  liftPasswordPauses,
  passwordPausedUntil,
} from "./pause.ts";
import { assertNewPassword, PASSWORD_MAX_LENGTH, passwordProblem } from "./policy.ts";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;

/** The library paths of this module, and the body fields each accepts (everything else drops). */
export const PASSWORD_BODY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "/sign-in/email": ["email", "password"],
  "/email-otp/request-password-reset": ["email"],
  "/email-otp/reset-password": ["email", "otp", "password"],
  "/change-password": ["currentPassword", "newPassword"],
};

export function isPasswordPath(path: string): boolean {
  return Object.hasOwn(PASSWORD_BODY_FIELDS, path);
}

/**
 * The library paths whose requests may hash a password inside their unit of work: the realm has
 * each admitted by the hasher before the unit opens (passwords/hasher.ts). Fin's sign-up with a
 * password is admitted the same way (sign-up.ts). The two-factor paths' password re-check never
 * hashes: Fin's stand-in answers it (RECHECKED_PATHS). A path missing here that hashes fails
 * closed at its first hash (requireAdmission()).
 */
export const PASSWORD_HASHING_PATHS: ReadonlySet<string> = new Set([
  "/sign-in/email",
  "/email-otp/reset-password",
  "/change-password",
]);

/** What the after-hook lends this module (they live beside the hook's other cases). */
export interface AfterHelpers {
  knownBrowserNotice(person: { id: string; email: string }, firstSignIn: boolean): Promise<void>;
  consumeIntent(): Promise<{ id: string; method: "passkey" | "totp" | "backup_code" } | null>;
}

/**
 * The two-factor paths where the library re-asks for the password of a person who has one (its
 * `allowPasswordless` applies only to people without a password). Fin guards each with its own
 * step-up instead (§6.3, §7.6): the first factor only from a session that proved the mailbox in the
 * last 15 minutes, every later change with an intent proved by a factor, which a password can
 * never be. So, once that rule has passed for this request, Fin stands in for the re-check.
 */
const RECHECKED_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
]);

/**
 * Runs after the before-hook's step-up rule and body allowlist (which drops any `password` the
 * client sent): gives the request a one-time random stand-in that only `verifyWithWaiver` accepts,
 * for this path, once. Never for a person without a password (the library asks nothing then).
 */
export async function waivePasswordRecheck(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<void> {
  state.passwordWaiver = null;
  if (rt.settings.realm !== "developer" || !rt.settings.features.passwords) return;
  if (!RECHECKED_PATHS.has(ctx.path) || state.prior === null) return;
  const account = await tx.query<{ has: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM identity.account
                     WHERE user_id = $1 AND provider_id = 'credential' AND password IS NOT NULL) AS has`,
    [state.prior.person.id],
  );
  if (account.rows[0]?.has !== true) return;
  const nonce = randomToken();
  state.passwordWaiver = { path: ctx.path, nonce };
  bodyOf(ctx).password = nonce;
}

/**
 * Refuses a hash or a check for a request the hasher did not admit before its unit opened (the
 * realm's handler for PASSWORD_HASHING_PATHS, signUp() for a password): such a request would hold
 * its database client across the hash outside the bound admission keeps (passwords/hasher.ts). It
 * fails closed, so a library path that starts to hash without being admitted shows at once.
 */
function requireAdmission(rt: RealmRuntime): void {
  if (rt.requests.getStore()?.hashAdmitted !== true) {
    throw new Error("identity: a password was hashed by a request the hasher did not admit");
  }
}

function samePassword(a: string, b: string): boolean {
  return constantTimeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * The library's `password.hash`, and signUp()'s: argon2id, for an admitted request only. A hash
 * this request made ahead (passwordAhead()) is given back once, for the same password only.
 */
export async function hashWhenAdmitted(rt: RealmRuntime, password: string): Promise<string> {
  requireAdmission(rt);
  const state = rt.requests.getStore();
  const ahead = state?.passwordAhead.hash ?? null;
  if (state !== undefined && ahead !== null) {
    state.passwordAhead.hash = null;
    if (samePassword(ahead.password, password)) return ahead.hash;
  }
  return rt.passwords.hash(password);
}

/**
 * The library's `password.verify`: the stand-in, when this request holds one for its own path
 * (used up by the first check), and argon2id against the stored hash otherwise, for an admitted
 * request only. A check this request made ahead (passwordAhead()) is given back once, for the
 * same stored hash and password only.
 */
export async function verifyWithWaiver(
  rt: RealmRuntime,
  input: { hash: string; password: string },
): Promise<boolean> {
  const state = rt.requests.getStore();
  const waiver = state?.passwordWaiver ?? null;
  if (state !== undefined && waiver !== null) {
    state.passwordWaiver = null;
    const sent = Buffer.from(input.password, "utf8");
    const expected = Buffer.from(waiver.nonce, "utf8");
    return state.rule?.path === waiver.path && constantTimeEqual(sent, expected);
  }
  requireAdmission(rt);
  const ahead = state?.passwordAhead.verify ?? null;
  if (state !== undefined && ahead !== null) {
    state.passwordAhead.verify = null;
    if (ahead.hash === input.hash && samePassword(ahead.password, input.password)) return ahead.ok;
  }
  return rt.passwords.verify(input);
}

function requireDeveloperPasswords(rt: RealmRuntime): void {
  // The allowlist blocks these paths unless passwords are on in the developer realm (§4); this is
  // the second layer, for a call that reached the library some other way.
  if (rt.settings.realm !== "developer" || !rt.settings.features.passwords) {
    throw new AuthRefusal("not_found", "policy.blocked");
  }
}

function emailFrom(ctx: HookContext): string {
  const body = bodyOf(ctx);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) throw new AuthRefusal("invalid", "body.email", { fields: ["email"] });
  body.email = email;
  return email;
}

function newRequest(email: string, person: PasswordRequest["person"]): PasswordRequest {
  return {
    email,
    person,
    knownBrowser: false,
    trustedBrowserId: null,
    facts: null,
    codeRequestId: null,
    hadPassword: false,
  };
}

async function personOf(tx: UnitTx, email: string): Promise<PasswordRequest["person"]> {
  const person = await personByEmail(tx, "developer", email);
  return person === null ? null : { id: person.id, email: person.email };
}

/**
 * A reset's and a change's password work, done by the before-hook ahead of Fin's limits, and a
 * reset's turn with the address's sign-ins (passwords/hasher.ts). Each row such a request takes
 * from Fin's limits on (its network's `code_sign_in` count or the person's `method_add` count, a
 * reset's address turn and code lock, the session's row the library refreshes) is one a request
 * that never hashes may wait on, holding a client the hasher never admitted: so the hash of the
 * new password and the check of the current one are made here, before any of them, and the
 * library is given those results (hashWhenAdmitted(), verifyWithWaiver()). The only row held by
 * then is the library's own count of this path from this network, which only requests the hasher
 * admitted take; a request whose session the gate ended never comes here (hooks/before.ts).
 *
 * The limit that will count the request is read first, taking no row, so a request it refuses
 * costs no hash and, for a reset, never takes or waits for the address's turn: a stream of resets
 * past their network's tries cannot keep the turn held and the address's password sign-ins, which
 * never wait for it, answered 503. Requests sent together may all read room; those past the limit
 * are refused when it counts them, within what admission lets in. A password the rule refuses is
 * not hashed: resetBefore() and changeBefore() refuse it after the limit, as before.
 */
export async function passwordAhead(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<void> {
  if (rt.settings.realm !== "developer" || !rt.settings.features.passwords) return;
  if (ctx.path === "/email-otp/reset-password") return resetAhead(rt, ctx, state, tx);
  if (ctx.path === "/change-password") return changeAhead(rt, ctx, state, tx);
}

/** Refuses as the limit would (429), counting nothing and taking no row, when it is used up. */
async function refuseUsedUp(
  rt: RealmRuntime,
  tx: UnitTx,
  bucket: CountedBucket,
  subject: string,
): Promise<void> {
  const result = await rt.limits.check(tx, bucket, subject);
  if (!result.allowed) {
    throw new AuthRefusal("rate_limited", `limits.${bucket}`, { retry_after: result.retryAfter });
  }
}

async function hashAhead(rt: RealmRuntime, state: RequestState, password: string): Promise<void> {
  requireAdmission(rt);
  state.passwordAhead.hash = { password, hash: await rt.passwords.hash(password) };
}

/**
 * A reset: its network's tries, its new password's hash, then its turn (lockPasswordTurn() in
 * codes.ts). It waits for the turn while a sign-in of the address checks its password, holding
 * no row that a request which never hashes also takes, so none of those queues behind the check;
 * and it holds the turn only for its own statements, never across a hash. Waiting is right for a
 * reset, which a stream of sign-ins must not keep out: sign-ins never wait for the turn, so the
 * reset has it next. An address Fin does not accept takes no turn and costs no hash;
 * resetBefore() refuses it.
 */
async function resetAhead(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<void> {
  const body = bodyOf(ctx);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) return;
  await refuseUsedUp(rt, tx, "code_sign_in", rt.hasher.bucket("network", state.network));
  const password = body.password;
  if (typeof password === "string" && passwordProblem(password, { email }) === null) {
    await hashAhead(rt, state, password);
  }
  await lockPasswordTurn(tx, rt, email);
}

/**
 * A change, once its intent has passed (stepUpRule()): the person's `method_add` allowance, then
 * the new password's hash and the check of the current one against the stored hash, as the
 * library would make them. Without a password to check, the library refuses without hashing.
 */
async function changeAhead(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<void> {
  const person = state.prior?.person;
  if (person === undefined) return;
  const body = bodyOf(ctx);
  const current = body.currentPassword;
  const next = body.newPassword;
  if (typeof current !== "string" || current === "" || typeof next !== "string") return;
  // The library refuses a current password past the maximum before it hashes anything.
  if (current.length > PASSWORD_MAX_LENGTH) return;
  if (passwordProblem(next, { email: person.email }) !== null) return;
  await refuseUsedUp(rt, tx, "method_add", rt.hasher.bucket("person", person.id));
  const account = await tx.query<{ password: string | null }>(
    "SELECT password FROM identity.account WHERE user_id = $1 AND provider_id = 'credential'",
    [person.id],
  );
  const stored = account.rows[0]?.password ?? null;
  if (stored === null) return;
  await hashAhead(rt, state, next);
  state.passwordAhead.verify = {
    hash: stored,
    password: current,
    ok: await rt.passwords.verify({ hash: stored, password: current }),
  };
}

/** The before-hook's part: an answer to give instead of the library's, or undefined to go on. */
export async function passwordBefore(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<unknown> {
  if (!isPasswordPath(ctx.path)) return undefined;
  requireDeveloperPasswords(rt);
  switch (ctx.path) {
    case "/sign-in/email":
      return signInBefore(rt, ctx, state, tx);
    case "/email-otp/request-password-reset":
      return resetRequestBefore(rt, ctx, state, tx);
    case "/email-otp/reset-password":
      return resetBefore(rt, ctx, state, tx);
    case "/change-password":
      return changeBefore(ctx, state);
    default:
      return undefined;
  }
}

async function signInBefore(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<unknown> {
  const email = emailFrom(ctx);
  if (typeof bodyOf(ctx).password !== "string") {
    throw new AuthRefusal("invalid", "body.password", { fields: ["password"] });
  }
  // The address's password turn, held until commit, after the network's `password_sign_in` limit
  // and before anything about the address is read. A reset holds it from before its code's try to
  // its commit, so this sign-in never reads the password a reset is replacing, and a reset waits
  // for this sign-in and ends the session it made; and a wrong try's count and pause commit before
  // the next try of the address reads them, so tries sent together cannot pass the pause together.
  // Taken without waiting: held by another unit, the answer is 503 at once (the same for every
  // address, before anything about it is read), and nothing queues on the turn holding a client
  // while each sign-in ahead is checked in turn. It is not the address's code lock: a code request
  // or try of the address never waits on this sign-in's check.
  if (!(await tryLockPasswordTurn(tx, rt, email))) throw rt.passwords.busy("address_busy");
  const person = await personOf(tx, email);
  const request = newRequest(email, person);
  // Read for every address alike, so the pause and its answer say nothing about who has an account.
  request.knownBrowser = await isKnownBrowserForEmail(
    tx,
    rt.hasher,
    email,
    tokenCookie(ctx, finCookieName("developer", "known_browser")),
  );
  if (!request.knownBrowser) {
    const until = await passwordPausedUntil(tx, rt, email, state.network);
    if (until !== null) {
      const now = rt.clock.now();
      throw new AuthRefusal("rate_limited", "passwords.paused", {
        retry_after: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)),
        reason: "password_paused",
      });
    }
  }
  if (person !== null) {
    request.facts = await personGate(tx, person.id);
    if (trustedBrowserEligible(request.facts)) {
      const trusted = await trustedBrowserOf(
        tx,
        rt.hasher,
        person.id,
        tokenCookie(ctx, finCookieName("developer", "trusted_browser")),
        rt.clock.now(),
      );
      request.trustedBrowserId = trusted?.id ?? null;
    }
  }
  state.password = request;
  return undefined;
}

async function resetRequestBefore(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<unknown> {
  const email = emailFrom(ctx);
  const cookie = finCookieName("developer", "code_browser");
  const browserToken = tokenCookie(ctx, cookie) ?? randomToken();
  ctx.setCookie(cookie, browserToken, { ...finCookieAttributes("developer", "code_browser") });
  const person = await personOf(tx, email);
  const outcome = await requestCode(tx, rt, {
    email,
    browserToken,
    knownBrowserToken: tokenCookie(ctx, finCookieName("developer", "known_browser")),
    userId: person?.id ?? null,
    countRequest: true,
    purpose: "password_reset",
  });
  if (!outcome.send && outcome.reason === "rate_limited") {
    throw new AuthRefusal("rate_limited", "limits.code_send", { retry_after: outcome.retryAfter });
  }
  const request = newRequest(email, person);
  state.password = request;
  if (!outcome.send) {
    // Nothing is sent, and the answer is the library's own for any address (§5.2).
    state.line.reason = `codes.${outcome.reason}`;
    return { success: true };
  }
  request.codeRequestId = outcome.requestId;
  return undefined;
}

async function resetFailed(
  rt: RealmRuntime,
  tx: UnitTx,
  state: RequestState,
  person: PasswordRequest["person"],
  reason: "wrong_code" | "expired" | "too_many_tries" | "other_browser",
): Promise<void> {
  if (person === null) return;
  await audit(rt, tx, state, {
    event: "password.reset_failed",
    personId: person.id,
    target: person.id,
    metadata: { reason },
  });
}

async function resetBefore(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<unknown> {
  const email = emailFrom(ctx);
  // The new password is checked first: a weak one costs no try of the code.
  assertNewPassword(bodyOf(ctx).password, "password", { email });
  const person = await personOf(tx, email);
  const attempt = await attemptCode(tx, rt, {
    email,
    browserToken: tokenCookie(ctx, finCookieName("developer", "code_browser")),
    accountExists: person !== null,
    purpose: "password_reset",
  });
  if (!attempt.allowed) {
    const tooMany = attempt.reason === "too_many_tries";
    await resetFailed(rt, tx, state, person, tooMany ? "too_many_tries" : "other_browser");
    state.line.reason = `codes.${attempt.reason}`;
    throw tooMany ? LIB_ERRORS.tooManyOtpAttempts() : LIB_ERRORS.invalidOtp();
  }
  if (attempt.requestId === null) {
    // No live reset request for the address: no code can be right.
    await resetFailed(rt, tx, state, person, "expired");
    state.line.reason = "codes.no_live_request";
    throw LIB_ERRORS.invalidOtp();
  }
  if (!attempt.askingBrowser) {
    // A reset code works only in the browser that asked (the NewPassword board's "This link can't
    // be used here"); the try counts against the other browsers' shared allowance.
    await resetFailed(rt, tx, state, person, "other_browser");
    state.line.reason = "codes.other_browser";
    throw LIB_ERRORS.invalidOtp();
  }
  const request = newRequest(email, person);
  request.codeRequestId = attempt.requestId;
  if (person !== null) {
    // Read before the library writes the new password: a reset, or a first password.
    const account = await tx.query<{ has: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM identity.account
                       WHERE user_id = $1 AND provider_id = 'credential' AND password IS NOT NULL) AS has`,
      [person.id],
    );
    request.hadPassword = account.rows[0]?.has === true;
  }
  state.password = request;
  return undefined;
}

function changeBefore(ctx: HookContext, state: RequestState): unknown {
  const prior = state.prior;
  if (prior === null) throw new AuthRefusal("unauthenticated", "gate.signed_out");
  const body = bodyOf(ctx);
  if (typeof body.currentPassword !== "string" || body.currentPassword === "") {
    throw new AuthRefusal("invalid", "body.currentPassword", { fields: ["currentPassword"] });
  }
  assertNewPassword(body.newPassword, "newPassword", { email: prior.person.email });
  state.password = newRequest(prior.person.email, {
    id: prior.person.id,
    email: prior.person.email,
  });
  return undefined;
}

/** The library's error code, when the answer is an error. */
function libraryCode(returned: unknown): string | null {
  const code = (returned as { body?: { code?: unknown } } | null)?.body?.code;
  return typeof code === "string" ? code : null;
}

/** The after-hook's part, for a password path (success or failure). */
export async function passwordAfter(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
  failed: boolean,
  helpers: AfterHelpers,
): Promise<void> {
  const request = state.password;
  if (request === null) return;
  switch (ctx.path) {
    case "/sign-in/email":
      return failed
        ? signInFailed(rt, tx, state, request, libraryCode(ctx.context.returned))
        : signedIn(rt, ctx, tx, state, request, helpers);
    case "/email-otp/request-password-reset":
      return failed ? undefined : resetRequested(rt, tx, state, request);
    case "/email-otp/reset-password":
      return failed
        ? resetFailed(
            rt,
            tx,
            state,
            request.person,
            resetFailure(libraryCode(ctx.context.returned)),
          )
        : passwordReset(rt, ctx, tx, state, request);
    case "/change-password":
      return failed ? undefined : passwordChanged(rt, tx, state, request, helpers);
    default:
      return undefined;
  }
}

function resetFailure(code: string | null): "wrong_code" | "expired" | "too_many_tries" {
  if (code === "OTP_EXPIRED") return "expired";
  if (code === "TOO_MANY_ATTEMPTS") return "too_many_tries";
  return "wrong_code";
}

async function signedIn(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
  request: PasswordRequest,
  helpers: AfterHelpers,
): Promise<void> {
  const created = ctx.context.newSession;
  if (created === null || created === undefined) return;
  const sessionId = created.session.id;
  const userId = created.user.id;
  state.line.userId = userId;
  state.line.assurance = "aal1";
  const facts = await personGate(tx, userId);
  const trusted = request.trustedBrowserId;
  if (facts.factorCount > 0 && trusted === null) {
    await audit(rt, tx, state, {
      event: "sign_in.second_factor_required",
      personId: userId,
      target: sessionId,
      refs: [userId],
      metadata: { methods: factorMethods("developer", await factorFacts(tx, "developer", userId)) },
    });
    state.line.gate = "factor_step";
  } else {
    await audit(rt, tx, state, {
      event: "session.created",
      personId: userId,
      target: sessionId,
      refs: [userId, ...(trusted === null ? [] : [trusted])],
      metadata: { method: "password", assurance: "aal1", trustedBrowser: trusted !== null },
    });
    if (trusted !== null) await markTrustedBrowserUsed(tx, trusted, rt.clock.now());
    state.line.gate = facts.factorCount === 0 && facts.privilegedAnywhere ? "hold" : "ok";
    await helpers.knownBrowserNotice(created.user, false);
  }
  keepSession(ctx);
}

/**
 * Keeps the session this sign-in made. The two-factor plugin's sign-in hook runs after Fin's and
 * would delete it for its own password challenge when the person has an authenticator; with no
 * new session in the context it leaves the answer alone (pinned by passwords.db.test.ts).
 */
function keepSession(ctx: HookContext): void {
  const context = ctx.context as { setNewSession?: unknown };
  if (typeof context.setNewSession !== "function") {
    throw new Error("identity: the library no longer lets a hook keep its session");
  }
  (context.setNewSession as (session: null) => void).call(ctx.context, null);
}

async function signInFailed(
  rt: RealmRuntime,
  tx: UnitTx,
  state: RequestState,
  request: PasswordRequest,
  code: string | null,
): Promise<void> {
  if (code !== "INVALID_EMAIL_OR_PASSWORD") return;
  state.line.reason = "passwords.wrong";
  if (!request.knownBrowser) {
    await countWrongPassword(tx, rt, state, {
      email: request.email,
      network: state.network,
      person: request.person,
    });
  }
  if (request.person !== null) {
    await audit(rt, tx, state, {
      event: "sign_in.failed",
      personId: request.person.id,
      target: request.person.id,
      metadata: { method: "password", reason: "wrong_password" },
    });
  }
}

async function resetRequested(
  rt: RealmRuntime,
  tx: UnitTx,
  state: RequestState,
  request: PasswordRequest,
): Promise<void> {
  const person = request.person;
  if (person === null) return;
  await audit(rt, tx, state, {
    event: "password.reset_requested",
    personId: person.id,
    target: person.id,
    refs: request.codeRequestId === null ? [] : [request.codeRequestId],
    metadata: {},
  });
}

async function passwordReset(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
  request: PasswordRequest,
): Promise<void> {
  const person = request.person;
  if (person === null) return;
  const now = rt.clock.now();
  if (request.codeRequestId !== null) await markCodeUsed(tx, request.codeRequestId, now);
  // The authenticator lockout first, then the sessions: the order of every unit that takes both.
  // A factor code (the factor step, a step-up, finishing an authenticator's set-up) holds the
  // person's lockout row from its before-hook on (holdLockout() in hooks/before.ts), before the
  // library reads (and may refresh) its session, and touches the lockout again only after that; a
  // wrong code's lockout and a step-up's ending of its session come after the row too. So this
  // reset and the person's factor code in another browser never wait on each other in a circle:
  // whichever has the row first finishes, and the other goes on after it.
  await liftFactorLockout(tx, rt, factorLockKey(state, person.id));
  // Every session ends here, not in the library (revokeSessionsOnPasswordReset is off): the ones
  // this delete returns are exactly the ones ended, each with its event. A session another unit is
  // changing is waited for and ended as it commits. One committed after this delete began stays:
  // a passkey sign-in (which takes no address lock), or the session a passkey step-up or an
  // authenticator change put in place of an older one at that very instant, each made with a
  // factor of the person's. Holding no row of the person's, the reset never stops a session from
  // being made or changed meanwhile (a lock there deadlocked with the person's own factor step).
  const ended = await tx.query<{ id: string }>(
    "DELETE FROM identity.session WHERE user_id = $1 RETURNING id",
    [person.id],
  );
  const sessionIds = ended.rows.map((r) => r.id).sort();
  const account = await tx.query<{ id: string }>(
    "SELECT id FROM identity.account WHERE user_id = $1 AND provider_id = 'credential'",
    [person.id],
  );
  await audit(rt, tx, state, {
    event: request.hadPassword ? "password.reset" : "password.set",
    personId: person.id,
    target: person.id,
    refs: [
      ...account.rows.map((r) => r.id),
      ...(request.codeRequestId === null ? [] : [request.codeRequestId]),
    ],
    metadata: { sessionsEnded: sessionIds.length },
  });
  for (const sessionId of sessionIds) {
    await audit(rt, tx, state, {
      event: "session.ended",
      personId: person.id,
      target: sessionId,
      refs: [person.id],
      metadata: { reason: "password_reset" },
    });
  }
  // A known browser is never paused (§5.5, §5.7), and any sign-in makes one, so a browser that
  // signed in with the old password would keep guessing the new one with no pause. Every known
  // browser but this one is forgotten, as "sign out everywhere else" does (§11.4): this browser
  // proved the mailbox with the emailed code just now. Known browsers before trusted ones, the
  // order "sign out everywhere else" (sessions.ts) and the factor step take them in.
  await forgetKnownBrowsersExcept(
    tx,
    rt.hasher,
    person.id,
    tokenCookie(ctx, finCookieName("developer", "known_browser")),
  );
  await revokeTrust(rt, tx, state, person.id, "password_reset");
  await liftPasswordPauses(tx, rt, request.email);
  await notify(rt, tx, "identity/sign-in-methods-changed", person.email, {
    userId: person.id,
    kind: "password_reset",
    device: device(state),
    time: nowIso(rt),
  });
  state.line.userId = person.id;
}

async function passwordChanged(
  rt: RealmRuntime,
  tx: UnitTx,
  state: RequestState,
  request: PasswordRequest,
  helpers: AfterHelpers,
): Promise<void> {
  const person = request.person;
  if (person === null) return;
  const intent = await helpers.consumeIntent();
  await audit(rt, tx, state, {
    event: "password.changed",
    personId: person.id,
    target: person.id,
    refs: intent === null ? [] : [intent.id],
    metadata: {},
    ...(intent === null
      ? {}
      : {
          actor: {
            kind: "user",
            id: person.id,
            via: "console",
            stepUp: { kind: "intent", method: intent.method, ref: intent.id },
          },
        }),
  });
  await notify(rt, tx, "identity/sign-in-methods-changed", person.email, {
    userId: person.id,
    kind: "password_changed",
    device: device(state),
    time: nowIso(rt),
  });
}
