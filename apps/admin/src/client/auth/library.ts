// The staff realm's endpoints the Saturday screens use (spec 02 §4.3), each one call or one passkey
// ceremony. Sign-in: an emailed code (`/email-otp/send-verification-otp`, `/sign-in/email-otp`) or
// a passkey alone (`/passkey/generate-authenticate-options`, `/passkey/verify-authentication`).
// Factors: a passkey (`/passkey/generate-register-options`, `/passkey/verify-registration`) or an
// authenticator (`/two-factor/enable`, finished by `/two-factor/verify-totp`). The same calls prove
// a step-up when they carry `Fin-Step-Up-Intent` (spec 02 §7.4).
import { type AuthAnswer, type AuthFailure, type AuthTransport, authRequest } from "./http.ts";
import { authenticate, type CeremonyFailure, register } from "./passkey.ts";

export type PasskeyOutcome =
  | { readonly kind: "done"; readonly data: unknown }
  /** The browser's prompt did not finish: closed, unsupported, or refused by the authenticator. */
  | { readonly kind: "ceremony"; readonly reason: CeremonyFailure }
  /** The realm refused the options or the response. */
  | { readonly kind: "refused"; readonly failure: AuthFailure };

export interface Calls {
  readonly transport?: AuthTransport;
  readonly authenticate?: typeof authenticate;
  readonly register?: typeof register;
}

/** Asks for an emailed sign-in code. The realm answers the same for every address (spec 02 §10.5). */
export function sendSignInCode(email: string, calls: Calls = {}): Promise<AuthAnswer> {
  return authRequest(
    { method: "POST", path: "/email-otp/send-verification-otp", body: { email, type: "sign-in" } },
    calls.transport,
  );
}

/** Signs in with the emailed code: an `aal1` session at the factor step or enrolment. */
export function signInWithCode(email: string, otp: string, calls: Calls = {}): Promise<AuthAnswer> {
  return authRequest(
    { method: "POST", path: "/sign-in/email-otp", body: { email, otp } },
    calls.transport,
  );
}

/**
 * A passkey assertion: signs in (an `aal2` session), finishes the factor step, or proves the
 * named intent at a step-up.
 */
export async function usePasskey(
  intentId: string | null,
  calls: Calls = {},
): Promise<PasskeyOutcome> {
  const options = await authRequest(
    { method: "GET", path: "/passkey/generate-authenticate-options", intentId },
    calls.transport,
  );
  if (!options.ok) return { kind: "refused", failure: options };
  const ceremony = await (calls.authenticate ?? authenticate)(options.data);
  if (!ceremony.ok) return { kind: "ceremony", reason: ceremony.reason };
  const verified = await authRequest(
    {
      method: "POST",
      path: "/passkey/verify-authentication",
      body: { response: ceremony.response },
      intentId,
    },
    calls.transport,
  );
  return verified.ok
    ? { kind: "done", data: verified.data }
    : { kind: "refused", failure: verified };
}

/**
 * Adds a passkey: a pending member's first factor inside the enrolment window, or a further one
 * with an intent (`staff.factor_add`).
 */
export async function addPasskey(
  intentId: string | null,
  calls: Calls = {},
): Promise<PasskeyOutcome> {
  const options = await authRequest(
    { method: "GET", path: "/passkey/generate-register-options", intentId },
    calls.transport,
  );
  if (!options.ok) return { kind: "refused", failure: options };
  const ceremony = await (calls.register ?? register)(options.data);
  if (!ceremony.ok) return { kind: "ceremony", reason: ceremony.reason };
  const verified = await authRequest(
    {
      method: "POST",
      path: "/passkey/verify-registration",
      body: { response: ceremony.response },
      intentId,
    },
    calls.transport,
  );
  return verified.ok
    ? { kind: "done", data: verified.data }
    : { kind: "refused", failure: verified };
}

/**
 * The intent for adding a passkey. The options GET makes none (a GET never writes, spec 02 §2.3), so
 * the realm makes it on the body-less POST of the registration and answers `step_up_required`.
 */
export function askPasskeyIntent(calls: Calls = {}): Promise<AuthAnswer> {
  return authRequest(
    { method: "POST", path: "/passkey/verify-registration", body: {} },
    calls.transport,
  );
}

/** The key of an `otpauth://` URI, when the answer carries one. */
export function totpUriOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const uri = (data as { totpURI?: unknown }).totpURI;
  return typeof uri === "string" && uri.startsWith("otpauth://totp/") ? uri : null;
}

/** Starts an authenticator: the realm answers the `otpauth://` URI once (spec 02 §5.4). */
export function enableAuthenticator(
  intentId: string | null,
  calls: Calls = {},
): Promise<AuthAnswer> {
  return authRequest(
    { method: "POST", path: "/two-factor/enable", body: {}, intentId },
    calls.transport,
  );
}

/**
 * An authenticator's code: finishes its set-up, passes the factor step, or proves an intent.
 */
export function verifyAuthenticatorCode(
  code: string,
  intentId: string | null,
  calls: Calls = {},
): Promise<AuthAnswer> {
  return authRequest(
    { method: "POST", path: "/two-factor/verify-totp", body: { code }, intentId },
    calls.transport,
  );
}

/** Removes a passkey (intent `staff.factor_remove`); the last factor stays (`409 last_factor`). */
export function removePasskey(
  id: string,
  intentId: string | null,
  calls: Calls = {},
): Promise<AuthAnswer> {
  return authRequest(
    { method: "POST", path: "/passkey/delete-passkey", body: { id }, intentId },
    calls.transport,
  );
}

/** Turns the authenticator off (intent `staff.factor_remove`); never the last factor. */
export function turnOffAuthenticator(
  intentId: string | null,
  calls: Calls = {},
): Promise<AuthAnswer> {
  return authRequest(
    { method: "POST", path: "/two-factor/disable", body: {}, intentId },
    calls.transport,
  );
}
