// "Continue with Google" on AdminSignIn (spec 02 §5.8, stretch 5; spec 06's googleFailed and
// noGoogle states): the call that starts the round trip, where it comes back to, and what a refused
// round trip says. The staff realm decides everything that matters (the state, PKCE, the nonce,
// the exact redirect URI, the Workspace domain, the staff list, the Access identity); the page only
// offers the button when the viewer says staff Google is on, and sends the browser to the
// provider's address the realm answered. A Google sign-in is a first factor only: the realm sends
// the browser back to `/sign-in`, which goes on to the factor step or enrolment.
import { type AuthAnswer, type AuthTransport, authRequest } from "./http.ts";

/** Where every staff round trip comes back to, success or refusal (the realm accepts no other). */
export const GOOGLE_RETURN = "/sign-in";

/** Starts a staff Google round trip: the realm answers the provider's address (redirect only). */
export function startGoogle(transport?: AuthTransport): Promise<AuthAnswer> {
  return authRequest(
    {
      method: "POST",
      path: "/sign-in/social",
      body: {
        provider: "google",
        callbackURL: GOOGLE_RETURN,
        errorCallbackURL: GOOGLE_RETURN,
        disableRedirect: true,
      },
    },
    transport,
  );
}

/**
 * The provider's address in the realm's answer, when it is one the browser may be sent to: https,
 * or plain http on loopback (the fixture provider in development and test).
 */
export function providerUrl(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as { url?: unknown }).url;
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") return url.href;
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  return url.protocol === "http:" && loopback ? url.href : null;
}

/**
 * The refusals a staff round trip comes back with as `?error=`: Fin's own (`account_refused`: not
 * the Workspace, not on the staff list, or not the address Access let in; `email_unverified`;
 * `google_failed`) and the library's.
 */
export const GOOGLE_ERRORS = [
  "account_refused",
  "access_denied",
  "email_unverified",
  "google_failed",
  "invalid_code",
  "unable_to_get_user_info",
  "internal_server_error",
  "email_not_found",
  "state_mismatch",
  "state_not_found",
  "no_code",
] as const;
export type GoogleError = (typeof GOOGLE_ERRORS)[number];

/** A `?error=` this page knows; anything else is no Google refusal and draws nothing. */
export function googleErrorOf(value: unknown): GoogleError | null {
  return typeof value === "string" && (GOOGLE_ERRORS as readonly string[]).includes(value)
    ? (value as GoogleError)
    : null;
}

export interface GoogleAlert {
  readonly tone: "info" | "warning" | "danger";
  readonly title: string;
  readonly body: string;
}

/** What the googleFailed state says for each refusal. */
export function googleAlert(error: GoogleError): GoogleAlert {
  switch (error) {
    case "access_denied":
      return {
        tone: "info",
        title: "Google sign-in was cancelled.",
        body: "Try again, or use an email code.",
      };
    case "account_refused":
    case "email_unverified":
    case "email_not_found":
      return {
        tone: "warning",
        title: "That Google account can’t sign in to Fin Admin.",
        body: "Use your Fin work account, the one Cloudflare Access signed you in with.",
      };
    // Only Fin's own `google_failed` (and the library's internal errors) say Google sign-in is
    // not working; anything else is a round trip that did not finish, which trying again fixes.
    case "google_failed":
    case "unable_to_get_user_info":
    case "internal_server_error":
      return {
        tone: "danger",
        title: "Google sign-in isn’t working right now.",
        body: "Try again in a moment, or use an email code.",
      };
    default:
      return {
        tone: "danger",
        title: "Google sign-in didn’t finish.",
        body: "Try again, or use an email code.",
      };
  }
}
