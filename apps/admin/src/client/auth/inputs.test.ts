// The checks a sign-in screen makes before it sends anything.
import { describe, expect, it } from "vitest";
import {
  checkWorkEmail,
  formatEnrolmentCode,
  groupsOfFour,
  isDigits,
  normaliseEmail,
  normaliseEnrolmentCode,
  totpKeyOf,
} from "./inputs.ts";

describe("the work email", () => {
  it("asks for an address when there is none", () => {
    expect(checkWorkEmail("   ", null)).toBe("empty");
  });

  it("refuses what is not an address, or is too long", () => {
    expect(checkWorkEmail("nadia", null)).toBe("notWork");
    expect(checkWorkEmail("nadia@", null)).toBe("notWork");
    expect(checkWorkEmail(`${"a".repeat(250)}@example.com`, null)).toBe("notWork");
  });

  it("refuses another domain than the one Access let in", () => {
    expect(checkWorkEmail("nadia@example.org", "nadia.brooks@example.com")).toBe("notWork");
    expect(checkWorkEmail("Nadia.Brooks@EXAMPLE.com", "nadia.brooks@example.com")).toBeNull();
  });

  it("takes any address when Access has not said who it is", () => {
    expect(checkWorkEmail("nadia@example.org", null)).toBeNull();
  });

  it("is sent trimmed and lower-cased", () => {
    expect(normaliseEmail("  Nadia.Brooks@Example.COM ")).toBe("nadia.brooks@example.com");
  });
});

describe("codes", () => {
  it("are digits of the exact length", () => {
    expect(isDigits("12345678", 8)).toBe(true);
    expect(isDigits("1234567", 8)).toBe(false);
    expect(isDigits("1234567a", 8)).toBe(false);
  });
});

describe("the enrolment code", () => {
  it("is read as the realm reads it: any case, dashes and spaces dropped, I L O read as 1 1 0", () => {
    expect(normaliseEnrolmentCode("abcd-efgh-jkmn-pqrs")).toBe("ABCDEFGHJKMNPQRS");
    expect(normaliseEnrolmentCode(" ABCD EFGH JKMN PQRS ")).toBe("ABCDEFGHJKMNPQRS");
    expect(normaliseEnrolmentCode("ILO0-0000-0000-0000")).toBe("1100000000000000");
  });

  it("refuses what cannot be one", () => {
    expect(normaliseEnrolmentCode("ABCD-EFGH-JKMN")).toBeNull();
    expect(normaliseEnrolmentCode("ABCD-EFGH-JKMN-PQRU")).toBeNull();
    expect(normaliseEnrolmentCode("ABCD-EFGH-JKMN-PQRS-T")).toBeNull();
  });

  it("is shown in four groups of four", () => {
    expect(formatEnrolmentCode("abcdefghjkmnpqrs")).toBe("ABCD-EFGH-JKMN-PQRS");
    expect(formatEnrolmentCode("ABCD-EFGH-JKMN-PQRS")).toBe("ABCD-EFGH-JKMN-PQRS");
  });
});

describe("the authenticator key", () => {
  it("comes from the otpauth URI, and is shown in groups of four", () => {
    const key = totpKeyOf(
      "otpauth://totp/Fin%20Admin:nadia%40example.com?secret=MFRGGZDFMZTWQ2LK&issuer=Fin%20Admin",
    );
    expect(key).toBe("MFRGGZDFMZTWQ2LK");
    expect(groupsOfFour(key as string)).toBe("MFRG GZDF MZTW Q2LK");
  });

  it("is null for anything else", () => {
    expect(totpKeyOf("https://example.com/?secret=MFRGGZDFMZTWQ2LK")).toBeNull();
    expect(totpKeyOf("otpauth://totp/x?secret=not-base32!")).toBeNull();
    expect(totpKeyOf("not a uri")).toBeNull();
  });
});
