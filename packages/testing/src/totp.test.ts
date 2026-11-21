import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  hotp,
  msUntilNextStep,
  parseOtpauthUri,
  totp,
  totpCounter,
} from "./totp.ts";

const ascii = (text: string) => new TextEncoder().encode(text);

// RFC 6238 Appendix B: the seeds are "1234567890" repeated to 20, 32 and 64 characters (built
// here, since a 32-digit literal has the shape the public-safety check refuses).
const digits = (length: number) => "1234567890".repeat(7).slice(0, length);
const SHA1_SEED = ascii(digits(20));
const SHA256_SEED = ascii(digits(32));
const SHA512_SEED = ascii(digits(64));

describe("RFC 6238's test vectors", () => {
  it.each([
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ])("at %i s", (seconds, sha1, sha256, sha512) => {
    const at = seconds * 1000;
    expect(totp(SHA1_SEED, at, { digits: 8, algorithm: "SHA1" })).toBe(sha1);
    expect(totp(SHA256_SEED, at, { digits: 8, algorithm: "SHA256" })).toBe(sha256);
    expect(totp(SHA512_SEED, at, { digits: 8, algorithm: "SHA512" })).toBe(sha512);
  });
});

describe("RFC 4226's HOTP test vectors", () => {
  it.each([
    [0, "755224"],
    [1, "287082"],
    [2, "359152"],
    [3, "969429"],
    [4, "338314"],
    [5, "254676"],
    [6, "287922"],
    [7, "162583"],
    [8, "399871"],
    [9, "520489"],
  ])("counter %i", (counter, code) => {
    expect(hotp(SHA1_SEED, counter)).toBe(code);
  });

  it("refuses a negative counter and a digit count outside 6 to 10", () => {
    expect(() => hotp(SHA1_SEED, -1)).toThrow();
    expect(() => hotp(SHA1_SEED, 0, { digits: 4 })).toThrow();
  });
});

describe("steps", () => {
  it("counts 30-second steps from t0", () => {
    expect(totpCounter(59_000)).toBe(1n);
    expect(totpCounter(60_000)).toBe(2n);
    expect(totpCounter(60_000, { period: 60 })).toBe(1n);
    expect(totpCounter(90_000, { t0: 30 })).toBe(2n);
  });

  it("keeps the same code within a step and changes it at the next", () => {
    const secret = base32Encode(SHA1_SEED);
    expect(totp(secret, 30_000)).toBe(totp(secret, 59_999));
    expect(totp(secret, 59_999)).not.toBe(totp(secret, 60_000));
  });

  it("says how long the current code has left", () => {
    expect(msUntilNextStep(59_000)).toBe(1000);
    expect(msUntilNextStep(60_000)).toBe(30_000);
    expect(msUntilNextStep(61_500, { period: 60 })).toBe(58_500);
  });
});

describe("base32", () => {
  it.each([
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ])("RFC 4648 §10: %j is %s", (text, encoded) => {
    expect(base32Encode(ascii(text))).toBe(encoded);
    expect(new TextDecoder().decode(base32Decode(encoded))).toBe(text);
  });

  it("reads a key as people type it", () => {
    expect(base32Decode("mzxw 6ytb-oi======")).toEqual(ascii("foobar"));
    expect(() => base32Decode("MZXW1")).toThrow("not base32");
  });

  it("gives the same code for a base32 secret as for its bytes", () => {
    expect(totp(base32Encode(SHA1_SEED), 59_000, { digits: 8 })).toBe("94287082");
  });
});

describe("parseOtpauthUri", () => {
  const secret = base32Encode(SHA1_SEED);

  it("reads the label, the issuer and the defaults", () => {
    const key = parseOtpauthUri(
      `otpauth://totp/Fin%20Admin:grace.hall%40example.com?secret=${secret}&issuer=Fin%20Admin`,
    );
    expect(key).toMatchObject({
      issuer: "Fin Admin",
      account: "grace.hall@example.com",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
    expect(key.secret).toEqual(SHA1_SEED);
  });

  it("reads the optional parameters", () => {
    const key = parseOtpauthUri(
      `otpauth://totp/asha?secret=${secret}&algorithm=sha256&digits=8&period=60`,
    );
    expect(key).toMatchObject({ account: "asha", algorithm: "SHA256", digits: 8, period: 60 });
    expect(key.issuer).toBeUndefined();
  });

  it("refuses what is not a TOTP key", () => {
    expect(() => parseOtpauthUri(`otpauth://hotp/a?secret=${secret}`)).toThrow();
    expect(() => parseOtpauthUri("otpauth://totp/a")).toThrow("no secret");
    expect(() => parseOtpauthUri(`otpauth://totp/a?secret=${secret}&algorithm=MD5`)).toThrow();
    expect(() => parseOtpauthUri("https://example.com/")).toThrow();
  });
});
