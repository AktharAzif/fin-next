// The password calls (spec 02 §5.7, stretch 2): the developer realm's password paths under
// /api/auth, which the allowlist reaches only while passwords are on (§4.2), and the console's own
// two password routes. A password is sent exactly as typed: never trimmed or changed here.
import { defineContract, noInput, z } from "@fin/app-contracts";

const email = z.string().trim().min(3).max(254);
const password = z.string().min(1).max(1024);

/** What the library answers on success, which no screen reads. */
const libraryAnswer = z.unknown();

/** Which methods this deployment offers beyond the passkey and the emailed code. */
export const signInMethods = defineContract({
  name: "signIn.methods",
  method: "GET",
  path: "/sign-in/methods",
  input: noInput,
  output: z.looseObject({ password: z.boolean() }),
});

export const signInWithPassword = defineContract({
  name: "auth.signInWithPassword",
  method: "POST",
  path: "/auth/sign-in/email",
  input: z.object({ email, password }),
  output: libraryAnswer,
});

/** Emails a reset code (and its link) to the address, if it has an account; the same answer always. */
export const requestPasswordReset = defineContract({
  name: "auth.requestPasswordReset",
  method: "POST",
  path: "/auth/email-otp/request-password-reset",
  input: z.object({ email }),
  output: libraryAnswer,
});

export const resetPassword = defineContract({
  name: "auth.resetPassword",
  method: "POST",
  path: "/auth/email-otp/reset-password",
  input: z.object({ email, otp: z.string().regex(/^\d{8}$/), password }),
  output: libraryAnswer,
});

/** Whether this browser asked for the address's live reset (the reset link's check). */
export const resetCodeLink = defineContract({
  name: "resetPassword.codeLink",
  method: "POST",
  path: "/reset-password/code-link",
  input: z.object({ email }),
  output: z.looseObject({ state: z.enum(["asking", "spent", "elsewhere"]) }),
});
