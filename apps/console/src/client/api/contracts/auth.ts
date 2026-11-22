// The sign-in, sign-up and factor calls (spec 02 §4.2, §5, §7.4): the developer realm's library
// endpoints under /api/auth that the allowlist reaches, and Fin's own sign-up and code-link routes.
// The library answers its own bodies; only the fields a screen reads are named, and the rest is
// kept (a newer library never breaks the page).
//
// These contracts are the client's reading of spec 02 §14.2 until L-SAT-02's fragment
// (`packages/app-contracts/src/identity/**`) carries them; the server half validates the same
// shapes. Every call goes through api() (with X-Fin-App on every unsafe method).
import { defineContract, noInput, z } from "@fin/app-contracts";

/** An emailed code: 8 digits (spec 02 §5.2). */
export const EMAIL_CODE_LENGTH = 8;
/** An authenticator code: 6 digits. */
export const TOTP_CODE_LENGTH = 6;

const email = z.string().trim().min(3).max(254);

/** What the library answers on success, which no screen reads. */
const libraryAnswer = z.unknown();

export const signUp = defineContract({
  name: "signUp.create",
  method: "POST",
  path: "/sign-up",
  input: z.object({ name: z.string().max(200), email }),
  output: z.looseObject({ status: z.literal("code_sent") }),
});

/** Whether this browser asked the live code for the address in a sign-in link (spec 02 §5.2). */
export const codeLink = defineContract({
  name: "signIn.codeLink",
  method: "POST",
  path: "/sign-in/code-link",
  input: z.object({ email }),
  output: z.looseObject({ asking: z.boolean() }),
});

export const sendSignInCode = defineContract({
  name: "auth.sendSignInCode",
  method: "POST",
  path: "/auth/email-otp/send-verification-otp",
  input: z.object({ email, type: z.literal("sign-in") }),
  output: libraryAnswer,
});

export const signInWithCode = defineContract({
  name: "auth.signInWithCode",
  method: "POST",
  path: "/auth/sign-in/email-otp",
  input: z.object({ email, otp: z.string().regex(/^\d{8}$/) }),
  output: libraryAnswer,
});

/** WebAuthn options as JSON (the library's `PublicKeyCredential*OptionsJSON`). */
const webauthnOptions = z.looseObject({ challenge: z.string().min(1) });

export const passkeyAuthenticationOptions = defineContract({
  name: "auth.passkeyAuthenticationOptions",
  method: "GET",
  path: "/auth/passkey/generate-authenticate-options",
  input: noInput,
  output: webauthnOptions,
});

export const passkeyVerifyAuthentication = defineContract({
  name: "auth.passkeyVerifyAuthentication",
  method: "POST",
  path: "/auth/passkey/verify-authentication",
  input: z.object({ response: z.record(z.string(), z.unknown()) }),
  output: libraryAnswer,
});

export const passkeyRegistrationOptions = defineContract({
  name: "auth.passkeyRegistrationOptions",
  method: "GET",
  path: "/auth/passkey/generate-register-options",
  input: noInput,
  output: webauthnOptions,
});

/**
 * Finishes a passkey registration. Sent with no response first, it is the call that makes the
 * `account.passkey_add` intent once a factor exists (`403 step_up_required`, spec 02 §7.6).
 */
export const passkeyVerifyRegistration = defineContract({
  name: "auth.passkeyVerifyRegistration",
  method: "POST",
  path: "/auth/passkey/verify-registration",
  input: z.object({ response: z.record(z.string(), z.unknown()).optional() }),
  output: libraryAnswer,
});

export const passkeyDelete = defineContract({
  name: "auth.passkeyDelete",
  method: "POST",
  path: "/auth/passkey/delete-passkey",
  input: z.object({ id: z.string().min(1) }),
  output: libraryAnswer,
});

/** Starts an authenticator set-up: the `otpauth://` URI once, and the 10 backup codes. */
export const totpEnable = defineContract({
  name: "auth.totpEnable",
  method: "POST",
  path: "/auth/two-factor/enable",
  input: noInput,
  output: z.looseObject({
    totpURI: z.string().startsWith("otpauth://"),
    backupCodes: z.array(z.string().min(1)),
  }),
});

export const totpVerify = defineContract({
  name: "auth.totpVerify",
  method: "POST",
  path: "/auth/two-factor/verify-totp",
  input: z.object({
    code: z.string().regex(/^\d{6}$/),
    trustDevice: z.boolean().optional(),
  }),
  output: libraryAnswer,
});

export const backupCodeVerify = defineContract({
  name: "auth.backupCodeVerify",
  method: "POST",
  path: "/auth/two-factor/verify-backup-code",
  input: z.object({ code: z.string().min(1).max(64) }),
  output: libraryAnswer,
});

export const totpDisable = defineContract({
  name: "auth.totpDisable",
  method: "POST",
  path: "/auth/two-factor/disable",
  input: noInput,
  output: libraryAnswer,
});

export const backupCodesGenerate = defineContract({
  name: "auth.backupCodesGenerate",
  method: "POST",
  path: "/auth/two-factor/generate-backup-codes",
  input: noInput,
  output: z.looseObject({ backupCodes: z.array(z.string().min(1)) }),
});
