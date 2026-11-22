// The browser half of a passkey ceremony (spec 02 §5.3), on @simplewebauthn/browser, the passkey
// client spec 06 §1.1 names: the options come from the staff realm, the browser's prompt runs, and
// the JSON response goes back to the realm. Only what the person did is kept: they closed the
// prompt (or it timed out), the browser cannot use passkeys, or the authenticator refused.
import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from "@simplewebauthn/browser";

export type CeremonyFailure = "cancelled" | "unsupported" | "failed";

export type Ceremony<T> =
  | { readonly ok: true; readonly response: T }
  | { readonly ok: false; readonly reason: CeremonyFailure };

/** Whether this browser can run a passkey prompt at all. */
export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** Sorts a ceremony's error: a closed or timed-out prompt is the person's choice, not a failure. */
export function ceremonyFailure(error: unknown): CeremonyFailure {
  const name = error instanceof Error ? error.name : "";
  if (error instanceof WebAuthnError) {
    if (error.code === "ERROR_CEREMONY_ABORTED") return "cancelled";
    const cause = error.cause instanceof Error ? error.cause.name : "";
    if (cause === "NotAllowedError" || cause === "AbortError") return "cancelled";
    if (cause === "NotSupportedError") return "unsupported";
    return "failed";
  }
  if (name === "NotAllowedError" || name === "AbortError") return "cancelled";
  if (name === "NotSupportedError") return "unsupported";
  if (error instanceof Error && /does not support WebAuthn/i.test(error.message)) {
    return "unsupported";
  }
  return "failed";
}

function isOptions(value: unknown): value is { challenge: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { challenge?: unknown }).challenge === "string"
  );
}

/** Asks the browser for an assertion with the realm's options. */
export async function authenticate(options: unknown): Promise<Ceremony<unknown>> {
  if (!isOptions(options)) return { ok: false, reason: "failed" };
  if (!passkeysSupported()) return { ok: false, reason: "unsupported" };
  try {
    const response = await startAuthentication({
      optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
    });
    return { ok: true, response };
  } catch (error) {
    return { ok: false, reason: ceremonyFailure(error) };
  }
}

/** Asks the browser to make a passkey with the realm's options. */
export async function register(options: unknown): Promise<Ceremony<unknown>> {
  if (!isOptions(options)) return { ok: false, reason: "failed" };
  if (!passkeysSupported()) return { ok: false, reason: "unsupported" };
  try {
    const response = await startRegistration({
      optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
    });
    return { ok: true, response };
  } catch (error) {
    return { ok: false, reason: ceremonyFailure(error) };
  }
}
