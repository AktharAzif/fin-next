// T05-01, T05-02 (A05-01): the key's format, the TypeScript CRC-32 against node:zlib's, the base62
// checksum's padding, the parser's refusals, and the per-deployment salts. Keys are built at run
// time from random parts: no key with a valid checksum is written in the repository (T05-03).
import { randomBytes } from "node:crypto";
import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BASE62_ALPHABET, base62, base62Random } from "./base62.ts";
import { crc32, crc32Ascii } from "./crc32.ts";
import { CROCKFORD_ALPHABET, crockfordFromBytes, isKeyId } from "./crockford.ts";
import {
  buildKey,
  checksumOf,
  KEY_LENGTH,
  KEY_REGEX,
  keyPrefix,
  otherDeploymentSalt,
  parseKey,
  verifyChecksum,
} from "./format.ts";
import { newKey, newKeyId } from "./generate.ts";
import { KNOWN_SALTS, SALTS, saltFor } from "./salts.ts";

describe("CRC-32", () => {
  it("equals node:zlib's crc32 on 10,000 random inputs", () => {
    for (let i = 0; i < 10_000; i++) {
      const bytes = randomBytes(i % 97);
      expect(crc32(bytes)).toBe(zlibCrc32(bytes));
    }
  });

  it("refuses text that is not ASCII", () => {
    expect(crc32Ascii("abc")).toBe(zlibCrc32(Buffer.from("abc")));
    expect(() => crc32Ascii("é")).toThrow(RangeError);
  });
});

describe("base62", () => {
  it("writes the alphabet in its order, left-padded to the width", () => {
    expect(BASE62_ALPHABET).toHaveLength(62);
    expect(base62(0, 6)).toBe("000000");
    expect(base62(61, 6)).toBe("00000z");
    expect(base62(62, 6)).toBe("000010");
    // CRC-32's largest value fits six characters: 62^6 exceeds 2^32.
    expect(base62(0xffffffff, 6)).toHaveLength(6);
    expect(() => base62(62 ** 6, 6)).toThrow(RangeError);
  });

  it("draws without bias toward the first characters (rejection sampling)", () => {
    const seen = new Map<string, number>();
    const text = base62Random(62 * 400, (n) => new Uint8Array(randomBytes(n)));
    for (const ch of text) seen.set(ch, (seen.get(ch) ?? 0) + 1);
    expect(seen.size).toBe(62);
    for (const count of seen.values()) expect(count).toBeGreaterThan(250);
    // A byte at or above 248 is never used.
    expect(base62Random(4, (n) => new Uint8Array(n).fill(255).map((v, i) => (i % 2 ? 7 : v)))).toBe(
      "7777",
    );
  });
});

describe("Crockford IDs", () => {
  it("uses the upper-case alphabet without I, L, O or U", () => {
    expect(CROCKFORD_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    for (let i = 0; i < 500; i++) expect(isKeyId(newKeyId())).toBe(true);
    expect(crockfordFromBytes(new Uint8Array(7), 10)).toBe("0000000000");
    expect(isKeyId("ABCDEFGHIJ")).toBe(false);
    expect(isKeyId("abcdefghjk")).toBe(false);
  });

  it("redraws an ID of ten digits", () => {
    let call = 0;
    const id = newKeyId((n) => {
      call += 1;
      return call === 1 ? new Uint8Array(n) : new Uint8Array(n).fill(0xff);
    });
    expect(id).toBe("ZZZZZZZZZZ");
  });
});

describe("the key", () => {
  const salt = saltFor("ci");

  it("is 60 characters, matches KEY_REGEX and parses back into its parts", () => {
    for (const mode of ["test", "live"] as const) {
      for (const kind of ["sk", "rk"] as const) {
        const made = newKey(mode, kind, salt);
        expect(made.key).toHaveLength(KEY_LENGTH);
        expect(KEY_REGEX.test(made.key)).toBe(true);
        const parsed = parseKey(made.key);
        expect(parsed).toMatchObject({ mode, kind, id: made.id, body: made.body });
        expect(made.prefix).toBe(keyPrefix(mode, kind, made.id));
        expect(verifyChecksum(made.key, salt)).toBe(true);
      }
    }
  });

  it("checksums salt:body with CRC-32 in six base62 characters", () => {
    const made = newKey("test", "rk", salt);
    const expected = base62(zlibCrc32(Buffer.from(`${salt}:${made.body}`)), 6);
    expect(checksumOf(made.body, salt)).toBe(expected);
    expect(made.key.endsWith(expected)).toBe(true);
  });

  it("refuses every off-by-one length and every character outside its alphabet", () => {
    const made = newKey("live", "sk", salt);
    expect(parseKey(made.key.slice(0, -1))).toBeNull();
    expect(parseKey(`${made.key}0`)).toBeNull();
    // The ID's alphabet: I, L, O, U and lower case are refused.
    for (const bad of ["I", "L", "O", "U", "a"]) {
      const key = `${made.key.slice(0, 12)}${bad}${made.key.slice(13)}`;
      expect(parseKey(key), bad).toBeNull();
    }
    // The secret and checksum: base62 only.
    for (const bad of ["_", "-", "+", "/", "="]) {
      expect(parseKey(`${made.key.slice(0, 30)}${bad}${made.key.slice(31)}`), bad).toBeNull();
      expect(parseKey(`${made.key.slice(0, 58)}${bad}${made.key.slice(59)}`), bad).toBeNull();
    }
    expect(parseKey(made.key.replace("fin_live_", "fin_prod_"))).toBeNull();
    expect(parseKey(made.key.replace("_sk_", "_pk_"))).toBeNull();
    expect(parseKey(` ${made.key.slice(1)}`)).toBeNull();
  });

  it("fails its checksum when any character of the body changes", () => {
    const made = newKey("test", "sk", salt);
    const flipped = `${made.key.slice(0, 40)}${made.key[40] === "A" ? "B" : "A"}${made.key.slice(41)}`;
    expect(verifyChecksum(flipped, salt)).toBe(false);
  });

  it("refuses to build a malformed key", () => {
    expect(() => buildKey("test", "sk", "ABCDEFGHIJ", "a".repeat(32), salt)).toThrow(TypeError);
    expect(() => buildKey("test", "sk", "ABCDEFGHJK", "a".repeat(31), salt)).toThrow(TypeError);
  });
});

describe("salts", () => {
  it("lists every environment's salt once, among the known salts", () => {
    expect(new Set(KNOWN_SALTS).size).toBe(KNOWN_SALTS.length);
    for (const salt of Object.values(SALTS)) expect(KNOWN_SALTS).toContain(salt);
    expect(saltFor("staging")).toBe("fin-stg-1");
    expect(saltFor("production")).toBe("fin-prod-1");
  });

  it("refuses a key built with one salt under every other, and names the other deployment", () => {
    for (const salt of KNOWN_SALTS) {
      const made = newKey("live", "rk", salt);
      for (const other of KNOWN_SALTS) {
        expect(verifyChecksum(made.key, other)).toBe(other === salt);
        if (other !== salt) expect(otherDeploymentSalt(made.key, other)).toBe(salt);
      }
      expect(otherDeploymentSalt(made.key, salt)).toBeNull();
    }
  });
});
