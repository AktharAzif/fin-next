// What the sign-in screens check before they send anything: the work email, the 8-digit emailed
// code, the 6-digit authenticator code and the 16-character enrolment code. These mirror the
// server's rules so a person hears about a typo at once; the server checks everything again.

export const EMAILED_CODE_LENGTH = 8;
export const AUTHENTICATOR_CODE_LENGTH = 6;

const ADDRESS = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]+$/;

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

export type EmailProblem = "empty" | "notWork";

/**
 * Whether `value` can be sent as a work email: an address at all, at most 254 characters, and, when
 * Cloudflare Access has said who is signing in, on that address's domain (AdminSignIn's
 * `notWorkEmail`). The server answers every address alike either way (spec 02 §10.5).
 */
export function checkWorkEmail(value: string, accessEmail: string | null): EmailProblem | null {
  const email = value.trim();
  if (email === "") return "empty";
  if (email.length > 254 || !ADDRESS.test(email)) return "notWork";
  if (accessEmail !== null && accessEmail !== "" && domainOf(accessEmail) !== domainOf(email)) {
    return "notWork";
  }
  return null;
}

/** The address as it is sent: trimmed and lower-cased (the realm lower-cases it too). */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** True when `code` is `length` digits. */
export function isDigits(code: string, length: number): boolean {
  return code.length === length && /^\d+$/.test(code);
}

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/**
 * An enrolment code as the realm reads it (spec 02 §6.5): any case, hyphens and spaces dropped,
 * Crockford's I and L read as 1 and O as 0. Null when it cannot be one.
 */
export function normaliseEnrolmentCode(input: string): string | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return CROCKFORD.test(clean) ? clean : null;
}

/** `XXXX-XXXX-XXXX-XXXX`, the way an Admin reads a code out. */
export function formatEnrolmentCode(code: string): string {
  const clean = code.toUpperCase().replace(/[\s-]/g, "");
  return clean.match(/.{1,4}/g)?.join("-") ?? clean;
}

/** The base32 key of an `otpauth://totp/...` URI, or null. */
export function totpKeyOf(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "otpauth:") return null;
  const secret = url.searchParams.get("secret");
  if (secret === null) return null;
  const clean = secret.toUpperCase().replace(/[\s=]/g, "");
  return /^[A-Z2-7]{16,128}$/.test(clean) ? clean : null;
}

/** The key in groups of four for typing into an app: `MFRG GZDF MZTW Q2LK`. */
export function groupsOfFour(key: string): string {
  return key.match(/.{1,4}/g)?.join(" ") ?? key;
}
