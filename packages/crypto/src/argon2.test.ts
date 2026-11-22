import { describe, expect, it } from "vitest";
import {
  ARGON2ID_DEFAULTS,
  argon2idRaw,
  hashPassword,
  needsRehash,
  PasswordHashError,
  parsePasswordHash,
  verifyPassword,
} from "./argon2.ts";
import { toHex, utf8 } from "./bytes.ts";

describe("argon2id through node:crypto", () => {
  it("matches RFC 9106 §5.3's argon2id test vector (secret and associated data included)", async () => {
    const tag = await argon2idRaw({
      message: new Uint8Array(32).fill(1),
      nonce: new Uint8Array(16).fill(2),
      secret: new Uint8Array(8).fill(3),
      associatedData: new Uint8Array(12).fill(4),
      memoryKiB: 32,
      passes: 3,
      parallelism: 4,
      tagLength: 32,
    });
    expect(toHex(tag)).toBe("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
  });

  it("writes the reference implementation's PHC string for its own test case", async () => {
    // The argon2 reference test suite: "password", salt "somesalt", m=65536, t=2, p=1.
    const phc = await hashPassword("password", {
      params: { memoryKiB: 65_536, passes: 2, parallelism: 1, tagLength: 32 },
      salt: utf8("somesalt"),
    });
    expect(phc).toBe(
      "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc",
    );
  });

  it("hashes with SA-07's parameters by default and verifies", async () => {
    const phc = await hashPassword("correct horse battery staple");
    const parsed = parsePasswordHash(phc);
    expect(parsed).toMatchObject({ memoryKiB: 19_456, passes: 2, parallelism: 1, tagLength: 32 });
    expect(parsed.salt.byteLength).toBe(16);
    expect(await verifyPassword(phc, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(phc, "correct horse battery stapl")).toBe(false);
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("normalises to NFC, so the same password typed two ways verifies", async () => {
    const phc = await hashPassword("café-pass");
    expect(await verifyPassword(phc, "café-pass")).toBe(true);
  });

  it("answers false, never throws, for a malformed or out-of-bounds stored hash", async () => {
    for (const bad of [
      "",
      "$argon2i$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc",
      "$argon2id$v=16$m=19456,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc",
      "$argon2id$v=19$m=9999999,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc",
      "$argon2id$v=19$m=19456,t=99,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc",
      "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ=$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc",
    ]) {
      expect(await verifyPassword(bad, "password")).toBe(false);
    }
  });

  it("refuses an empty or overlong password and parameters outside the bounds", async () => {
    await expect(hashPassword("")).rejects.toThrow(PasswordHashError);
    await expect(hashPassword("x".repeat(1025))).rejects.toThrow(PasswordHashError);
    await expect(
      hashPassword("x", { params: { ...ARGON2ID_DEFAULTS, memoryKiB: 1_000_000 } }),
    ).rejects.toThrow(PasswordHashError);
    await expect(
      hashPassword("x", { params: { ...ARGON2ID_DEFAULTS, parallelism: 4, memoryKiB: 16 } }),
    ).rejects.toThrow(PasswordHashError);
  });

  it("asks for a rehash when the stored cost is below the current parameters", async () => {
    const weak = await hashPassword("pw", {
      params: { memoryKiB: 8192, passes: 1, parallelism: 1, tagLength: 32 },
    });
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(await hashPassword("pw"))).toBe(false);
    expect(needsRehash("garbage")).toBe(true);
  });
});
