// The password rule (spec 02 §5.7, [SA-06]): 12 to 128 characters, and not a common password.
// A password is used exactly as typed: never trimmed, truncated or case-folded before hashing; only
// the comparison with the common list is made on its lower-cased form. Length counts characters
// (Unicode code points) for the minimum, and UTF-16 units for the maximum, as the library does, so
// the two never disagree about a password Fin lets through.
import { COMMON_PASSWORDS } from "../common-passwords.ts";
import { AuthRefusal } from "../errors.ts";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordProblem = "too_short" | "too_long" | "common";

let common: ReadonlySet<string> | null = null;

/** The list as a set, built on first use (static data: it decides nothing per person). */
function commonPasswords(): ReadonlySet<string> {
  common ??= new Set(COMMON_PASSWORDS);
  return common;
}

/**
 * What is wrong with a new password, or null. `common` also covers a password that is one
 * character repeated, or the account's own address or its part before the `@`: each is the first
 * thing a guesser tries.
 */
export function passwordProblem(
  password: string,
  context: { email?: string | null } = {},
): PasswordProblem | null {
  if (password.length > PASSWORD_MAX_LENGTH) return "too_long";
  if ([...password].length < PASSWORD_MIN_LENGTH) return "too_short";
  const folded = password.normalize("NFC").toLowerCase();
  if (commonPasswords().has(folded)) return "common";
  if (/^(.)\1*$/su.test(folded)) return "common";
  const email = context.email?.trim().toLowerCase() ?? "";
  if (email !== "") {
    const local = email.slice(0, email.lastIndexOf("@"));
    if (folded === email || (local.length > 0 && folded === local)) return "common";
  }
  return null;
}

/**
 * Refuses a new password that breaks the rule: `400 invalid` naming the field and the problem
 * (`problem: password_too_short | password_too_long | password_common`), never the value.
 */
export function assertNewPassword(
  password: unknown,
  field: string,
  context: { email?: string | null } = {},
): string {
  if (typeof password !== "string") {
    throw new AuthRefusal("invalid", "body.password", {
      fields: [field],
      problem: "password_missing",
    });
  }
  const problem = passwordProblem(password, context);
  if (problem !== null) {
    throw new AuthRefusal("invalid", `passwords.${problem}`, {
      fields: [field],
      problem: `password_${problem}`,
    });
  }
  return password;
}
