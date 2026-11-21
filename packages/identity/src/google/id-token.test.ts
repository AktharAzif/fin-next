// The ID token check (spec 02 §5.8; OIDC Core §3.1.3.7) on known keys and hand-made tokens: every
// refusal the verifier has, and the claims it reads from a good token.
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type IdTokenExpectations,
  keysFromJwks,
  MAX_TOKEN_AGE_SECONDS,
  tokenKeyId,
  verifyIdToken,
} from "./id-token.ts";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const kid = createHash("sha256").update(String(jwk.n)).digest("hex").slice(0, 16);
  return { privateKey, publicKey, kid, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

const key = makeKey();
const stranger = makeKey();
const NOW = Date.parse("2026-11-21T12:00:00Z");
const nowS = NOW / 1000;
const CLIENT = "fin-console.apps.example.com";

const expect_: IdTokenExpectations = {
  issuers: ["https://accounts.google.com", "accounts.google.com"],
  clientId: CLIENT,
  nonce: "nonce-for-the-id-token-tests-only",
  now: NOW,
};

const good = {
  iss: "https://accounts.google.com",
  aud: CLIENT,
  azp: CLIENT,
  sub: "110169484474386276334",
  email: "Maya.Rivera@Example.com",
  email_verified: true,
  name: "Maya Rivera",
  nonce: expect_.nonce,
  iat: nowS - 10,
  exp: nowS + 3590,
};

function token(
  claims: Record<string, unknown>,
  options: {
    alg?: string;
    kid?: string;
    signer?: KeyObject;
    header?: Record<string, unknown>;
  } = {},
): string {
  const header = {
    alg: options.alg ?? "RS256",
    kid: options.kid ?? key.kid,
    typ: "JWT",
    ...options.header,
  };
  const input = `${b64(header)}.${b64(claims)}`;
  const signature = sign("sha256", Buffer.from(input), options.signer ?? key.privateKey);
  return `${input}.${signature.toString("base64url")}`;
}

const keys = async (kid: string) => (kid === key.kid ? key.publicKey : null);

describe("verifyIdToken", () => {
  it("accepts a good token and reads its claims, the address lower-cased", async () => {
    const result = await verifyIdToken(token(good), expect_, keys);
    expect(result).toEqual({
      ok: true,
      claims: {
        sub: good.sub,
        email: "maya.rivera@example.com",
        emailVerified: true,
        name: "Maya Rivera",
        issuedAt: good.iat,
      },
    });
  });

  it("accepts the issuer without a scheme, a string email_verified, and several audiences with azp", async () => {
    for (const claims of [
      { ...good, iss: "accounts.google.com" },
      { ...good, email_verified: "true" },
      { ...good, aud: [CLIENT, "other.apps.example.com"], azp: CLIENT },
      { ...good, azp: undefined },
    ]) {
      expect((await verifyIdToken(token(claims), expect_, keys)).ok).toBe(true);
    }
  });

  it.each([
    ["malformed", "not-a-token"],
    ["malformed", "a.b"],
    ["malformed", `${b64({ alg: "RS256" })}.not-json.sig`],
  ])("refuses %s input", async (reason, input) => {
    expect(await verifyIdToken(input, expect_, keys)).toEqual({ ok: false, reason });
  });

  it.each([
    ["algorithm", () => `${b64({ alg: "none" })}.${b64(good)}.`],
    ["algorithm", () => token(good, { alg: "HS256" })],
    ["algorithm", () => token(good, { header: { crit: ["exp"] } })],
    ["unknown_key", () => token(good, { kid: "nope" })],
    ["unknown_key", () => token(good, { header: { kid: undefined } })],
    ["signature", () => token(good, { signer: stranger.privateKey })],
    ["signature", () => `${token(good).slice(0, -4)}AAAA`],
    ["issuer", () => token({ ...good, iss: "https://issuer.example.org" })],
    ["audience", () => token({ ...good, aud: "other.apps.example.com", azp: undefined })],
    ["audience", () => token({ ...good, aud: [CLIENT, "other"], azp: "other" })],
    ["audience", () => token({ ...good, aud: [CLIENT, "other"], azp: undefined })],
    ["audience", () => token({ ...good, azp: "other" })],
    ["expired", () => token({ ...good, exp: nowS - 61 })],
    ["expired", () => token({ ...good, exp: undefined })],
    ["issued_at", () => token({ ...good, iat: nowS + 120 })],
    ["issued_at", () => token({ ...good, iat: nowS - MAX_TOKEN_AGE_SECONDS - 1 })],
    ["nonce", () => token({ ...good, nonce: "another" })],
    ["nonce", () => token({ ...good, nonce: undefined })],
    ["subject", () => token({ ...good, sub: "" })],
    ["subject", () => token({ ...good, sub: 42 })],
    ["email", () => token({ ...good, email: undefined })],
    ["email", () => token({ ...good, email: "not-an-address" })],
    ["email_unverified", () => token({ ...good, email_verified: false })],
    ["email_unverified", () => token({ ...good, email_verified: undefined })],
  ])("refuses a token with a fault: %s", async (reason, make) => {
    expect(await verifyIdToken(make(), expect_, keys)).toEqual({ ok: false, reason });
  });

  it("allows a minute of clock skew either way", async () => {
    expect((await verifyIdToken(token({ ...good, exp: nowS - 30 }), expect_, keys)).ok).toBe(true);
    expect((await verifyIdToken(token({ ...good, iat: nowS + 30 }), expect_, keys)).ok).toBe(true);
  });

  it("reads the kid of a header", () => {
    expect(tokenKeyId(token(good))).toBe(key.kid);
    expect(tokenKeyId("x.y.z")).toBeNull();
  });
});

describe("keysFromJwks", () => {
  it("keeps the RSA signing keys of 2048 bits or more, by kid, and skips the rest", () => {
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({
      format: "jwk",
    });
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({
      format: "jwk",
    });
    const keys = keysFromJwks({
      keys: [
        key.jwk,
        { ...stranger.jwk, use: "enc" },
        { ...stranger.jwk, kid: "hs", alg: "HS256" },
        { ...small, kid: "small" },
        { ...ec, kid: "ec" },
        { ...key.jwk, kid: "" },
        "junk",
      ],
    });
    expect([...keys.keys()]).toEqual([key.kid]);
    expect(keysFromJwks(null).size).toBe(0);
    expect(keysFromJwks({ keys: "x" }).size).toBe(0);
  });
});
