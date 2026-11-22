// `hooks.before` (spec 02 §3.5): in this order, a ceremony's hold on its person's row, the realm's
// gate for the path, the step-up rule for `step_up_self` paths, Fin's limits, the body allowlist
// (stripping `trustDevice` and `rememberMe`), and each path's own rules: emailed codes bound to the
// asking browser, the staff Access binding, the sign-ups switch, TOTP replay and lockout, and the
// last-factor rule.
import { symmetricDecrypt } from "better-auth/crypto";
import { trustedBrowserOf } from "../browsers.ts";
import { attemptCode, requestCode } from "../codes.ts";
import { finCookieAttributes, finCookieName } from "../cookies.ts";
import { randomToken } from "../crypto/keyed.ts";
import { base32Decode, matchingStep } from "../crypto/totp.ts";
import { deviceSummary } from "../device.ts";
import type { EndpointRule } from "../endpoint-policy.ts";
import { AuthRefusal } from "../errors.ts";
import {
  developerGate,
  factorMethods,
  factorStepExpired,
  mailboxFresh,
  personGate,
  staffGate,
  trustedBrowserEligible,
} from "../gate.ts";
import type { CountedBucket } from "../limits.ts";
import type { UnitTx } from "../ports/db.ts";
import type { RequestState } from "../request.ts";
import { type RealmRuntime, requestState, unitOf } from "../runtime.ts";
import { SELF_PATH_ACTIONS } from "../step-up/actions/identity.ts";
import { paramsDigest } from "../step-up/digest.ts";
import {
  createIntent,
  intentIdFrom,
  intentProblem,
  readIntent,
  refuseIntent,
} from "../step-up/intents.ts";
import {
  endSession,
  factorFacts,
  isLive,
  personByEmail,
  personById,
  sessionByToken,
  TABLES,
} from "../store.ts";
import { bodyOf, type HookContext, headersOf, tokenCookie } from "./context.ts";
import {
  audit,
  countFactorLockout,
  factorLockKey,
  LIB_ERRORS,
  recordFactorFailure,
} from "./shared.ts";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;

/** The body fields each reachable library path accepts; everything else is dropped. */
const BODY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "/email-otp/send-verification-otp": ["email", "type"],
  "/sign-in/email-otp": ["email", "otp"],
  "/two-factor/verify-totp": ["code"],
  "/two-factor/verify-backup-code": ["code"],
  "/two-factor/enable": [],
  "/two-factor/disable": [],
  "/two-factor/generate-backup-codes": [],
  "/passkey/verify-registration": ["response", "name"],
  "/passkey/verify-authentication": ["response"],
  "/passkey/delete-passkey": ["id"],
  "/sign-out": [],
};

export async function beforeHook(rt: RealmRuntime, ctx: HookContext): Promise<unknown> {
  const state = requestState(rt);
  const tx = unitOf(rt);
  const realm = rt.settings.realm;
  const rule = rt.policy.rules.find((r) => r.path === ctx.path) ?? null;
  if (rule === null || rule.class === "blocked") {
    // The allowlist answered before the router for HTTP; this is the second layer for server calls.
    rt.lines.write("auth.endpoint_blocked", "warn", {
      realm,
      class: rule === null ? "unlisted" : "blocked",
    });
    throw new AuthRefusal("not_found", "policy.blocked");
  }
  state.rule = rule;
  state.line.authPath = rule.path;

  await holdPerson(rt, ctx, tx);
  await loadPrior(rt, ctx, state, tx);
  if (!rule.reach.includes(state.gate)) refuseGate(rt, state);
  await stepUpRule(rt, ctx, state, tx);
  await finLimits(rt, ctx, state, tx, rule);
  stripBody(ctx, state);

  if (realm === "developer") {
    if (ctx.path === "/email-otp/send-verification-otp")
      return developerCodeSend(rt, ctx, state, tx);
    if (ctx.path === "/sign-in/email-otp") return developerCodeSignIn(rt, ctx, state, tx);
  } else {
    if (ctx.path === "/email-otp/send-verification-otp") return staffCodeSend(rt, ctx, state, tx);
    if (ctx.path === "/sign-in/email-otp") return staffCodeSignIn(rt, ctx, state, tx);
  }
  if (ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/verify-backup-code") {
    await factorCodeChecks(rt, ctx, state, tx);
  }
  if (ctx.path === "/two-factor/disable" || ctx.path === "/passkey/delete-passkey") {
    await lastFactorRule(rt, ctx, state, tx);
  }
  if (ctx.path === "/passkey/verify-registration") {
    bodyOf(ctx).name = deviceSummary(state.context.userAgent);
  }
  if (ctx.path === "/passkey/verify-authentication") {
    await notePasskeyCounter(rt, ctx, state, tx);
  }
  return undefined;
}

/**
 * The library paths whose ceremony reads a person's credentials and then writes a session, a proof
 * or a factor for them (§5.3, §5.4, §6.5, §7.4).
 */
export const CEREMONY_PATHS: ReadonlySet<string> = new Set([
  "/passkey/verify-authentication",
  "/passkey/verify-registration",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/enable",
]);

/**
 * A ceremony holds its person's row `FOR KEY SHARE`, from before anything reads their session or
 * credentials to its commit. Every change that removes a person's factors or ends their sessions
 * locks the same row first `FOR UPDATE`, the one mode that conflicts with the hold: a staff reset,
 * removal or role change inside the staff-change lock (§10.8), the operator's bootstrap reset
 * (§10.6), and the last-factor rule's removals (§6.7). So the two never overlap: either the change
 * waits for the ceremony to commit and then ends what it made, or the ceremony waits for the change
 * and then reads the person as the change left them, the credential gone and the session ended
 * (§11.4). Taken first, it also keeps either from waiting on a row the other holds (a passkey's
 * counter, a session).
 *
 * Nothing else waits on the hold: neither another ceremony of the person, nor a foreign-key check,
 * nor the person's own routes, which read and renew their session first and only then write their
 * row (the name, §14.2) or serialise on it `FOR NO KEY UPDATE` (an organisation's creation, §9.1).
 * Those must never wait on the hold, because the ceremony writes that session (it renews it, or
 * replaces it on a step-up) while it holds the row. A staff change never locks its actor's own row
 * (`@fin/staff`'s lock.ts). A ceremony that writes the row itself later (a sign-in's time, an
 * enrolment) does so under its own hold, without queueing behind a change that waits for it.
 *
 * A passkey assertion names its person by its credential; every other ceremony by the session it
 * runs in. (Signing out everywhere else removes no credential, so a ceremony that commits after it
 * is a new sign-in like any other.)
 */
async function holdPerson(rt: RealmRuntime, ctx: HookContext, tx: UnitTx): Promise<void> {
  if (!CEREMONY_PATHS.has(ctx.path)) return;
  const tables = TABLES[rt.settings.realm];
  if (ctx.path === "/passkey/verify-authentication") {
    const response = bodyOf(ctx).response as { id?: unknown } | undefined;
    if (typeof response?.id !== "string") return;
    await tx.query(
      `SELECT 1 FROM ${tables.user}
        WHERE id = (SELECT user_id FROM ${tables.passkey} WHERE credential_id = $1)
          FOR KEY SHARE`,
      [response.id],
    );
    return;
  }
  const token = await ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret,
  );
  if (typeof token !== "string" || token === "") return;
  await tx.query(
    `SELECT 1 FROM ${tables.user}
      WHERE id = (SELECT user_id FROM ${tables.session} WHERE token = $1)
        FOR KEY SHARE`,
    [token],
  );
}

async function loadPrior(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<void> {
  const realm = rt.settings.realm;
  const now = rt.clock.now();
  state.prior = null;
  state.gate = "signed_out";
  const token = await ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret,
  );
  if (typeof token !== "string" || token === "") return;
  const session = await sessionByToken(tx, realm, token, now);
  if (session === null) {
    state.line.unauthenticated = "signed_out";
    return;
  }
  if (!isLive(session, now)) {
    state.line.unauthenticated = session.stepUpFailures >= 5 ? "too_many_tries" : "expired";
    return;
  }
  const person = await personById(tx, realm, session.userId);
  if (person === null) return;
  const factors = await factorFacts(tx, realm, person.id);
  if (realm === "developer") {
    const facts = await personGate(tx, person.id);
    const gate = developerGate(session, facts);
    if (gate === "factor_step" && factorStepExpired(session, now)) {
      await endSession(tx, realm, session.id, now);
      state.line.unauthenticated = "expired";
      return;
    }
    state.prior = { session, person, factors, facts };
    state.gate = gate;
  } else {
    const result = staffGate(session, person, factors, state.context.access ?? null);
    if ("refused" in result) {
      await endSession(tx, realm, session.id, now);
      if (result.refused === "access_mismatch") {
        rt.lines.write("staff.access_mismatch", "warn", { staffId: person.id });
        await audit(rt, tx, state, {
          event: "staff.sign_in_failed",
          personId: person.id,
          target: person.id,
          refs: [session.id],
          metadata: { method: "email_otp", reason: "access_mismatch" },
        });
        throw new AuthRefusal("access_mismatch", "staff.access_mismatch");
      }
      state.line.unauthenticated = "signed_out";
      return;
    }
    if (result.state !== "ok" && factorStepExpired(session, now)) {
      await endSession(tx, realm, session.id, now);
      state.line.unauthenticated = "expired";
      return;
    }
    state.prior = { session, person, factors, facts: null };
    state.gate = result.state;
  }
  state.line.assurance = session.assurance;
  state.line[realm === "developer" ? "userId" : "staffId"] = person.id;
  state.line.gate = state.gate;
}

function refuseGate(rt: RealmRuntime, state: RequestState): never {
  const realm = rt.settings.realm;
  rt.lines.write("auth.gate_refused", "warn", { realm, state: state.gate });
  const factors = state.prior?.factors;
  switch (state.gate) {
    case "signed_out":
      throw new AuthRefusal("unauthenticated", "gate.signed_out", {
        reason:
          typeof state.line.unauthenticated === "string"
            ? state.line.unauthenticated
            : "signed_out",
      });
    case "factor_step":
      throw new AuthRefusal("factor_step_required", "gate.factor_step", {
        methods: factors === undefined ? [] : factorMethods(realm, factors),
      });
    case "pending":
      throw new AuthRefusal("factor_step_required", "gate.pending", { methods: [] });
    case "hold":
      throw new AuthRefusal("second_factor_required", "gate.hold", { hold: true });
    case "ok":
      throw new AuthRefusal("forbidden", "gate.ok");
  }
}

/** A path the router mounts for GET only (a GET changes nothing Fin counts or keeps, §2.3). */
function isGetPath(state: RequestState): boolean {
  const methods = state.rule?.methods ?? [];
  return methods.length > 0 && methods.every((m) => m === "GET");
}

function targetOf(path: string, body: Record<string, unknown>, personId: string): string {
  if (path === "/passkey/delete-passkey" && typeof body.id === "string") return body.id;
  return personId;
}

async function stepUpRule(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<void> {
  const realm = rt.settings.realm;
  const actionKey = (SELF_PATH_ACTIONS[realm] as Readonly<Record<string, string>>)[ctx.path];
  if (actionKey === undefined) return;
  const action = rt.actions.get(actionKey);
  const prior = state.prior;
  if (action === undefined || prior === null)
    throw new AuthRefusal("forbidden", "step_up.unknown_action");
  const now = rt.clock.now();
  if (
    realm === "staff" &&
    ctx.path === "/two-factor/enable" &&
    prior.factors.count === 0 &&
    rt.settings.environment === "production"
  ) {
    // In production the first staff factor is a passkey ([SA-04]).
    rt.lines.write("staff.enrolment_refused", "warn", {
      staffId: prior.person.id,
      reason: "passkey_first",
    });
    throw new AuthRefusal("forbidden", "staff.passkey_first", { reason: "passkey_first" });
  }
  if (action.kind === "intent_after_first_factor" && prior.factors.count === 0) {
    if (realm === "developer") {
      if (!mailboxFresh(prior.session, now)) {
        throw new AuthRefusal("fresh_session_required", "step_up.first_factor");
      }
      return;
    }
    const window = prior.session.enrolmentOpenUntil;
    if (window === null || window.getTime() <= now.getTime()) {
      rt.lines.write("staff.enrolment_refused", "warn", {
        staffId: prior.person.id,
        reason: "no_window",
      });
      throw new AuthRefusal("forbidden", "staff.enrolment_window", {
        reason: "enrolment_code_required",
      });
    }
    return;
  }
  if (prior.factors.count === 0) {
    throw new AuthRefusal("second_factor_required", "step_up.no_factor", { hold: false });
  }
  const body = bodyOf(ctx);
  const binding = {
    realm,
    sessionId: prior.session.id,
    principalId: prior.person.id,
    organizationId: null,
    action: action.key,
    digest: paramsDigest({
      realm,
      action: action.key,
      org: null,
      target: targetOf(ctx.path, body, prior.person.id),
      body,
      bind: action.bind,
    }),
  };
  state.line.stepUp = "intent";
  const headerId = intentIdFrom(headersOf(ctx));
  if (headerId === null && isGetPath(state)) {
    // A GET never makes an intent or spends a budget: a page on a sibling host can send one with
    // the session cookie (§2.3, [SA-44]). The intent is made by the action's gated POST
    // (`/passkey/verify-registration` sent without the header) and this GET only checks it.
    state.line.stepUpOutcome = "required";
    throw new AuthRefusal("step_up_required", "step_up.required", {
      step_up_kind: "intent",
      methods: factorMethods(realm, prior.factors),
      reason_key: action.reasonKey,
    });
  }
  if (headerId === null) {
    const created = await createIntent(tx, rt, { ...binding, reasonKey: action.reasonKey });
    state.line.stepUpOutcome = "required";
    throw new AuthRefusal("step_up_required", "step_up.required", {
      intent_id: created.id,
      step_up_kind: "intent",
      methods: factorMethods(realm, prior.factors),
      reason_key: action.reasonKey,
      expires_at: created.expiresAt.toISOString(),
    });
  }
  const problem = intentProblem(await readIntent(tx, headerId), binding);
  if (problem !== null) {
    state.line.stepUpOutcome = "invalid";
    throw refuseIntent(rt.lines, realm, action.key, problem);
  }
  state.intent = { id: headerId, binding };
}

async function consumeBucket(
  rt: RealmRuntime,
  tx: UnitTx,
  bucket: CountedBucket,
  subject: string,
): Promise<void> {
  const result = await rt.limits.consume(tx, bucket, subject);
  if (!result.allowed) {
    throw new AuthRefusal("rate_limited", `limits.${bucket}`, { retry_after: result.retryAfter });
  }
}

async function finLimits(
  rt: RealmRuntime,
  _ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
  rule: EndpointRule,
): Promise<void> {
  const network = rt.hasher.bucket("network", state.network);
  switch (rule.limit) {
    case null:
    case "default":
      // The library's own limiter counts the default bucket (100 per 10 s per address).
      return;
    case "code_send":
      // signUp() counted this code request's network allowance before it asked for the code.
      if (state.codeSendCounted) return;
      return consumeBucket(rt, tx, rule.limit, network);
    case "code_sign_in":
    case "factor_code":
    case "password_sign_in":
    case "passkey_options":
      return consumeBucket(rt, tx, rule.limit, network);
    case "method_add":
    case "backup_codes": {
      const person = state.prior?.person.id;
      if (person === undefined) throw new AuthRefusal("unauthenticated", "limits.no_person");
      return consumeBucket(rt, tx, rule.limit, rt.hasher.bucket("person", person));
    }
    case "staff_code_send":
    case "staff_code_sign_in": {
      const access = state.context.access;
      if (access === null || access === undefined)
        throw new AuthRefusal("access_required", "access.missing");
      return consumeBucket(rt, tx, rule.limit, rt.hasher.bucket("person", access.sub));
    }
  }
}

function stripBody(ctx: HookContext, state: RequestState): void {
  const body = ctx.body;
  if (body === undefined || body === null || typeof body !== "object") return;
  if ("trustDevice" in body) state.trustDevice = body.trustDevice === true;
  const allowed = BODY_FIELDS[ctx.path];
  if (allowed === undefined) return;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) delete body[key];
  }
}

function normaliseEmail(ctx: HookContext): string {
  const body = bodyOf(ctx);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  body.email = email;
  return email;
}

async function liveSignUpRequest(
  rt: RealmRuntime,
  tx: UnitTx,
  email: string,
  token: string | null,
): Promise<{ id: string; name: string } | null> {
  if (token === null) return null;
  const result = await tx.query<{ id: string; name: string }>(
    `SELECT id, name FROM identity.sign_up_request
      WHERE email = $1 AND browser_hash = ANY($2) AND used_at IS NULL AND expires_at > $3
      ORDER BY created_at DESC LIMIT 1`,
    [email, rt.hasher.hashes("sign_up_browser", token), rt.clock.now()],
  );
  return result.rows[0] ?? null;
}

/** `/email-otp/send-verification-otp`, developer realm (§5.2). Every outcome answers the same. */
async function developerCodeSend(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<unknown> {
  const body = bodyOf(ctx);
  if (body.type !== "sign-in") throw new AuthRefusal("invalid", "body.type", { fields: ["type"] });
  const email = normaliseEmail(ctx);
  // An address Fin does not accept is refused here, never left to the library: its own check
  // lets through addresses Fin's rule refuses (a local part over 64 characters), and a code sent
  // to one would skip every per-address rule below (the same refusal as signUp()'s).
  if (!EMAIL.test(email)) throw new AuthRefusal("invalid", "body.email", { fields: ["email"] });
  const cookie = finCookieName("developer", "code_browser");
  const browserToken = tokenCookie(ctx, cookie) ?? randomToken();
  ctx.setCookie(cookie, browserToken, { ...finCookieAttributes("developer", "code_browser") });
  const person = await personByEmail(tx, "developer", email);
  const signUp = await liveSignUpRequest(
    rt,
    tx,
    email,
    tokenCookie(ctx, finCookieName("developer", "sign_up_browser")),
  );
  state.codeTemplate = signUp !== null && person === null ? "confirm-email" : "sign-in-code";
  const outcome = await requestCode(tx, rt, {
    email,
    browserToken,
    knownBrowserToken: tokenCookie(ctx, finCookieName("developer", "known_browser")),
    userId: person?.id ?? null,
    countRequest: !state.codeSendCounted,
  });
  if (!outcome.send && outcome.reason === "rate_limited") {
    throw new AuthRefusal("rate_limited", "limits.code_send", { retry_after: outcome.retryAfter });
  }
  if (!outcome.send) {
    state.line.reason = `codes.${outcome.reason}`;
    return { success: true };
  }
  return undefined;
}

/** `/sign-in/email-otp`, developer realm (§5.1, §5.2, S2-22). */
async function developerCodeSignIn(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<unknown> {
  const email = normaliseEmail(ctx);
  const person = await personByEmail(tx, "developer", email);
  const attempt = await attemptCode(tx, rt, {
    email,
    browserToken: tokenCookie(ctx, finCookieName("developer", "code_browser")),
    accountExists: person !== null,
  });
  if (attempt.allowed && attempt.requestId === null) {
    // Every code Fin lets the library send has a live request (§5.2): with none, no code can be
    // right, and the tries, the browser binding and the account rule would all be skipped.
    if (person !== null) {
      await audit(rt, tx, state, {
        event: "sign_in.failed",
        personId: person.id,
        target: person.id,
        metadata: { method: "email_otp", reason: "wrong_code" },
      });
    }
    state.line.reason = "codes.no_live_request";
    throw LIB_ERRORS.invalidOtp();
  }
  if (!attempt.allowed) {
    if (person !== null) {
      await audit(rt, tx, state, {
        event: "sign_in.failed",
        personId: person.id,
        target: person.id,
        metadata: {
          method: "email_otp",
          // A try against a codeless request (§5.1's registered sign-up) is a wrong code: no code
          // is right for it.
          reason:
            attempt.reason === "too_many_tries"
              ? "too_many_tries"
              : attempt.reason === "codeless"
                ? "wrong_code"
                : "other_browser",
        },
      });
    }
    state.line.reason = `codes.${attempt.reason}`;
    throw attempt.reason === "too_many_tries"
      ? LIB_ERRORS.tooManyOtpAttempts()
      : LIB_ERRORS.invalidOtp();
  }
  if (person === null && (await rt.killSwitch(tx, "signups")) === "on") {
    // While sign-ups are paused a code for an unknown address fails as a wrong code would.
    state.line.reason = "switch.signups";
    throw LIB_ERRORS.invalidOtp();
  }
  let facts = null;
  let trustedBrowserId: string | null = null;
  if (person !== null) {
    facts = await personGate(tx, person.id);
    if (trustedBrowserEligible(facts)) {
      const trusted = await trustedBrowserOf(
        tx,
        rt.hasher,
        person.id,
        tokenCookie(ctx, finCookieName("developer", "trusted_browser")),
        rt.clock.now(),
      );
      trustedBrowserId = trusted?.id ?? null;
    }
  }
  const signUp =
    person === null
      ? await liveSignUpRequest(
          rt,
          tx,
          email,
          tokenCookie(ctx, finCookieName("developer", "sign_up_browser")),
        )
      : null;
  state.signIn = {
    email,
    codeRequestId: attempt.requestId,
    askingBrowser: attempt.askingBrowser,
    accountExists: person !== null,
    facts,
    trustedBrowserId,
    signUpRequestId: signUp?.id ?? null,
    signUpName: signUp?.name ?? null,
  };
  return undefined;
}

/** `/email-otp/send-verification-otp`, staff realm: only to an eligible address (§10.5). */
async function staffCodeSend(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<unknown> {
  const body = bodyOf(ctx);
  if (body.type !== "sign-in") throw new AuthRefusal("invalid", "body.type", { fields: ["type"] });
  const email = normaliseEmail(ctx);
  const access = state.context.access;
  if (access === null || access === undefined)
    throw new AuthRefusal("access_required", "access.missing");
  const accessEmail = access.email.toLowerCase();
  const accessMember = await personByEmail(tx, "staff", accessEmail);
  if (accessMember === null || accessMember.status === "removed") {
    rt.lines.write("staff.not_listed", "warn", { reason: "code_request" });
    state.line.reason = "staff.not_listed";
    return { success: true };
  }
  if (email !== accessEmail) {
    state.line.reason = "staff.not_access_identity";
    return { success: true };
  }
  const allowance = await rt.limits.consume(
    tx,
    "staff_code_email",
    rt.hasher.bucket("email", email),
  );
  if (!allowance.allowed) {
    state.line.reason = "codes.allowance_used";
    return { success: true };
  }
  return undefined;
}

/** `/sign-in/email-otp`, staff realm: bound to the Access identity (§10.5). */
async function staffCodeSignIn(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<unknown> {
  const email = normaliseEmail(ctx);
  const access = state.context.access;
  if (access === null || access === undefined)
    throw new AuthRefusal("access_required", "access.missing");
  const member = await personByEmail(tx, "staff", email);
  if (member === null || member.status === "removed" || email !== access.email.toLowerCase()) {
    if (member !== null) {
      await audit(rt, tx, state, {
        event: "staff.sign_in_failed",
        personId: member.id,
        target: member.id,
        metadata: {
          method: "email_otp",
          reason: member.status === "removed" ? "removed" : "access_mismatch",
        },
      });
    }
    state.line.reason = "staff.not_eligible";
    throw LIB_ERRORS.invalidOtp();
  }
  return undefined;
}

/** The decrypted TOTP secret's bytes, as the library keys its HMAC. */
async function totpSecretBytes(ctx: HookContext, encrypted: string): Promise<Uint8Array> {
  const secret = await symmetricDecrypt({
    key: ctx.context.secretConfig as Parameters<typeof symmetricDecrypt>[0]["key"],
    data: encrypted,
  });
  if (secret.startsWith("base32:")) return base32Decode(secret.slice(7));
  return new TextEncoder().encode(secret);
}

/**
 * May this session finish an authenticator's set-up (§5.4, §6.3, §6.4)? Only a session that may
 * enrol: a developer's working session or hold, a working staff session, or a pending member's
 * session inside its enrolment window (outside it, the enrolment paths' own refusal). Never a
 * session at the factor step: it has shown no factor, and finishing would raise it to aal2 with a
 * secret its own session never saw.
 */
function mayFinishSetUp(rt: RealmRuntime, state: RequestState): boolean {
  const prior = state.prior;
  if (prior === null) return false;
  if (rt.settings.realm === "developer") return state.gate === "ok" || state.gate === "hold";
  if (state.gate !== "pending") return state.gate === "ok";
  const window = prior.session.enrolmentOpenUntil;
  if (window !== null && window.getTime() > rt.clock.now().getTime()) return true;
  rt.lines.write("staff.enrolment_refused", "warn", {
    staffId: prior.person.id,
    reason: "no_window",
  });
  throw new AuthRefusal("forbidden", "staff.enrolment_window", {
    reason: "enrolment_code_required",
  });
}

/**
 * The second-factor codes (§5.4, [SA-35]): the lockout (10 wrong codes, one hour); an
 * authenticator that is missing or unfinished is no factor; and a TOTP step is accepted once,
 * across sign-in and step-up, claimed atomically so that requests sent together cannot all pass.
 */
async function factorCodeChecks(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<void> {
  const prior = state.prior;
  if (prior === null) return;
  const realm = rt.settings.realm;
  if ((await rt.limits.lockedUntil(tx, factorLockKey(state, prior.person.id))) !== null) {
    state.line.reason = "factor.locked";
    throw LIB_ERRORS.locked();
  }
  const isTotp = ctx.path === "/two-factor/verify-totp";
  if (!prior.factors.authenticator) {
    // Nothing to check a code against, or a set-up only a session that may enrol may finish: the
    // library's own answers, before it runs, so that nothing is counted for a code that cannot pass.
    if (!isTotp || !prior.factors.authenticatorPending || !mayFinishSetUp(rt, state)) {
      state.line.reason = "factor.not_enrolled";
      throw isTotp ? LIB_ERRORS.totpNotEnabled() : LIB_ERRORS.backupCodesNotEnabled();
    }
    state.finishingAuthenticator = true;
  }
  if (!isTotp) return;
  const code = typeof bodyOf(ctx).code === "string" ? (bodyOf(ctx).code as string) : "";
  const row = await tx.query<{ secret: string }>(
    `SELECT secret FROM ${TABLES[realm].twoFactor} WHERE user_id = $1`,
    [prior.person.id],
  );
  const found = row.rows[0];
  if (found === undefined) return;
  const now = rt.clock.now();
  let step: bigint | null = null;
  try {
    step = matchingStep(await totpSecretBytes(ctx, found.secret), code, now, { window: 1 });
  } catch {
    rt.lines.write("auth.secret_unreadable", "error", { realm, kind: "totp" });
    throw new AuthRefusal("internal", "auth.secret_unreadable");
  }
  if (step === null) return; // a wrong code: the library refuses it and the after-hook counts it
  // Claim the step in one statement: a request that finds it claimed, by an earlier request or
  // by one committing now (whose row lock this waits on), is a replay.
  const claimed = await tx.query(
    `INSERT INTO ${TABLES[realm].totpStep} AS s (user_id, last_step, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET last_step = EXCLUDED.last_step, updated_at = EXCLUDED.updated_at
       WHERE s.last_step < EXCLUDED.last_step
     RETURNING 1`,
    [prior.person.id, step.toString(), now],
  );
  if (claimed.rowCount === 0) {
    // The same step twice: refused as a wrong code would be, and counted as one.
    state.line.reason = "factor.replayed";
    if (state.finishingAuthenticator) await countFactorLockout(rt, tx, state);
    else await recordFactorFailure(rt, tx, state, "totp");
    throw LIB_ERRORS.invalidCode();
  }
}

/** The last factor stays for staff and privileged developers (§6.7); removals are serialised. */
async function lastFactorRule(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<void> {
  const prior = state.prior;
  if (prior === null) return;
  const realm = rt.settings.realm;
  await personById(tx, realm, prior.person.id, { lock: true });
  const factors = await factorFacts(tx, realm, prior.person.id);
  let removing = 0;
  if (ctx.path === "/two-factor/disable") {
    removing = factors.authenticator ? 1 : 0;
  } else {
    const id = bodyOf(ctx).id;
    const owned = await tx.query(
      `SELECT 1 FROM ${TABLES[realm].passkey} WHERE id = $1 AND user_id = $2`,
      [typeof id === "string" ? id : "", prior.person.id],
    );
    removing = owned.rowCount;
  }
  const keepsOne = factors.count - removing > 0;
  const mustKeep = realm === "staff" || (prior.facts?.privilegedAnywhere ?? false);
  if (!keepsOne && mustKeep) throw new AuthRefusal("last_factor", "gate.last_factor");
  if (ctx.path === "/two-factor/disable") {
    const tfa = await tx.query<{ id: string }>(
      `SELECT id FROM ${TABLES[realm].twoFactor} WHERE user_id = $1`,
      [prior.person.id],
    );
    state.removedTwoFactorId = tfa.rows[0]?.id ?? null;
  }
}

/** The passkey plugin's challenge cookie (its default `advanced.webAuthnChallengeCookie`). */
const PASSKEY_CHALLENGE_COOKIE = "better-auth-passkey";

/** The challenge this browser's live passkey ceremony answers, read without consuming it. */
async function passkeyChallenge(ctx: HookContext, now: Date): Promise<string | null> {
  const cookie = ctx.context.createAuthCookie(PASSKEY_CHALLENGE_COOKIE).name;
  const token = await ctx.getSignedCookie(cookie, ctx.context.secret);
  if (typeof token !== "string" || token === "") return null;
  const found = await ctx.context.internalAdapter.findVerificationValue(token);
  if (found === null || new Date(found.expiresAt).getTime() <= now.getTime()) return null;
  try {
    const data = JSON.parse(found.value) as { type?: unknown; expectedChallenge?: unknown };
    return data.type === "authentication" && typeof data.expectedChallenge === "string"
      ? data.expectedChallenge
      : null;
  } catch {
    return null;
  }
}

/**
 * A signature counter that goes backwards is refused (§5.3, [SA-35]); the library refuses it, and
 * only Fin can tell the person why (`sign-in-methods-changed`, kind `passkey_refused`). The library
 * checks the counter before the signature, so its refusal says nothing about who sent the
 * assertion, and a credential ID is no secret: this only notes the assertion, the credential's key
 * and the challenge the browser holds. The after-hook acts on it only once the assertion verifies
 * against the stored key; an assertion that does not changes nothing and answers as any failure.
 */
async function notePasskeyCounter(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<void> {
  const response = bodyOf(ctx).response as
    | { id?: unknown; response?: { authenticatorData?: unknown } }
    | undefined;
  const credentialId = typeof response?.id === "string" ? response.id : null;
  const authData = response?.response?.authenticatorData;
  if (credentialId === null || typeof authData !== "string") return;
  const bytes = Buffer.from(authData, "base64url");
  if (bytes.byteLength < 37) return;
  const counter = bytes.readUInt32BE(33);
  const realm = rt.settings.realm;
  const stored = await tx.query<{
    counter: number;
    user_id: string;
    email: string;
    public_key: string;
  }>(
    `SELECT p.counter, p.user_id, u.email, p.public_key FROM ${TABLES[realm].passkey} p
       JOIN ${TABLES[realm].user} u ON u.id = p.user_id WHERE p.credential_id = $1`,
    [credentialId],
  );
  const row = stored.rows[0];
  if (row === undefined) return;
  const previous = Number(row.counter);
  if ((counter === 0 && previous === 0) || counter > previous) return;
  const expectedChallenge = await passkeyChallenge(ctx, rt.clock.now());
  if (expectedChallenge === null) return;
  state.passkeyCounter = {
    userId: row.user_id,
    email: row.email,
    publicKey: row.public_key,
    expectedChallenge,
  };
}
