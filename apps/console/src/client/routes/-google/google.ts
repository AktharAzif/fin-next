// "Continue with Google" on the sign-in and sign-up pages (spec 02 §5.8, stretch 5): the calls,
// where the round trip comes back to, and what each refusal the callback sends back means. The
// server decides everything that matters (the state, PKCE, the nonce, the exact redirect URI, which
// addresses may sign in); the page only offers the button when the console says Google is on, and
// sends the browser to the address the server answered.
import { defineContract, noInput, z } from "@fin/app-contracts";

/** Whether this deployment offers Google (GET /api/sign-in/methods). */
export const signInMethods = defineContract({
  name: "signIn.methods",
  method: "GET",
  path: "/sign-in/methods",
  input: noInput,
  output: z.looseObject({ google: z.boolean() }),
});

/** Starts a Google round trip: the library answers the provider's address (redirect only). */
export const googleStart = defineContract({
  name: "auth.googleStart",
  method: "POST",
  path: "/auth/sign-in/social",
  input: z.object({
    provider: z.literal("google"),
    callbackURL: z.string(),
    errorCallbackURL: z.string(),
    disableRedirect: z.literal(true),
  }),
  output: z.looseObject({ url: z.string().min(1) }),
});

/** The page a refused round trip comes back to; the server accepts only these (§2.3). */
export type GooglePage = "/sign-in" | "/sign-up";

/**
 * Where the round trip ends: the sign-in page with `via=google`, which goes on to where the
 * person's gate says, keeping a safe `next`. A refusal comes back to the page it began on.
 */
export function googleReturn(
  page: GooglePage,
  next: string | null,
): { callbackURL: string; errorCallbackURL: string } {
  const keep = next !== null && next !== "" && next !== "/" ? next : null;
  const callback = new URLSearchParams({ via: "google" });
  if (keep !== null) callback.set("next", keep);
  const error = keep === null ? "" : `?${new URLSearchParams({ next: keep }).toString()}`;
  return { callbackURL: `/sign-in?${callback.toString()}`, errorCallbackURL: `${page}${error}` };
}

/**
 * The refusals the callback sends back as `?error=`: the library's codes, and Fin's own two
 * (`email_unverified`, `google_failed`) where the realm knows better.
 */
export const GOOGLE_ERRORS = [
  "access_denied",
  "account_not_linked",
  "email_unverified",
  "unable_to_create_user",
  "signup_disabled",
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

export function isGoogleError(value: unknown): value is GoogleError {
  return typeof value === "string" && (GOOGLE_ERRORS as readonly string[]).includes(value);
}

/** The SignIn board's Google states (spec 06 §8.2, stretch 5). */
export type GoogleState =
  | "googleCancelled"
  | "googleNotLinked"
  | "googleUnconfirmed"
  | "googleNoSignup"
  | "googleOurSide"
  | "googleIncomplete"
  | "googleUnfinished";

export function googleState(error: GoogleError): GoogleState {
  switch (error) {
    case "access_denied":
      return "googleCancelled";
    case "account_not_linked":
      return "googleNotLinked";
    case "email_unverified":
      return "googleUnconfirmed";
    case "unable_to_create_user":
    case "signup_disabled":
      return "googleNoSignup";
    // Only Fin's own `google_failed` (and the library's internal errors) say Google sign-in is
    // not working; a code the provider refused (`invalid_code`) is a round trip that did not
    // finish, which trying again fixes.
    case "google_failed":
    case "unable_to_get_user_info":
    case "internal_server_error":
      return "googleOurSide";
    case "email_not_found":
      return "googleIncomplete";
    default:
      return "googleUnfinished";
  }
}

export interface GoogleAlert {
  tone: "info" | "warning" | "danger";
  title: string;
  body: string;
}

const ALERTS: Readonly<Record<GoogleState, GoogleAlert>> = {
  googleCancelled: {
    tone: "info",
    title: "Google sign-in was cancelled.",
    body: "Try again, or continue with your email.",
  },
  googleNotLinked: {
    tone: "warning",
    title: "This email already has a Fin account.",
    body: "Sign in with a passkey or your email. You can link Google in Account security.",
  },
  googleUnconfirmed: {
    tone: "warning",
    title: "Google hasn’t confirmed that account’s email address.",
    body: "Try another Google account, or continue with your email.",
  },
  googleNoSignup: {
    tone: "warning",
    title: "We couldn’t create your account with Google.",
    body: "Try again later, or continue with your email.",
  },
  googleOurSide: {
    tone: "danger",
    title: "Google sign-in isn’t working right now.",
    body: "Try again in a moment, or continue with your email.",
  },
  googleIncomplete: {
    tone: "warning",
    title: "Google didn’t share an email address for that account.",
    body: "Try another Google account, or continue with your email.",
  },
  googleUnfinished: {
    tone: "danger",
    title: "Google sign-in didn’t finish.",
    body: "Try again, or continue with your email.",
  },
};

export function googleAlert(error: GoogleError): GoogleAlert {
  return ALERTS[googleState(error)];
}

/**
 * The provider's address the server answered, when it is one the browser may be sent to: https,
 * or plain http on loopback (the fixture provider in development and test).
 */
export function providerUrl(value: string): string | null {
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
