// Passkeys in the browser (spec 02 §5.3): sign-in from the button or from the email field's
// autofill (conditional UI), the factor step and the StepUp ceremony, and registration. The
// options come from the library's endpoints through api(); @simplewebauthn/browser runs the
// browser's ceremony (the passkey plugin's own peer, imported only here, spec 06 §1.1). Starting a
// ceremony cancels the one before it, so the autofill request never blocks the button.

import type { Api } from "@fin/frame";
import {
  type AuthenticationResponseJSON,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  passkeyVerifyAuthentication,
  passkeyVerifyRegistration,
} from "../api/contracts/auth.ts";

/** Whether this browser can use passkeys at all. */
export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

export async function autofillSupported(): Promise<boolean> {
  try {
    return await browserSupportsWebAuthnAutofill();
  } catch {
    return false;
  }
}

/** What went wrong in the browser's own ceremony, before any answer from Fin. */
export type CeremonyOutcome = "cancelled" | "aborted" | "unsupported" | "failed";

/** A failure of the browser's ceremony (the person closed it, or the device refused). */
export class CeremonyError extends Error {
  readonly outcome: CeremonyOutcome;
  constructor(outcome: CeremonyOutcome, cause?: unknown) {
    super(`passkey ceremony ${outcome}`, cause === undefined ? undefined : { cause });
    this.name = "CeremonyError";
    this.outcome = outcome;
  }
}

export function isCeremonyError(error: unknown, outcome?: CeremonyOutcome): boolean {
  return error instanceof CeremonyError && (outcome === undefined || error.outcome === outcome);
}

/** The browser's error, read by its name and code: never its message, which may name the site. */
export function ceremonyOutcome(error: unknown): CeremonyOutcome {
  if (!(error instanceof Error)) return "failed";
  const code = (error as { code?: unknown }).code;
  if (code === "ERROR_CEREMONY_ABORTED" || error.name === "AbortError") return "aborted";
  if (error.name === "NotAllowedError") return "cancelled";
  if (error.name === "NotSupportedError" || error.name === "SecurityError") return "unsupported";
  return "failed";
}

async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new CeremonyError(ceremonyOutcome(error), error);
  }
}

/**
 * Signs in (or proves a factor) with a passkey: the options, the browser's prompt, then the
 * library's verify call. `api` is a ceremony client, with the intent header when it proves one.
 */
export async function authenticateWithPasskey(
  api: Api,
  options: { autofill?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const requestOptions = await api(
    passkeyAuthenticationOptions,
    {},
    options.signal === undefined ? {} : { signal: options.signal },
  );
  const response: AuthenticationResponseJSON = await ceremony(() =>
    startAuthentication({
      optionsJSON: requestOptions as unknown as PublicKeyCredentialRequestOptionsJSON,
      useBrowserAutofill: options.autofill === true,
    }),
  );
  await api(passkeyVerifyAuthentication, {
    response: response as unknown as Record<string, unknown>,
  });
}

/** Registers a passkey on the signed-in account: the options, the browser's prompt, the verify call. */
export async function registerPasskey(api: Api): Promise<void> {
  const creationOptions = await api(passkeyRegistrationOptions, {});
  const response: RegistrationResponseJSON = await ceremony(() =>
    startRegistration({
      optionsJSON: creationOptions as unknown as PublicKeyCredentialCreationOptionsJSON,
    }),
  );
  await api(passkeyVerifyRegistration, {
    response: response as unknown as Record<string, unknown>,
  });
}

/** Ends a pending autofill request (leaving the page, or before another ceremony). */
export function cancelPasskeyCeremony(): void {
  try {
    WebAuthnAbortService.cancelCeremony();
  } catch {
    // Nothing was pending.
  }
}
