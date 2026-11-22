// What each sign-in answer means for the screen (AdminSignIn, AdminSecondFactor, AdminStepUp). The
// realm answers its own codes for a wrong or used code and Fin's problem documents for limits and
// gates; these sort them into the boards' states. Anything not listed is "failed", which the
// screens show as Fin's side going wrong, never as the person's mistake.
import { type ApiError, isApiError } from "@fin/frame";
import { type AuthAnswer, type AuthFailure, failureCode, problemField } from "./http.ts";

/** A limit or the realm's account lockout: the session lives on, and the person waits. */
export function isLimit(failure: AuthFailure): boolean {
  const code = failureCode(failure);
  return (
    code === "rate_limited" ||
    code === "ACCOUNT_TEMPORARILY_LOCKED" ||
    (failure.kind !== "network" && failure.kind !== "access" && failure.status === 429)
  );
}

function signedOut(failure: AuthFailure): boolean {
  return failure.kind === "problem" && failure.problem.code === "unauthenticated";
}

/**
 * The session is gone (spec 02 §14.1): a `401` for any reason (its 10 minutes at `aal1` ran out,
 * it was signed out, or too many wrong tries ended it), or the Access identity no longer matching
 * the member, which ends it too (§10.5). No new code helps; the person signs in again.
 */
export function sessionEnded(failure: AuthFailure): boolean {
  if (failure.kind !== "problem") return false;
  return (
    failure.status === 401 ||
    failure.problem.code === "unauthenticated" ||
    failure.problem.code === "access_mismatch"
  );
}

export type SendOutcome = "sent" | "notWork" | "tooManyCodes" | "offline" | "failed";

/** `/email-otp/send-verification-otp`: the same answer for every address, or a limit. */
export function sendOutcome(answer: AuthAnswer): SendOutcome {
  if (answer.ok) return "sent";
  if (answer.kind === "network" || answer.kind === "access") return "offline";
  if (isLimit(answer)) return "tooManyCodes";
  if (failureCode(answer) === "invalid") return "notWork";
  return "failed";
}

export type CodeOutcome = "signedIn" | "wrong" | "expired" | "locked" | "offline" | "failed";

/** `/sign-in/email-otp`. */
export function codeOutcome(answer: AuthAnswer): CodeOutcome {
  if (answer.ok) return "signedIn";
  if (answer.kind === "network" || answer.kind === "access") return "offline";
  if (isLimit(answer)) return "locked";
  if (signedOut(answer) && problemField(answer, "reason") === "too_many_tries") return "locked";
  const code = failureCode(answer);
  if (code === "INVALID_OTP" || code === "INVALID_CODE") return "wrong";
  // Three wrong tries use a code up: like an expired one, the person asks for a new one.
  if (code === "OTP_EXPIRED" || code === "TOO_MANY_ATTEMPTS") return "expired";
  return "failed";
}

/**
 * - `limited`: a limit or the realm's account lockout (`429`, spec 02 §5.4, §5.6). The session
 *   lives on; the person waits. Nothing was signed out.
 * - `tooManyTries`: the fifth wrong try at a step-up ended the session (`401` with
 *   `reason: too_many_tries`, §7.7).
 * - `signedOut`: the session ended for another reason; the person signs in again.
 */
export type FactorOutcome =
  | "done"
  | "wrong"
  | "limited"
  | "tooManyTries"
  | "signedOut"
  | "offline"
  | "failed";

/** `/two-factor/verify-totp` at the factor step, at a step-up, or finishing a set-up. */
export function factorOutcome(answer: AuthAnswer): FactorOutcome {
  if (answer.ok) return "done";
  if (answer.kind === "network" || answer.kind === "access") return "offline";
  if (isLimit(answer)) return "limited";
  if (sessionEnded(answer)) {
    return signedOut(answer) && problemField(answer, "reason") === "too_many_tries"
      ? "tooManyTries"
      : "signedOut";
  }
  const code = failureCode(answer);
  if (code === "INVALID_CODE" || code === "INVALID_TWO_FACTOR_CODE" || code === "INVALID_OTP") {
    return "wrong";
  }
  return "failed";
}

/**
 * A pending member's registration refused because the enrolment window is not open (it closed
 * after 10 minutes, or the code was never redeemed in this session): the code step comes again.
 */
export function enrolmentWindowClosed(answer: AuthAnswer): boolean {
  return !answer.ok && problemField(answer, "reason") === "enrolment_code_required";
}

export type EnrolmentOutcome =
  | "wrong"
  | "expired"
  | "used"
  | "tooMany"
  | "signedOut"
  | "offline"
  | "failed";

/**
 * `POST /api/enrolment/redeem`'s refusals (spec 02 §6.5): a wrong code, one past its 30 minutes,
 * one already used or voided (five wrong tries void it), or the limit. The session's own end comes
 * first: a `401` (its 10 minutes at `aal1` are shorter than the code's 30, §6.4) or an Access
 * mismatch carries a `reason` of its own, which says nothing about the code.
 */
export function enrolmentOutcome(error: unknown): EnrolmentOutcome {
  if (!isApiError(error)) return "failed";
  if (error.kind !== "problem") return "offline";
  if (
    error.status === 401 ||
    error.code === "unauthenticated" ||
    error.code === "access_required" ||
    error.code === "access_mismatch"
  ) {
    return "signedOut";
  }
  const reason = (error.problem as Record<string, unknown> | null)?.reason;
  if (error.status === 429) return "tooMany";
  if (reason === "expired") return "expired";
  // `not_pending`: the member already has a factor, so their code was used.
  if (reason === "used" || reason === "void" || reason === "not_pending") return "used";
  if (reason === "wrong" || error.code === "invalid") return "wrong";
  if (error.status !== null && error.status >= 400 && error.status < 500) return "wrong";
  return "failed";
}

/** The request ID of a failure, for "Something went wrong" (never any value of the request). */
export function requestIdOf(error: ApiError | AuthFailure | unknown): string | null {
  if (isApiError(error)) return error.requestId;
  if (typeof error === "object" && error !== null && "kind" in error) {
    const failure = error as AuthFailure;
    if (failure.kind === "problem") return failure.problem.request_id ?? null;
  }
  return null;
}
