// Addresses for tests that run side by side against one database: each test gets a scope, and
// every address it makes carries it (`asha.rao+<scope>@example.com`), so two tests never sign up
// the same person. Only fixture domains are made.

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

function cleanScope(scope: string): string {
  const clean = scope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (clean === "") throw new Error("an address book needs a scope with a letter or digit");
  return clean.slice(0, 40);
}

/**
 * A book for one scope, typically built from Playwright's `testInfo.testId`, the retry and a run
 * nonce, so a retried or re-run test does not meet the accounts its earlier try made.
 */
export function createAddressBook(scope: string): AddressBook {
  const clean = cleanScope(scope);
  let counter = 0;
  const make = (label: string, domain: FixtureDomain) => {
    if (!LABEL.test(label))
      throw new Error("an address label is lower-case letters, digits, . and -");
    return `${label}+${clean}@${domain}`;
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
      const local = email.slice(0, at).split("+")[0] as string;
      const domain = email.slice(at + 1).toLowerCase();
      if (domain !== "example.com" && domain !== "example.org" && domain !== "example.net") {
        throw new Error("only fixture addresses are scoped");
      }
      return `${local}+${clean}@${domain}`;
    },
  };
}
