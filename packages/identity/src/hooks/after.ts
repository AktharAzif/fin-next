// `hooks.after` (spec 02 §3.5): runs before the handler returns, in the request's unit of work.
// It records proofs for every factor shown, raises sessions to `aal2`, proves and consumes
// step-up intents, writes the audit events of §16 for the library's actions, queues the security
// emails of §17, keeps known and trusted browsers, and finishes staff enrolment.
import { isAPIError } from "better-auth/api";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { createTrustedBrowser, markTrustedBrowserUsed, touchKnownBrowser } from "../browsers.ts";
import { markCodeUsed } from "../codes.ts";
import { finCookieAttributes, finCookieName } from "../cookies.ts";
import { randomToken } from "../crypto/keyed.ts";
import { assertionVerified } from "../crypto/webauthn.ts";
import { AuthRefusal } from "../errors.ts";
import { personGate, trustedBrowserEligible } from "../gate.ts";
import type { UnitTx } from "../ports/db.ts";
import type { RequestState } from "../request.ts";
import { type RealmRuntime, requestState, unitOf } from "../runtime.ts";
import {
  consumeIntent,
  countStepUpFailure,
  intentIdFrom,
  moveToReplacement,
  proveIntent,
  recordProof,
  resetStepUpFailures,
} from "../step-up/intents.ts";
import type { ProofMethod } from "../step-up/types.ts";
import {
  endSession,
  factorFacts,
  personById,
  raiseAssurance,
  setSessionExpiry,
  TABLES,
} from "../store.ts";
import { bodyOf, type HookContext, headersOf, tokenCookie } from "./context.ts";
import {
  audit,
  countFactorLockout,
  device,
  factorLockKey,
  lockStepUp,
  notify,
  nowIso,
  recordFactorFailure,
  revokeTrust,
  STEP_UP_LOCK_THRESHOLD,
} from "./shared.ts";

const IDLE_MS = { developer: 86_400_000, staff: 3_600_000 } as const;

export async function afterHook(rt: RealmRuntime, ctx: HookContext): Promise<void> {
  const state = requestState(rt);
  const tx = unitOf(rt);
  const returned = ctx.context.returned;
  const failed = isAPIError(returned);
  if (failed) {
    const code = (returned as { body?: { code?: unknown } }).body?.code;
    state.line.outcome = "refused";
    state.line.reason ??=
      typeof code === "string" ? `library.${code.toLowerCase()}` : "library.error";
  }
  switch (ctx.path) {
    case "/sign-in/email-otp":
      return failed ? codeSignInFailed(rt, tx, state, returned) : codeSignedIn(rt, ctx, tx, state);
    case "/passkey/verify-authentication":
      return failed ? passkeyFailed(rt, ctx, tx, state) : passkeySignedIn(rt, ctx, tx, state);
    case "/two-factor/verify-totp":
      return failed
        ? factorFailed(rt, tx, state, "totp")
        : factorPassed(rt, ctx, tx, state, "totp");
    case "/two-factor/verify-backup-code":
      return failed
        ? factorFailed(rt, tx, state, "backup_code")
        : factorPassed(rt, ctx, tx, state, "backup_code");
    case "/passkey/verify-registration":
      return failed ? undefined : passkeyAdded(rt, ctx, tx, state);
    case "/passkey/delete-passkey":
      return failed ? undefined : passkeyRemoved(rt, ctx, tx, state);
    case "/two-factor/enable":
      return failed ? undefined : authenticatorSetUpStarted(rt, ctx, tx, state);
    case "/two-factor/disable":
      return failed ? undefined : authenticatorRemoved(rt, ctx, tx, state);
    case "/two-factor/generate-backup-codes":
      return failed ? undefined : backupCodesRegenerated(rt, tx, state);
    case "/sign-out":
      return failed ? undefined : signedOut(rt, tx, state);
    default:
      return undefined;
  }
}

interface ConsumedIntent {
  id: string;
  method: ProofMethod;
}

/** Consumes the request's intent in the action's transaction; a lost race rolls the action back. */
async function consumeRequestIntent(
  rt: RealmRuntime,
  tx: UnitTx,
  state: RequestState,
): Promise<ConsumedIntent | null> {
  if (state.intent === null) return null;
  const method = await consumeIntent(
    tx,
    state.intent.id,
    state.intent.binding,
    state.context.requestId,
  );
  if (method === null) {
    rt.lines.write("step_up.refused", "warn", {
      realm: state.realm,
      action: state.intent.binding.action,
      reason: "used",
    });
    throw new AuthRefusal(
      "step_up_invalid",
      "step_up.used",
      { reason: "used" },
      { rollback: true },
    );
  }
  state.line.stepUpOutcome = "passed";
  return { id: state.intent.id, method };
}

function stepUpOf(intent: ConsumedIntent | null) {
  return intent === null
    ? undefined
    : { kind: "intent" as const, method: intent.method, ref: intent.id };
}

function intentRefs(intent: ConsumedIntent | null): string[] {
  return intent === null ? [] : [intent.id];
}

async function knownBrowserNotice(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
  person: { id: string; email: string },
  firstSignIn: boolean,
): Promise<void> {
  const cookie = finCookieName("developer", "known_browser");
  const result = await touchKnownBrowser(
    tx,
    rt,
    person.id,
    tokenCookie(ctx, cookie),
    device(state),
    randomToken,
  );
  if (result.setToken !== null) {
    ctx.setCookie(cookie, result.setToken, {
      ...finCookieAttributes("developer", "known_browser"),
    });
  }
  if (!result.known && !firstSignIn) {
    await notify(rt, tx, "identity/new-sign-in", person.email, {
      userId: person.id,
      device: device(state),
      time: nowIso(rt),
    });
  }
}

async function staffSignedIn(
  rt: RealmRuntime,
  tx: UnitTx,
  state: RequestState,
  member: { id: string; email: string },
  sessionId: string,
  method: "passkey" | "totp",
): Promise<void> {
  await audit(rt, tx, state, {
    event: "staff.signed_in",
    personId: member.id,
    target: sessionId,
    refs: [member.id],
    metadata: { method },
  });
  await tx.query("UPDATE staff.member SET last_signed_in_at = $2 WHERE id = $1", [
    member.id,
    rt.clock.now(),
  ]);
  await notify(rt, tx, "staff/staff-new-sign-in", member.email, {
    staffId: member.id,
    device: device(state),
    time: nowIso(rt),
  });
}

/** A code sign-in (§5.1, §5.2, §6.1): `aal1`, at the factor step when the person has a factor. */
async function codeSignedIn(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
): Promise<void> {
  const created = ctx.context.newSession;
  if (created === null || created === undefined) return;
  const sessionId = created.session.id;
  const userId = created.user.id;
  state.line[state.realm === "developer" ? "userId" : "staffId"] = userId;
  state.line.assurance = "aal1";
  if (state.realm === "staff") {
    await audit(rt, tx, state, {
      event: "staff.second_factor_required",
      personId: userId,
      target: sessionId,
      refs: [userId],
      metadata: {},
    });
    // A member with no factor yet is pending (enrolment); one with a factor is at the factor step.
    state.line.gate =
      (await factorFacts(tx, "staff", userId)).count === 0 ? "pending" : "factor_step";
    return;
  }
  const signIn = state.signIn;
  if (signIn?.codeRequestId != null) await markCodeUsed(tx, signIn.codeRequestId, rt.clock.now());
  if (signIn !== null && !signIn.accountExists) state.createdUserId = userId;
  if (state.createdUserId !== null) {
    await audit(rt, tx, state, {
      event: "user.created",
      personId: userId,
      target: userId,
      refs: [sessionId],
      metadata: { method: "email_otp", viaInvitation: false },
    });
    if (signIn?.signUpRequestId != null) {
      await tx.query("UPDATE identity.sign_up_request SET used_at = $2 WHERE id = $1", [
        signIn.signUpRequestId,
        rt.clock.now(),
      ]);
    }
  }
  const facts = await personGate(tx, userId);
  const trusted = signIn?.trustedBrowserId ?? null;
  if (facts.factorCount > 0 && trusted === null) {
    const methods: string[] = [];
    const factors = await tx.query<{ passkeys: number; verified: boolean | null }>(
      `SELECT (SELECT count(*)::integer FROM identity.passkey WHERE user_id = $1) AS passkeys,
              (SELECT verified FROM identity.two_factor WHERE user_id = $1) AS verified`,
      [userId],
    );
    if (Number(factors.rows[0]?.passkeys ?? 0) > 0) methods.push("passkey");
    if (factors.rows[0]?.verified === true) methods.push("authenticator", "backup_code");
    await audit(rt, tx, state, {
      event: "sign_in.second_factor_required",
      personId: userId,
      target: sessionId,
      refs: [userId],
      metadata: { methods },
    });
    state.line.gate = "factor_step";
    return;
  }
  await audit(rt, tx, state, {
    event: "session.created",
    personId: userId,
    target: sessionId,
    refs: [userId, ...(trusted === null ? [] : [trusted])],
    metadata: { method: "email_otp", assurance: "aal1", trustedBrowser: trusted !== null },
  });
  if (trusted !== null) await markTrustedBrowserUsed(tx, trusted, rt.clock.now());
  state.line.gate = facts.factorCount === 0 && facts.privilegedAnywhere ? "hold" : "ok";
  await knownBrowserNotice(rt, ctx, tx, state, created.user, state.createdUserId !== null);
}

async function codeSignInFailed(
  rt: RealmRuntime,
  tx: UnitTx,
  state: RequestState,
  error: unknown,
): Promise<void> {
  const code = (error as { body?: { code?: unknown } }).body?.code;
  const reason =
    code === "OTP_EXPIRED"
      ? "expired"
      : code === "TOO_MANY_ATTEMPTS"
        ? "too_many_tries"
        : "wrong_code";
  if (state.realm === "developer") {
    const email = state.signIn?.email;
    if (email === undefined || state.signIn?.accountExists !== true) return;
    const person = await tx.query<{ id: string }>(
      'SELECT id FROM identity."user" WHERE email = $1',
      [email],
    );
    const id = person.rows[0]?.id;
    if (id === undefined) return;
    await audit(rt, tx, state, {
      event: "sign_in.failed",
      personId: id,
      target: id,
      metadata: { method: "email_otp", reason },
    });
    return;
  }
  const access = state.context.access;
  if (access === null || access === undefined) return;
  const member = await tx.query<{ id: string }>("SELECT id FROM staff.member WHERE email = $1", [
    access.email.toLowerCase(),
  ]);
  const id = member.rows[0]?.id;
  if (id === undefined) return;
  await audit(rt, tx, state, {
    event: "staff.sign_in_failed",
    personId: id,
    target: id,
    metadata: { method: "email_otp", reason },
  });
}

/**
 * A passkey ceremony (§5.3, §6.1, §11.3): an `aal2` session. With a live session of the same
 * person it is a step-up whose new session replaces the old one, keeping its absolute limit; a
 * passkey of another person is refused and its new session deleted (AC-SAT-06).
 */
async function passkeySignedIn(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
): Promise<void> {
  const created = ctx.context.newSession;
  if (created === null || created === undefined) return;
  const realm = state.realm;
  const now = rt.clock.now();
  const newSessionId = created.session.id;
  const userId = created.user.id;
  const prior = state.prior;
  if (prior !== null && prior.person.id !== userId) {
    await endSession(tx, realm, newSessionId, now);
    await audit(rt, tx, state, {
      event: realm === "developer" ? "step_up.failed" : "staff.step_up_failed",
      personId: prior.person.id,
      target: prior.session.id,
      refs: [newSessionId, prior.person.id],
      metadata: { method: "passkey", reason: "other_person" },
    });
    rt.lines.write("step_up.refused", "warn", {
      realm,
      action: "ceremony",
      reason: "other_person",
    });
    // A refused ceremony counts toward the fifth that ends the session (§7.7).
    if ((await countStepUpFailure(tx, realm, prior.session.id)) >= STEP_UP_LOCK_THRESHOLD) {
      await lockStepUp(rt, tx, state);
    }
    throw new AuthRefusal("step_up_invalid", "step_up.other_person", { reason: "other_person" });
  }
  if (realm === "staff") {
    const member = await personById(tx, "staff", userId);
    const access = state.context.access;
    const matches =
      member !== null &&
      member.status !== "removed" &&
      access !== null &&
      access !== undefined &&
      member.email === access.email.toLowerCase();
    if (!matches) {
      await endSession(tx, realm, newSessionId, now);
      rt.lines.write("staff.access_mismatch", "warn", { staffId: userId });
      await audit(rt, tx, state, {
        event: "staff.sign_in_failed",
        personId: userId,
        target: userId,
        refs: [newSessionId],
        metadata: {
          method: "passkey",
          reason: member?.status === "removed" ? "removed" : "access_mismatch",
        },
      });
      throw new AuthRefusal(
        member?.status === "removed" ? "unauthenticated" : "access_mismatch",
        "staff.access_mismatch",
      );
    }
  }
  const intentId = intentIdFrom(headersOf(ctx));
  state.line[realm === "developer" ? "userId" : "staffId"] = userId;
  state.line.assurance = "aal2";
  if (prior !== null && state.gate === "ok") {
    // A step-up: the new session replaces the old one (§11.3).
    await moveToReplacement(tx, realm, prior.session.id, newSessionId);
    await endSession(tx, realm, prior.session.id, now);
    const proofId = await recordProof(tx, rt.clock, realm, {
      userId,
      sessionId: newSessionId,
      method: "passkey",
      intentId,
    });
    const action =
      intentId === null
        ? null
        : await proveIntent(tx, intentId, {
            realm,
            sessionId: newSessionId,
            principalId: userId,
            method: "passkey",
            proofId,
          });
    state.line.stepUp = action === null ? "window" : "intent";
    state.line.stepUpOutcome = "passed";
    await audit(rt, tx, state, {
      event: realm === "developer" ? "step_up.passed" : "staff.step_up_passed",
      personId: userId,
      target: newSessionId,
      refs: [
        userId,
        prior.session.id,
        proofId,
        ...(action === null || intentId === null ? [] : [intentId]),
      ],
      metadata: {
        method: "passkey",
        kind: action === null ? "window" : "intent",
        action,
        intentId: action === null ? null : intentId,
        replacedSessionId: prior.session.id,
      },
    });
    return;
  }
  // A passkey sign-in, or the factor step finished with a passkey: aal2 at once.
  if (prior !== null) {
    await moveToReplacement(tx, realm, prior.session.id, newSessionId);
    await endSession(tx, realm, prior.session.id, now);
  } else {
    state.line.gate = "ok";
  }
  const proofId = await recordProof(tx, rt.clock, realm, {
    userId,
    sessionId: newSessionId,
    method: "passkey",
    intentId: null,
  });
  if (realm === "staff") {
    await staffSignedIn(rt, tx, state, created.user, newSessionId, "passkey");
    return;
  }
  await audit(rt, tx, state, {
    event: "session.created",
    personId: userId,
    target: newSessionId,
    refs: [userId, proofId, ...(prior === null ? [] : [prior.session.id])],
    metadata: { method: "passkey", assurance: "aal2", trustedBrowser: false },
  });
  await knownBrowserNotice(rt, ctx, tx, state, created.user, false);
}

async function passkeyFailed(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
): Promise<void> {
  if (state.prior !== null && state.gate === "ok") {
    await recordFactorFailure(rt, tx, state, "passkey");
  } else {
    const response = bodyOf(ctx).response as { id?: unknown } | undefined;
    const realm = state.realm;
    const owner =
      typeof response?.id === "string"
        ? await tx.query<{ user_id: string }>(
            `SELECT user_id FROM ${TABLES[realm].passkey} WHERE credential_id = $1`,
            [response.id],
          )
        : null;
    const userId = owner?.rows[0]?.user_id;
    if (userId !== undefined) {
      await audit(rt, tx, state, {
        event: realm === "developer" ? "sign_in.failed" : "staff.sign_in_failed",
        personId: userId,
        target: userId,
        metadata: { method: "passkey", reason: "passkey_failed" },
      });
    }
  }
  await passkeyCounterRefused(rt, ctx, tx, state);
}

/**
 * The library refused an assertion whose signature counter did not move forward (§5.3). When the
 * assertion verifies against the credential's stored key, over the challenge this browser holds,
 * the credential really signed it (a clone, or a broken authenticator): the person is told, and
 * the answer says why. An assertion that does not verify is anyone's, and keeps the library's own
 * answer, as any failed ceremony does.
 */
async function passkeyCounterRefused(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
): Promise<void> {
  const noted = state.passkeyCounter;
  if (noted === null) return;
  const verified = assertionVerified({
    publicKey: noted.publicKey,
    response: bodyOf(ctx).response,
    expectedChallenge: noted.expectedChallenge,
    expectedOrigin: rt.settings.publicOrigin,
    rpId: rt.settings.rpId,
  });
  if (!verified) return;
  if (state.realm === "developer") {
    await notify(rt, tx, "identity/sign-in-methods-changed", noted.email, {
      userId: noted.userId,
      kind: "passkey_refused",
      time: nowIso(rt),
    });
  }
  throw new AuthRefusal("forbidden", "passkey.counter_regressed", { reason: "passkey_refused" });
}

async function factorFailed(
  rt: RealmRuntime,
  tx: UnitTx,
  state: RequestState,
  method: "totp" | "backup_code",
): Promise<void> {
  if (state.finishingAuthenticator) {
    // A wrong code while finishing a set-up counts toward the person's lockout like any other
    // (§5.4). It is neither the factor step nor a step-up, so it writes neither failure event.
    await countFactorLockout(rt, tx, state);
    return;
  }
  await recordFactorFailure(rt, tx, state, method);
}

async function backupCodesLeft(ctx: HookContext, tx: UnitTx, userId: string): Promise<number> {
  const row = await tx.query<{ backup_codes: string }>(
    "SELECT backup_codes FROM identity.two_factor WHERE user_id = $1",
    [userId],
  );
  const stored = row.rows[0]?.backup_codes;
  if (stored === undefined) return 0;
  const plain = await symmetricDecrypt({
    key: ctx.context.secretConfig as Parameters<typeof symmetricDecrypt>[0]["key"],
    data: stored,
  });
  const codes: unknown = JSON.parse(plain);
  return Array.isArray(codes) ? codes.length : 0;
}

/**
 * A right TOTP or backup code (§5.4, §6.1, §6.5, §7.4): it finishes an authenticator's set-up
 * (raising the session, and enrolling a pending staff member), or finishes the factor step, or
 * passes a step-up.
 */
async function factorPassed(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
  method: "totp" | "backup_code",
): Promise<void> {
  const prior = state.prior;
  if (prior === null) return;
  const realm = state.realm;
  const now = rt.clock.now();
  const userId = prior.person.id;
  const replacement = ctx.context.newSession?.session.id ?? null;
  const sessionId = replacement ?? prior.session.id;
  // The code's TOTP step was claimed in the before-hook, before the library checked the code.
  await rt.limits.clearFailures(tx, factorLockKey(state, userId));
  state.line.assurance = "aal2";

  if (state.finishingAuthenticator && method === "totp") {
    const tfa = await tx.query<{ id: string }>(
      `SELECT id FROM ${TABLES[realm].twoFactor} WHERE user_id = $1`,
      [userId],
    );
    const tfaId = tfa.rows[0]?.id ?? userId;
    const refs = [userId, sessionId, ...(replacement === null ? [] : [prior.session.id])];
    if (realm === "developer") {
      await audit(rt, tx, state, {
        event: "two_factor.enabled",
        personId: userId,
        target: tfaId,
        refs,
        metadata: {},
      });
      await raiseAssurance(tx, realm, sessionId, now);
      await recordProof(tx, rt.clock, realm, { userId, sessionId, method: "totp", intentId: null });
      await revokeTrust(rt, tx, state, userId, "factor_changed");
      await notify(rt, tx, "identity/sign-in-methods-changed", prior.person.email, {
        userId,
        kind: "authenticator_on",
        device: device(state),
        time: nowIso(rt),
      });
      return;
    }
    if (prior.person.status === "pending") {
      await enrolStaff(rt, tx, state, userId, sessionId, tfaId, "totp", refs);
      return;
    }
    await audit(rt, tx, state, {
      event: "staff.factor_added",
      personId: userId,
      target: tfaId,
      refs,
      metadata: { method: "totp" },
    });
    await notify(rt, tx, "staff/staff-sign-in-methods-changed", prior.person.email, {
      staffId: userId,
      kind: "authenticator_on",
      time: nowIso(rt),
    });
    return;
  }

  if (state.gate !== "ok") {
    // The factor step: this session becomes a working aal2 session.
    await raiseAssurance(tx, realm, sessionId, now);
    await setSessionExpiry(tx, realm, sessionId, new Date(now.getTime() + IDLE_MS[realm]), now);
    const proofId = await recordProof(tx, rt.clock, realm, {
      userId,
      sessionId,
      method,
      intentId: null,
    });
    if (realm === "staff") {
      await staffSignedIn(rt, tx, state, prior.person, sessionId, "totp");
      return;
    }
    await audit(rt, tx, state, {
      event: "session.created",
      personId: userId,
      target: sessionId,
      refs: [userId, proofId],
      metadata: { method, assurance: "aal2", trustedBrowser: false },
    });
    if (method === "backup_code") {
      await audit(rt, tx, state, {
        event: "backup_code.used",
        personId: userId,
        target: userId,
        refs: [sessionId],
        metadata: { remaining: await backupCodesLeft(ctx, tx, userId) },
      });
    }
    await knownBrowserNotice(rt, ctx, tx, state, prior.person, false);
    if (state.trustDevice && method === "totp")
      await trustThisBrowser(rt, ctx, tx, state, prior.person);
    return;
  }

  // A step-up: a proof in this session, and the named intent proved (§7.4).
  const intentId = intentIdFrom(headersOf(ctx));
  const proofId = await recordProof(tx, rt.clock, realm, { userId, sessionId, method, intentId });
  const action =
    intentId === null
      ? null
      : await proveIntent(tx, intentId, { realm, sessionId, principalId: userId, method, proofId });
  await resetStepUpFailures(tx, realm, sessionId);
  state.line.stepUp = action === null ? "window" : "intent";
  state.line.stepUpOutcome = "passed";
  await audit(rt, tx, state, {
    event: realm === "developer" ? "step_up.passed" : "staff.step_up_passed",
    personId: userId,
    target: sessionId,
    refs: [userId, proofId, ...(action === null || intentId === null ? [] : [intentId])],
    metadata: {
      method,
      kind: action === null ? "window" : "intent",
      action,
      intentId: action === null ? null : intentId,
      replacedSessionId: null,
    },
  });
  if (method === "backup_code") {
    await audit(rt, tx, state, {
      event: "backup_code.used",
      personId: userId,
      target: userId,
      refs: [sessionId],
      metadata: { remaining: await backupCodesLeft(ctx, tx, userId) },
    });
  }
}

/** Trusted browsers ([SA-31], §6.6): only for a person who is not privileged anywhere. */
async function trustThisBrowser(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
  person: { id: string; email: string },
): Promise<void> {
  const facts = await personGate(tx, person.id);
  if (!trustedBrowserEligible(facts)) return;
  const token = randomToken();
  const id = await createTrustedBrowser(tx, rt, person.id, token, device(state));
  ctx.setCookie(finCookieName("developer", "trusted_browser"), token, {
    ...finCookieAttributes("developer", "trusted_browser"),
  });
  await audit(rt, tx, state, {
    event: "browser.trusted",
    personId: person.id,
    target: id,
    refs: [person.id],
    metadata: {},
  });
  await notify(rt, tx, "identity/sign-in-methods-changed", person.email, {
    userId: person.id,
    kind: "browser_trusted",
    device: device(state),
    time: nowIso(rt),
  });
}

/** A pending staff member's first factor (§6.5): active, `aal2`, and every Admin told. */
async function enrolStaff(
  rt: RealmRuntime,
  tx: UnitTx,
  state: RequestState,
  memberId: string,
  sessionId: string,
  factorId: string,
  method: "passkey" | "totp",
  refs: readonly string[],
): Promise<void> {
  const now = rt.clock.now();
  const code = await tx.query<{ id: string }>(
    `SELECT id FROM staff.enrolment_code WHERE member_id = $1 AND redeemed_session_id = $2
      ORDER BY redeemed_at DESC LIMIT 1`,
    [memberId, state.prior?.session.id ?? sessionId],
  );
  const enrolmentCodeId = code.rows[0]?.id;
  await audit(rt, tx, state, {
    event: "staff.factor_enrolled",
    personId: memberId,
    target: memberId,
    refs: [factorId, ...refs, ...(enrolmentCodeId === undefined ? [] : [enrolmentCodeId])],
    metadata: { method },
  });
  await tx.query(
    `UPDATE staff.member SET status = 'active', factor_enrolled_at = $2, last_signed_in_at = $2, updated_at = $2
      WHERE id = $1 AND status = 'pending'`,
    [memberId, now],
  );
  await raiseAssurance(tx, "staff", sessionId, now);
  await setSessionExpiry(tx, "staff", sessionId, new Date(now.getTime() + IDLE_MS.staff), now);
  await recordProof(tx, rt.clock, "staff", { userId: memberId, sessionId, method, intentId: null });
  rt.lines.write("staff.enrolled", "warn", { staffId: memberId, method });
  const admins = await tx.query<{ email: string }>(
    "SELECT email FROM staff.member WHERE role_key = 'admin' AND status = 'active'",
  );
  for (const admin of admins.rows) {
    await notify(rt, tx, "staff/staff-factor-enrolled", admin.email, {
      staffId: memberId,
      method,
      time: now.toISOString(),
    });
  }
}

async function passkeyAdded(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
): Promise<void> {
  const prior = state.prior;
  const added = ctx.context.returned as { id?: unknown } | undefined;
  if (prior === null || typeof added?.id !== "string") return;
  const realm = state.realm;
  const now = rt.clock.now();
  const userId = prior.person.id;
  const sessionId = prior.session.id;
  const intent = await consumeRequestIntent(rt, tx, state);
  const first = prior.factors.count === 0;
  const refs = [userId, sessionId, ...intentRefs(intent)];
  const stepUp = stepUpOf(intent);
  if (realm === "developer") {
    await audit(rt, tx, state, {
      event: "passkey.added",
      personId: userId,
      target: added.id,
      refs,
      metadata: {},
      ...(stepUp === undefined
        ? {}
        : { actor: { kind: "user", id: userId, via: "console", stepUp } }),
    });
    if (first) {
      await raiseAssurance(tx, realm, sessionId, now);
      await recordProof(tx, rt.clock, realm, {
        userId,
        sessionId,
        method: "passkey",
        intentId: null,
      });
    }
    await revokeTrust(rt, tx, state, userId, "factor_changed");
    await notify(rt, tx, "identity/sign-in-methods-changed", prior.person.email, {
      userId,
      kind: "passkey_added",
      device: device(state),
      time: nowIso(rt),
    });
    return;
  }
  if (prior.person.status === "pending") {
    await enrolStaff(rt, tx, state, userId, sessionId, added.id, "passkey", refs);
    return;
  }
  await audit(rt, tx, state, {
    event: "staff.factor_added",
    personId: userId,
    target: added.id,
    refs,
    metadata: { method: "passkey" },
    ...(stepUp === undefined ? {} : { actor: { kind: "staff", id: userId, via: "admin", stepUp } }),
  });
  await notify(rt, tx, "staff/staff-sign-in-methods-changed", prior.person.email, {
    staffId: userId,
    kind: "passkey_added",
    time: nowIso(rt),
  });
}

async function passkeyRemoved(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
): Promise<void> {
  const prior = state.prior;
  const id = bodyOf(ctx).id;
  if (prior === null || typeof id !== "string") return;
  const intent = await consumeRequestIntent(rt, tx, state);
  const userId = prior.person.id;
  const refs = [userId, ...intentRefs(intent)];
  const stepUp = stepUpOf(intent);
  if (state.realm === "developer") {
    await audit(rt, tx, state, {
      event: "passkey.removed",
      personId: userId,
      target: id,
      refs,
      metadata: {},
      ...(stepUp === undefined
        ? {}
        : { actor: { kind: "user", id: userId, via: "console", stepUp } }),
    });
    await revokeTrust(rt, tx, state, userId, "factor_changed");
    await notify(rt, tx, "identity/sign-in-methods-changed", prior.person.email, {
      userId,
      kind: "passkey_removed",
      device: device(state),
      time: nowIso(rt),
    });
    return;
  }
  await audit(rt, tx, state, {
    event: "staff.factor_removed",
    personId: userId,
    target: id,
    refs,
    metadata: { method: "passkey" },
  });
  await notify(rt, tx, "staff/staff-sign-in-methods-changed", prior.person.email, {
    staffId: userId,
    kind: "passkey_removed",
    time: nowIso(rt),
  });
}

async function authenticatorSetUpStarted(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
): Promise<void> {
  const prior = state.prior;
  if (prior === null) return;
  const intent = await consumeRequestIntent(rt, tx, state);
  const userId = prior.person.id;
  const refs = intentRefs(intent);
  if (state.realm === "developer") {
    await audit(rt, tx, state, {
      event: "two_factor.setup_started",
      personId: userId,
      target: userId,
      refs,
      metadata: {},
    });
    return;
  }
  // Staff have no backup codes (S2-03): none is answered, and the stored list is empty.
  const returned = ctx.context.returned as { backupCodes?: unknown } | undefined;
  if (returned !== undefined && returned !== null && "backupCodes" in returned)
    delete returned.backupCodes;
  const empty = await symmetricEncrypt({
    key: ctx.context.secretConfig as Parameters<typeof symmetricEncrypt>[0]["key"],
    data: "[]",
  });
  await tx.query("UPDATE staff.two_factor SET backup_codes = $2 WHERE user_id = $1", [
    userId,
    empty,
  ]);
  await audit(rt, tx, state, {
    event: "staff.factor_setup_started",
    personId: userId,
    target: userId,
    refs,
    metadata: { method: "totp" },
  });
}

async function authenticatorRemoved(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
): Promise<void> {
  const prior = state.prior;
  if (prior === null) return;
  const intent = await consumeRequestIntent(rt, tx, state);
  const userId = prior.person.id;
  const replacement = ctx.context.newSession?.session.id ?? null;
  const tfaId = state.removedTwoFactorId ?? userId;
  const refs = [
    userId,
    prior.session.id,
    ...(replacement === null ? [] : [replacement]),
    ...intentRefs(intent),
  ];
  if (state.realm === "developer") {
    await audit(rt, tx, state, {
      event: "two_factor.disabled",
      personId: userId,
      target: tfaId,
      refs,
      metadata: {},
    });
    await revokeTrust(rt, tx, state, userId, "factor_changed");
    await notify(rt, tx, "identity/sign-in-methods-changed", prior.person.email, {
      userId,
      kind: "authenticator_off",
      device: device(state),
      time: nowIso(rt),
    });
    return;
  }
  await audit(rt, tx, state, {
    event: "staff.factor_removed",
    personId: userId,
    target: tfaId,
    refs,
    metadata: { method: "totp" },
  });
  await notify(rt, tx, "staff/staff-sign-in-methods-changed", prior.person.email, {
    staffId: userId,
    kind: "authenticator_off",
    time: nowIso(rt),
  });
}

async function backupCodesRegenerated(
  rt: RealmRuntime,
  tx: UnitTx,
  state: RequestState,
): Promise<void> {
  const prior = state.prior;
  if (prior === null) return;
  const intent = await consumeRequestIntent(rt, tx, state);
  const userId = prior.person.id;
  await audit(rt, tx, state, {
    event: "backup_codes.regenerated",
    personId: userId,
    target: userId,
    refs: intentRefs(intent),
    metadata: {},
  });
  await notify(rt, tx, "identity/sign-in-methods-changed", prior.person.email, {
    userId,
    kind: "backup_codes_regenerated",
    device: device(state),
    time: nowIso(rt),
  });
}

async function signedOut(rt: RealmRuntime, tx: UnitTx, state: RequestState): Promise<void> {
  const prior = state.prior;
  if (prior === null) return;
  const userId = prior.person.id;
  if (state.realm === "developer") {
    await audit(rt, tx, state, {
      event: "session.ended",
      personId: userId,
      target: prior.session.id,
      refs: [userId],
      metadata: { reason: "signed_out" },
    });
    return;
  }
  await audit(rt, tx, state, {
    event: "staff.signed_out",
    personId: userId,
    target: prior.session.id,
    refs: [userId],
    metadata: {},
  });
}
