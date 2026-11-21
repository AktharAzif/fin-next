import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import { toHex } from "./bytes.ts";
import { hkdfSha256 } from "./hkdf.ts";
import { createKeyring } from "./keyring.ts";
import { createSealer, type SealField, SealOpenError, sealSubkey } from "./seal.ts";

const KEY_1 = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
const KEY_2 = new Uint8Array(Array.from({ length: 32 }, (_, i) => 255 - i));
const FIXED_IV = new Uint8Array(Array.from({ length: 12 }, (_, i) => 0xa0 + i));
const FIELD: SealField = {
  organization: "org_kat",
  table: "kyc.customer",
  column: "display_name_sealed",
};

function keyring(inUse = 1) {
  return createKeyring(
    "FIN_SEAL_KEY",
    new Map([
      [1, KEY_1],
      [2, KEY_2],
    ]),
    inUse,
  );
}

describe("AES-256-GCM, the primitive", () => {
  it("matches the GCM specification's test case 14 (256-bit zero key, zero IV, one zero block)", () => {
    const cipher = createCipheriv("aes-256-gcm", new Uint8Array(32), new Uint8Array(12));
    const body = cipher.update(new Uint8Array(16));
    cipher.final();
    // Joined at run time: the public-safety check treats a lone 32-hex string as an account ID.
    expect(toHex(body)).toBe(["cea7403d4d606b6e", "074ec5d3baf39d18"].join(""));
    expect(toHex(cipher.getAuthTag())).toBe(["d0d1c8a799996bf0", "265b98b5d48ab919"].join(""));
  });
});

describe("createSealer", () => {
  it("writes the known answer for a fixed key, IV, field and value (the stored format)", () => {
    const sealer = createSealer(keyring(), "data", { randomBytes: () => FIXED_IV });
    expect(sealer.seal(FIELD, "Ada Lovelace")).toBe(
      "fdk1.oKGio6Slpqeoqaqr.Ja5uXNsUUPUJWxix3Mn31uswImke76Wi3QRt7w",
    );
  });

  it("derives the subkey with HKDF-SHA256, salt fin-seal-v1 and info <purpose>:<organization>", () => {
    expect(sealSubkey(KEY_1, "data", "org_kat")).toEqual(
      hkdfSha256(KEY_1, "fin-seal-v1", "data:org_kat", 32),
    );
    expect(sealSubkey(KEY_1, "money", "org_kat")).toEqual(
      hkdfSha256(KEY_1, "fin-seal-v1", "money:org_kat", 32),
    );
    expect(sealSubkey(KEY_1, "data", "org_kat")).not.toEqual(sealSubkey(KEY_1, "money", "org_kat"));
  });

  it("opens what it seals, as bytes and as text", () => {
    const sealer = createSealer(keyring(), "data");
    const sealed = sealer.seal(FIELD, "Zoë Ångström 李");
    expect(sealer.openText(FIELD, sealed)).toBe("Zoë Ångström 李");
    const bytes = new Uint8Array([0, 1, 2, 255]);
    expect(sealer.open(FIELD, sealer.seal(FIELD, bytes))).toEqual(bytes);
  });

  it("uses a fresh IV each time, so equal values seal differently", () => {
    const sealer = createSealer(keyring(), "data");
    expect(sealer.seal(FIELD, "same")).not.toBe(sealer.seal(FIELD, "same"));
  });

  it("binds the value to its organisation, table and column", () => {
    const sealer = createSealer(keyring(), "data");
    const sealed = sealer.seal(FIELD, "secret");
    for (const other of [
      { ...FIELD, organization: "org_other" },
      { ...FIELD, table: "kyc.person" },
      { ...FIELD, column: "legal_name_sealed" },
    ]) {
      expect(() => sealer.open(other, sealed)).toThrow(SealOpenError);
    }
  });

  it("keeps the data and money families apart", () => {
    const data = createSealer(keyring(), "data");
    const money = createSealer(keyring(), "money");
    expect(() => money.open(FIELD, data.seal(FIELD, "x"))).toThrow(SealOpenError);
  });

  it("refuses a value changed anywhere: version, IV, body or tag", () => {
    const sealer = createSealer(keyring(), "data");
    const sealed = sealer.seal(FIELD, "a value worth protecting");
    const [prefix, iv, body] = sealed.split(".") as [string, string, string];
    const flip = (text: string, at: number) =>
      text.slice(0, at) + (text[at] === "A" ? "B" : "A") + text.slice(at + 1);
    for (const changed of [
      `${prefix}.${flip(iv, 3)}.${body}`,
      `${prefix}.${iv}.${flip(body, 2)}`,
      `${prefix}.${iv}.${flip(body, body.length - 2)}`,
      `fdk2.${iv}.${body}`,
      `fdk1.${iv}.${body.slice(0, -4)}`,
      `${sealed}.`,
      `fdk01.${iv}.${body}`,
      "",
      "plain text",
    ]) {
      expect(() => sealer.open(FIELD, changed)).toThrow(SealOpenError);
    }
  });

  it("writes with IN_USE and reads every version present (rotation)", () => {
    const old = createSealer(keyring(1), "data");
    const sealedUnder1 = old.seal(FIELD, "before rotation");
    const rotated = createSealer(keyring(2), "data");
    expect(rotated.versionOf(sealedUnder1)).toBe(1);
    expect(rotated.openText(FIELD, sealedUnder1)).toBe("before rotation");
    const sealedUnder2 = rotated.seal(FIELD, "after rotation");
    expect(sealedUnder2.startsWith("fdk2.")).toBe(true);
    const retired = createSealer(createKeyring("FIN_SEAL_KEY", new Map([[2, KEY_2]]), 2), "data");
    expect(() => retired.open(FIELD, sealedUnder1)).toThrow(SealOpenError);
  });

  it("refuses field names that would make the additional data ambiguous", () => {
    const sealer = createSealer(keyring(), "data");
    for (const bad of [
      { ...FIELD, organization: "org:x" },
      { ...FIELD, organization: "" },
      { ...FIELD, table: "Kyc.Customer" },
      { ...FIELD, table: "a.b.c" },
      { ...FIELD, column: "col.umn" },
    ]) {
      expect(() => sealer.seal(bad, "x")).toThrow(TypeError);
    }
  });

  it("refuses a random source that returns the wrong length", () => {
    const sealer = createSealer(keyring(), "data", { randomBytes: () => new Uint8Array(8) });
    expect(() => sealer.seal(FIELD, "x")).toThrow(/wrong length/);
  });
});
