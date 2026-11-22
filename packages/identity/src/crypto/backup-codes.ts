// The developer realm's backup codes (spec 02 §5.4): 10 codes of 10 characters from a-z, 0-9 and
// A-Z, printed as two groups of five, as the library prints them, drawn with the library's own
// uniform generator (crypto.getRandomValues).
//
// Each code holds at least one letter and at least one digit. The library's draw has no such
// rule, and about one code in six held no digit; a code like that, passed into a name by mistake,
// would be mailed as typed, since a 5-5 pair of letters is also an ordinary double-barrelled name
// and the email's name fields show those (T08-23, spec 08 §4.1). Redrawing such a code costs about
// a quarter of a bit of its 59.5.
import { generateRandomString } from "better-auth/crypto";

export const BACKUP_CODE_COUNT = 10;
export const BACKUP_CODE_LENGTH = 10;

/** True when a code mixes letters and digits, as every backup code Fin issues does. */
export function mixesLettersAndDigits(code: string): boolean {
  return /\d/u.test(code) && /[A-Za-z]/u.test(code);
}

/** One code, `xxxxx-xxxxx`, holding a letter and a digit. */
export function generateBackupCode(): string {
  for (;;) {
    const raw = generateRandomString(BACKUP_CODE_LENGTH, "a-z", "0-9", "A-Z");
    if (mixesLettersAndDigits(raw)) return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  }
}

/** A new set of backup codes: the developer realm's `customBackupCodesGenerate`. */
export function generateBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);
}
