// Helpers the before- and after-hooks share: the actor, the audit context, notices, factor
// failure lockouts and trusted-browser revocation.
import { APIError } from "better-auth/api";
import type { RealmEventName } from "../audit/events.ts";
import type { AuditActor, AuditInput } from "../audit/record.ts";
import { revokeTrustedBrowsers, type TrustRevokedReason } from "../browsers.ts";
import { deviceSummary } from "../device.ts";
import type { RealmTemplateName } from "../email/templates.ts";
import { DAY, HOUR } from "../ports/clock.ts";
import type { UnitTx } from "../ports/db.ts";
import type { RequestState } from "../request.ts";
import type { RealmRuntime } from "../runtime.ts";
import { countStepUpFailure } from "../step-up/intents.ts";
import { endSession } from "../store.ts";

export const FACTOR_LOCK_THRESHOLD = 10;
export const FACTOR_LOCK_MS = HOUR;
export const STEP_UP_LOCK_THRESHOLD = 5;

export function actorOf(state: RequestState, personId: string): AuditActor {
  return state.realm === "developer"
    ? { kind: "user", id: personId, via: "console" }
    : { kind: "staff", id: personId, via: "admin" };
}

export async function audit(
  rt: RealmRuntime,
  tx: UnitTx,
  state: RequestState,
  input: Omit<AuditInput, "actor" | "context" | "subjectUserId"> & {
    event: RealmEventName;
    personId: string;
    actor?: AuditActor;
  },
): Promise<void> {
  const { personId, actor, ...rest } = input;
  await rt.audit(tx, {
    ...rest,
    actor: actor ?? actorOf(state, personId),
    ...(state.realm === "developer" ? { subjectUserId: personId } : {}),
    context: { clientIp: state.context.clientIp, userAgent: state.context.userAgent },
  });
}

export async function notify(
  rt: RealmRuntime,
  tx: UnitTx,
  template: RealmTemplateName,
  to: string,
  params: Record<string, unknown>,
): Promise<void> {
  await rt.email(tx, { template, to, params });
}

export function device(state: RequestState): string {
  return deviceSummary(state.context.userAgent);
}

export function nowIso(rt: RealmRuntime): string {
  return rt.clock.now().toISOString();
}

export function factorLockKey(state: RequestState, personId: string): string {
  return `factor:${state.realm}:${personId}`;
}

/** Library-shaped errors, so a Fin refusal at a library path looks like the library's own. */
export const LIB_ERRORS = {
  invalidOtp: () => APIError.from("BAD_REQUEST", { code: "INVALID_OTP", message: "Invalid OTP" }),
  tooManyOtpAttempts: () =>
    APIError.from("FORBIDDEN", { code: "TOO_MANY_ATTEMPTS", message: "Too many attempts" }),
  invalidCode: () =>
    APIError.from("UNAUTHORIZED", { code: "INVALID_CODE", message: "Invalid code" }),
  locked: () =>
    APIError.from("TOO_MANY_REQUESTS", {
      code: "ACCOUNT_TEMPORARILY_LOCKED",
      message: "Account temporarily locked due to too many failed attempts",
    }),
};

/**
 * A wrong second-factor code (or a refused replay): counts toward the person's lockout (10 wrong
 * codes, one hour, kept in the logged table because the library's own lockout covers only its
 * password challenge on 1.7.25), writes the failure event, and at a step-up counts toward ending
 * the session (§5.4, §7.7).
 */
export async function recordFactorFailure(
  rt: RealmRuntime,
  tx: UnitTx,
  state: RequestState,
  method: "totp" | "backup_code" | "passkey",
): Promise<void> {
  const prior = state.prior;
  if (prior === null) return;
  const personId = prior.person.id;
  const sessionId = prior.session.id;
  const now = rt.clock.now();
  if (method !== "passkey") {
    const failure = await rt.limits.recordFailure(
      tx,
      factorLockKey(state, personId),
      "factor_code",
      FACTOR_LOCK_THRESHOLD,
      FACTOR_LOCK_MS,
    );
    if (failure.justLocked && failure.lockedUntil !== null && state.realm === "developer") {
      await audit(rt, tx, state, {
        event: "sign_in.locked",
        personId,
        target: personId,
        refs: [sessionId],
        metadata: { until: failure.lockedUntil.toISOString() },
      });
      const daily = `account_locked_email:${personId}`;
      if ((await rt.limits.lockedUntil(tx, daily)) === null) {
        await rt.limits.lock(tx, daily, "account_locked_email", new Date(now.getTime() + DAY));
        await notify(rt, tx, "identity/account-locked", prior.person.email, {
          userId: personId,
          until: failure.lockedUntil.toISOString(),
        });
      }
    }
  }
  if (state.gate !== "ok") {
    if (state.realm === "developer") {
      await audit(rt, tx, state, {
        event: "sign_in.second_factor_failed",
        personId,
        target: personId,
        refs: [sessionId],
        metadata: { method: method === "passkey" ? "passkey" : method },
      });
    } else {
      await audit(rt, tx, state, {
        event: "staff.sign_in_failed",
        personId,
        target: personId,
        refs: [sessionId],
        metadata: { method: method === "backup_code" ? "totp" : method, reason: "wrong_code" },
      });
    }
    return;
  }
  // A wrong code or a failed passkey at a step-up (§7.7).
  await audit(rt, tx, state, {
    event: state.realm === "developer" ? "step_up.failed" : "staff.step_up_failed",
    personId,
    target: sessionId,
    refs: [personId],
    metadata: { method, reason: method === "passkey" ? "passkey_failed" : "wrong_code" },
  });
  const failures = await countStepUpFailure(tx, state.realm, sessionId);
  if (failures >= STEP_UP_LOCK_THRESHOLD) await lockStepUp(rt, tx, state);
}

/** The fifth wrong try at a step-up ends the session (§7.7). */
export async function lockStepUp(rt: RealmRuntime, tx: UnitTx, state: RequestState): Promise<void> {
  const prior = state.prior;
  if (prior === null) return;
  const now = rt.clock.now();
  await endSession(tx, state.realm, prior.session.id, now, { tooManyTries: true });
  rt.lines.write("step_up.locked", "warn", { realm: state.realm });
  await audit(rt, tx, state, {
    event: state.realm === "developer" ? "step_up.locked" : "staff.step_up_locked",
    personId: prior.person.id,
    target: prior.session.id,
    refs: [prior.person.id],
    metadata: {},
  });
  if (state.realm === "developer") {
    await audit(rt, tx, state, {
      event: "session.ended",
      personId: prior.person.id,
      target: prior.session.id,
      refs: [prior.person.id],
      metadata: { reason: "step_up_locked" },
    });
    await notify(rt, tx, "identity/session-ended", prior.person.email, {
      userId: prior.person.id,
      reason: "too_many_tries",
      time: now.toISOString(),
    });
  }
}

/** Revokes a person's trusted browsers with a reason, one `browser.trust_revoked` each (§6.6). */
export async function revokeTrust(
  rt: RealmRuntime,
  tx: UnitTx,
  state: RequestState,
  personId: string,
  reason: TrustRevokedReason,
): Promise<number> {
  if (state.realm !== "developer") return 0;
  const revoked = await revokeTrustedBrowsers(tx, personId, reason, rt.clock.now());
  for (const id of revoked) {
    await audit(rt, tx, state, {
      event: "browser.trust_revoked",
      personId,
      target: id,
      refs: [personId],
      metadata: { reason },
    });
  }
  return revoked.length;
}
