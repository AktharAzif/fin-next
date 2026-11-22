// Addresses for tests that run side by side against one database: each test gets a scope, and
// every address it makes carries it (`asha.rao+<scope>@example.com`), so two tests never sign up
// the same person. Only fixture domains are made.
import { createHash } from "node:crypto";
import { trimEnd } from "../text.ts";

export type FixtureDomain = "example.com" | "example.org" | "example.net";

export interface AddressBook {
  readonly scope: string;
  /** The same address for the same label, within this book. */
  address(label: string, domain?: FixtureDomain): string;
  /** A new address on each call. */
  fresh(label: string, domain?: FixtureDomain): string;
  /** A canon address moved into this book's scope (`name@d` becomes `name+scope@d`). */
  scoped(email: string): string;
}

const LABEL = /^[a-z0-9](?:[a-z0-9.-]{0,38}[a-z0-9])?$/;
/** The longest scope kept as written; a longer one is shortened without losing what tells it apart. */
const MAX_SCOPE = 32;
/** RFC 5321 §4.5.3.1.1: a local part is at most 64 octets. */
const MAX_LOCAL_PART = 64;

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * A scope as it goes into an address: lower-case letters, digits and single hyphens, at most 32
 * characters. A longer one keeps its start, for the reader, and ends with 16 hex characters of the
 * SHA-256 of all of it, so two scopes that differ anywhere (a run ID, a test, a retry) stay apart.
 */
function cleanScope(scope: string): string {
  // One pass, no pattern: letters and digits are kept, and each run of anything else between two
  // of them becomes one hyphen (a run at either end becomes none).
  let clean = "";
  let gap = false;
  for (const char of scope.toLowerCase()) {
    if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9")) {
      if (gap && clean !== "") clean += "-";
      clean += char;
      gap = false;
    } else {
      gap = true;
    }
  }
  if (clean === "") throw new Error("an address book needs a scope with a letter or digit");
  if (clean.length <= MAX_SCOPE) return clean;
  const start = trimEnd(clean.slice(0, MAX_SCOPE - 17), "-");
  return `${start}-${sha256Hex(clean).slice(0, 16)}`;
}

/**
 * The scope of one test's try: the run, the test (by a hash of its ID) and the retry, so a retried
 * or re-run test does not meet the accounts its earlier try made. `createAddressBook` keeps every
 * part of it apart however long the run ID is.
 */
export function testScope(runId: string, testId: string, retry: number): string {
  return `${runId}-${sha256Hex(testId).slice(0, 8)}-r${retry}`;
}

/**
 * A book for one scope, typically `testScope(...)` of Playwright's `testInfo.testId`, the retry
 * and a run nonce.
 */
export function createAddressBook(scope: string): AddressBook {
  const clean = cleanScope(scope);
  let counter = 0;
  const local = (name: string) => {
    const value = `${name}+${clean}`;
    if (value.length > MAX_LOCAL_PART) {
      throw new Error("an address's local part is at most 64 characters: use a shorter label");
    }
    return value;
  };
  const make = (label: string, domain: FixtureDomain) => {
    if (!LABEL.test(label))
      throw new Error("an address label is lower-case letters, digits, . and -");
    return `${local(label)}@${domain}`;
  };
  return {
    scope: clean,
    address: (label, domain = "example.com") => make(label, domain),
    fresh(label, domain = "example.com") {
      counter += 1;
      return make(`${label}-${counter}`, domain);
    },
    scoped(email) {
      const at = email.lastIndexOf("@");
      if (at <= 0) throw new Error("not an address");
      const name = email.slice(0, at).split("+")[0] as string;
      const domain = email.slice(at + 1).toLowerCase();
      if (domain !== "example.com" && domain !== "example.org" && domain !== "example.net") {
        throw new Error("only fixture addresses are scoped");
      }
      return `${local(name)}@${domain}`;
    },
  };
}
