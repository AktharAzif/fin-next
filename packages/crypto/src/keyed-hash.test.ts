import { describe, expect, it } from "vitest";
import { toHex } from "./bytes.ts";
import { hkdfSha256 } from "./hkdf.ts";
import {
  beneficiaryFingerprint,
  cursorMac,
  hmacSha256,
  indexHashesForWrite,
  indexHashForSearch,
  indexSubkey,
  limitKeyHash,
  verifyCursorMac,
} from "./keyed-hash.ts";
import { createKeyring } from "./keyring.ts";

const KEY_1 = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
const KEY_2 = new Uint8Array(32).fill(7);

describe("hkdfSha256", () => {
  it("matches RFC 5869 test case 1", () => {
    const ikm = new Uint8Array(22).fill(0x0b);
    const salt = new Uint8Array(Array.from({ length: 13 }, (_, i) => i));
    const info = new Uint8Array(Array.from({ length: 10 }, (_, i) => 0xf0 + i));
    expect(toHex(hkdfSha256(ikm, salt, info, 42))).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });

  it("refuses lengths HKDF cannot produce", () => {
    expect(() => hkdfSha256(KEY_1, "s", "i", 0)).toThrow(RangeError);
    expect(() => hkdfSha256(KEY_1, "s", "i", 255 * 32 + 1)).toThrow(RangeError);
  });
});

describe("hmacSha256", () => {
  it("matches RFC 4231 test case 1", () => {
    expect(toHex(hmacSha256(new Uint8Array(20).fill(0x0b), "Hi There"))).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });
});

describe("index hashes", () => {
  const ring = createKeyring(
    "FIN_INDEX_KEY",
    new Map([
      [1, KEY_1],
      [2, KEY_2],
    ]),
    1,
    [1, 2],
  );
  const scope = { use: "email", organization: "org_kat", mode: "live" } as const;

  it("matches the known answer for a fixed key (salt fin-index-v1, info <use>-index:<org>:<mode>)", () => {
    expect(toHex(indexHashForSearch(ring, scope, "ada@example.com").hash)).toBe(
      "00c8447002de25f94e9fa2de42adccccc8a4f31e5ddf97b5f877765fdd1ff69c",
    );
    expect(indexSubkey(KEY_1, scope)).toEqual(
      hkdfSha256(KEY_1, "fin-index-v1", "email-index:org_kat:live", 32),
    );
  });

  it("differs by use, organisation and mode", () => {
    const base = toHex(indexHashForSearch(ring, scope, "x").hash);
    for (const other of [
      { ...scope, use: "phone" as const },
      { ...scope, organization: "org_other" },
      { ...scope, mode: "sandbox" as const },
    ]) {
      expect(toHex(indexHashForSearch(ring, other, "x").hash)).not.toBe(base);
    }
  });

  it("writes one hash per WRITE version and searches under IN_USE", () => {
    const written = indexHashesForWrite(ring, scope, "x");
    expect(written.map((h) => h.version)).toEqual([1, 2]);
    expect(written[0]?.hash).toEqual(indexHashForSearch(ring, scope, "x").hash);
    expect(written[1]?.hash).not.toEqual(written[0]?.hash);
  });

  it("refuses an organisation that could collide with the info separator", () => {
    expect(() => indexHashForSearch(ring, { ...scope, organization: "a:b" }, "x")).toThrow(
      TypeError,
    );
  });
});

describe("fingerprints, limit hashes and cursor MACs", () => {
  const money = createKeyring("FIN_MONEY_INDEX_KEY", new Map([[1, KEY_1]]), 1);
  const cursor = createKeyring(
    "FIN_CURSOR_KEY",
    new Map([
      [1, KEY_1],
      [2, KEY_2],
    ]),
    2,
  );

  it("fingerprints <routing>:<account> under the organisation's subkey", () => {
    const a = beneficiaryFingerprint(money, "org_a", "021000021", "12345678");
    const b = beneficiaryFingerprint(money, "org_b", "021000021", "12345678");
    expect(a.hash).not.toEqual(b.hash);
    const subkey = hkdfSha256(KEY_1, "fin-index-v1", "fingerprint:beneficiary:org_a", 32);
    expect(a.hash).toEqual(hmacSha256(subkey, "021000021:12345678"));
    expect(() => beneficiaryFingerprint(money, "org_a", "02:1", "1")).toThrow(TypeError);
  });

  it("hashes limit keys with the family key itself", () => {
    const limit = createKeyring("FIN_LIMIT_KEY", new Map([[1, KEY_1]]), 1);
    expect(limitKeyHash(limit, "a@example.com").hash).toEqual(hmacSha256(KEY_1, "a@example.com"));
  });

  it("truncates cursor MACs to 16 bytes and accepts any present version", () => {
    const mac = cursorMac(cursor, "cursor-data");
    expect(mac.byteLength).toBe(16);
    expect(verifyCursorMac(cursor, "cursor-data", mac)).toBe(true);
    expect(verifyCursorMac(cursor, "cursor-data", cursorMac(cursor, "cursor-data", 1))).toBe(true);
    expect(verifyCursorMac(cursor, "other-data", mac)).toBe(false);
    expect(verifyCursorMac(cursor, "cursor-data", mac.subarray(0, 8))).toBe(false);
  });
});
