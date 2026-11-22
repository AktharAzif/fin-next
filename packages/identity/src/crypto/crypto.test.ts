// T-SAT-13: RFC 6238's known answers and the step window; the keyed hasher; base32.
import { describe, expect, it } from "vitest";
import { KeyedHasher } from "./keyed.ts";
import { base32Decode, base32Encode, hotp, matchingStep, totp, totpStep } from "./totp.ts";

// RFC 6238 Appendix B, SHA-1, the 20-byte ASCII seed "12345678901234567890", 8 digits.
const SEED = new TextEncoder().encode("12345678901234567890");

describe("TOTP (RFC 6238)", () => {
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("at %i seconds the code is %s", (seconds, code) => {
    expect(totp(SEED, new Date(seconds * 1000), { digits: 8 })).toBe(code);
  });

  it("has RFC 4226's HOTP known answers", () => {
    expect([0n, 1n, 2n, 9n].map((c) => hotp(SEED, c))).toEqual([
      "755224",
      "287082",
      "359152",
      "520489",
    ]);
  });

  it("finds the step a code belongs to, within one step either side", () => {
    const at = new Date(1_700_000_000_000);
    const now = totpStep(at);
    expect(matchingStep(SEED, totp(SEED, at), at)).toBe(now);
    expect(matchingStep(SEED, hotp(SEED, now - 1n), at)).toBe(now - 1n);
    expect(matchingStep(SEED, hotp(SEED, now + 1n), at)).toBe(now + 1n);
    expect(matchingStep(SEED, hotp(SEED, now + 2n), at)).toBeNull();
    expect(matchingStep(SEED, "12345", at)).toBeNull();
    expect(matchingStep(SEED, "abcdef", at)).toBeNull();
  });

  it("round-trips base32", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
  });
});

describe("KeyedHasher", () => {
  const key = (version: number, fill: number) => ({ version, key: new Uint8Array(32).fill(fill) });

  it("hashes with the newest key and offers every key for lookups", () => {
    const hasher = new KeyedHasher([key(1, 1), key(2, 2)]);
    const older = new KeyedHasher([key(1, 1)]);
    expect(hasher.hash("email", "a@example.com")).toEqual(
      new KeyedHasher([key(2, 2)]).hash("email", "a@example.com"),
    );
    expect(hasher.hashes("email", "a@example.com")).toContainEqual(
      older.hash("email", "a@example.com"),
    );
  });

  it("separates purposes", () => {
    const hasher = new KeyedHasher([key(1, 1)]);
    expect(hasher.hash("email", "x")).not.toEqual(hasher.hash("browser", "x"));
  });

  it("refuses short keys", () => {
    expect(() => new KeyedHasher([{ version: 1, key: new Uint8Array(16) }])).toThrow(/32 bytes/);
    expect(() => new KeyedHasher([])).toThrow();
  });
});
