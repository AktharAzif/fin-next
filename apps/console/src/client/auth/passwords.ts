// What the password screens share (spec 02 §5.7; the SignIn, SignUp, ResetPassword and NewPassword
// boards): whether this deployment offers passwords, the length the field asks for before a request
// is sent, and the sentence for each problem the server names (`problem: password_*`). The server
// decides every rule; the page only says what it was told, never echoing the password.
import { useEffect, useState } from "react";
import { signInMethods } from "../api/contracts/passwords.ts";
import { codeOf, problemField } from "../api/failures.ts";
import { ceremonyApi } from "../api/library.ts";

/** At least 12 characters (§5.7), counted as the server counts them: by character. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_HELPER = "At least 12 characters.";
export const PASSWORD_COMMON = "That password is too common. Choose one that’s harder to guess.";
export const PASSWORD_TOO_LONG = "Use 128 characters or fewer.";

export type PasswordProblem = "short" | "common" | "long";

/** How many more characters the password needs (0 when it is long enough). */
export function charactersShort(password: string): number {
  return Math.max(0, PASSWORD_MIN_LENGTH - [...password].length);
}

/** The field's error for a problem, with the count a short password still needs. */
export function passwordError(problem: PasswordProblem, password: string): string {
  if (problem === "common") return PASSWORD_COMMON;
  if (problem === "long") return PASSWORD_TOO_LONG;
  const left = Math.max(1, charactersShort(password));
  return `${left} more character${left === 1 ? "" : "s"} needed.`;
}

/** The problem a refusal names for the password field, or null when it names none. */
export function passwordProblemOf(error: unknown): PasswordProblem | null {
  if (codeOf(error) !== "invalid") return null;
  switch (problemField(error, "problem")) {
    case "password_too_short":
    case "password_missing":
      return "short";
    case "password_common":
      return "common";
    case "password_too_long":
      return "long";
    default:
      return null;
  }
}

/** Whether a refusal is the pause on password sign-in after wrong passwords (§5.7). */
export function isPasswordPaused(error: unknown): boolean {
  return codeOf(error) === "rate_limited" && problemField(error, "reason") === "password_paused";
}

let offered: Promise<boolean> | null = null;

/**
 * Whether passwords are offered here, asked once per page load (the static build is the same in
 * every environment; the API half knows). A failed read offers none, so the page falls back to
 * the passkey and the emailed code, which always work. The call has no frame reactions: a failure
 * here is never the page's.
 */
export function passwordsOffered(): Promise<boolean> {
  offered ??= ceremonyApi()(signInMethods, {}).then(
    (answer) => answer.password,
    () => {
      offered = null;
      return false;
    },
  );
  return offered;
}

/** `null` while the answer is on its way. */
export function usePasswordsOffered(): boolean | null {
  const [value, setValue] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void passwordsOffered().then((answer) => {
      if (live) setValue(answer);
    });
    return () => {
      live = false;
    };
  }, []);
  return value;
}
