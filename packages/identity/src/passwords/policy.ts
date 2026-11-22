// The password rule (spec 02 §5.7, [SA-06]): 12 to 128 characters, and not a common password.
// A password is used exactly as typed: never trimmed, truncated or case-folded before hashing.
// Only the comparisons that make a password "common" read it in a folded form (comparable()), so
// that a common password with a space around it, with full-width letters or with an invisible
// character inside is still the common password it looks like. Length counts characters (Unicode
// code points) for the minimum, and UTF-16 units for the maximum, as the library does, so the two
// never disagree about a password Fin lets through.
import { COMMON_PASSWORDS } from "../common-passwords.ts";
import { AuthRefusal } from "../errors.ts";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordProblem = "too_short" | "too_long" | "common";

/** White space, and characters that draw nothing (zero-width joiners, soft hyphens and so on). */
const UNSEEN = /[\p{White_Space}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * The form the rule compares a password in, and never the one hashed or kept: compatibility forms
 * folded to the plain ones (NFKC, so full-width `ｐａｓｓｗｏｒｄ` is `password`), lower-cased, with
 * white space and invisible characters taken out.
 */
export function comparable(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(UNSEEN, "");
}

let common: ReadonlySet<string> | null = null;

/** The list's comparable forms, built on first use (static data: it decides nothing per person). */
function commonPasswords(): ReadonlySet<string> {
  common ??= new Set(COMMON_PASSWORDS.map(comparable));
  return common;
}

/**
 * What is wrong with a new password, or null. `common` also covers a password that is one
 * character repeated (or nothing but white space), or the account's own address or its part
 * before the `@`: each is the first thing a guesser tries.
 */
export function passwordProblem(
  password: string,
  context: { email?: string | null } = {},
): PasswordProblem | null {
  if (password.length > PASSWORD_MAX_LENGTH) return "too_long";
  if ([...password].length < PASSWORD_MIN_LENGTH) return "too_short";
  const folded = comparable(password);
  if (folded === "" || commonPasswords().has(folded)) return "common";
  if (/^(.)\1*$/su.test(folded)) return "common";
  const email = comparable(context.email ?? "");
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
