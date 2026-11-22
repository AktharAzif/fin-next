// What a failed call means for the page (spec 02 §14.1; the boards' failure alerts): one kind per
// sentence a board draws. The code is read from Fin's problem document, or from the library's own
// error body where a ceremony client lifted it (api/library.ts). Never a value from the request.
import { isApiError } from "@fin/frame";

export type Failure =
  /** The browser is offline, or the request never got an answer. */
  | "offline"
  /** A Fin rate limit, or the library's own. */
  | "rateLimited"
  /** A wrong code (an emailed code, an authenticator or backup code). */
  | "wrongCode"
  /** An emailed code past its 15 minutes, or already used. */
  | "expired"
  /** The code's tries are used up: three wrong tries cancel an emailed code. */
  | "usedUp"
  /** The authenticator lockout: authenticator and backup codes are paused for an hour. */
  | "paused"
  /** The passkey is not on the account any more. */
  | "passkeyRemoved"
  /** A passkey ceremony the server refused. */
  | "passkeyRefused"
  /** No live session (signed out, or ended after too many tries at a step-up). */
  | "signedOut"
  /** The role does not allow it (`forbidden`, `outranked`, `giving_refused`). */
  | "notAllowed"
  /** A stale version or a concurrent change. */
  | "conflict"
  /** A field the server refused (`invalid`). */
  | "invalid"
  /** The thing is gone, or was never visible to this person. */
  | "notFound"
  /** A kill switch (`paused`): sign-ups are paused. */
  | "switchedOff"
  /** Fin's side failed, or answered something that is not Fin's. */
  | "ourSide";

const LIBRARY: Readonly<Record<string, Failure>> = {
  INVALID_OTP: "wrongCode",
  INVALID_CODE: "wrongCode",
  INVALID_TWO_FACTOR_CODE: "wrongCode",
  INVALID_BACKUP_CODE: "wrongCode",
  OTP_EXPIRED: "expired",
  TOO_MANY_ATTEMPTS: "usedUp",
  ACCOUNT_TEMPORARILY_LOCKED: "paused",
  PASSKEY_NOT_FOUND: "passkeyRemoved",
  AUTHENTICATION_FAILED: "passkeyRefused",
  CHALLENGE_NOT_FOUND: "passkeyRefused",
  FAILED_TO_VERIFY_REGISTRATION: "passkeyRefused",
};

const FIN: Readonly<Record<string, Failure>> = {
  rate_limited: "rateLimited",
  unauthenticated: "signedOut",
  forbidden: "notAllowed",
  outranked: "notAllowed",
  giving_refused: "notAllowed",
  conflict: "conflict",
  invalid: "invalid",
  not_found: "notFound",
  invitation_unusable: "notFound",
  paused: "switchedOff",
};

export function failureOf(error: unknown): Failure {
  if (!isApiError(error)) return "ourSide";
  if (error.kind === "network") return "offline";
  const code = error.code;
  if (code !== null) {
    const library = LIBRARY[code];
    if (library !== undefined) return library;
    const fin = FIN[code];
    if (fin !== undefined) return fin;
    if (error.status === 429) return "rateLimited";
  }
  if (error.status === 429) return "rateLimited";
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  return "ourSide";
}

/** The problem's own extension, when the answer carried one (`problem: beyond`, `limit`). */
export function problemField(error: unknown, field: string): unknown {
  if (!isApiError(error) || error.problem === null) return undefined;
  return (error.problem as Record<string, unknown>)[field];
}

/** The answer's code, or null (a network failure, or not Fin's answer). */
export function codeOf(error: unknown): string | null {
  return isApiError(error) ? error.code : null;
}

/** The request ID support needs, when the answer had one. */
export function requestIdOf(error: unknown): string | undefined {
  return isApiError(error) && error.requestId !== null ? error.requestId : undefined;
}

/** The InlineAlert a board draws for a failure that is not the page's own. */
export interface FailureAlert {
  tone: "warning" | "danger";
  title: string;
  body?: string;
  live: "polite" | "assertive";
}

/** The boards' shared alerts: offline, too many tries, our side, that didn't work. */
export function commonAlert(failure: Failure): FailureAlert {
  switch (failure) {
    case "offline":
      return {
        tone: "warning",
        title: "You’re offline.",
        body: "Check your connection and try again.",
        live: "polite",
      };
    case "rateLimited":
      return {
        tone: "warning",
        title: "Too many attempts. Try again in a few minutes.",
        live: "polite",
      };
    case "ourSide":
      return {
        tone: "danger",
        title: "Something went wrong on our side.",
        body: "Try again in a moment.",
        live: "assertive",
      };
    default:
      return {
        tone: "danger",
        title: "That didn’t work.",
        body: "Try again in a moment.",
        live: "assertive",
      };
  }
}

/** The fields a `400 invalid` names (`fields: [{ path, code }]`, never the values). */
export function invalidFields(error: unknown): Set<string> {
  const fields = problemField(error, "fields");
  const named = new Set<string>();
  if (!Array.isArray(fields)) return named;
  for (const field of fields) {
    if (typeof field !== "object" || field === null) continue;
    const path = (field as Record<string, unknown>).path;
    if (typeof path === "string") named.add(path.split(".")[0] ?? path);
    else if (Array.isArray(path) && typeof path[0] === "string") named.add(path[0]);
  }
  return named;
}
