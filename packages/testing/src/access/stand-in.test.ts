import { createPublicKey, verify } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base64url, decodeToken, fromBase64url, unsignedToken } from "./jwt.ts";
import {
  AccessStandIn,
  isLocalPath,
  isLoopbackOrigin,
  type RunningAccessStandIn,
  startAccessStandIn,
} from "./stand-in.ts";

const AUDIENCE = ["aud", "for", "tests"].join("-");
const ISSUER = "https://fin-test.cloudflareaccess.com";
const NOW = Date.parse("2026-11-16T10:00:00Z");

function standIn(now = NOW) {
  return new AccessStandIn({ audience: AUDIENCE, issuer: ISSUER, now: () => now });
}

/** Verifies a token the way an independent verifier would: JWK import and RS256 only. */
function independentlyValid(token: string, keys: readonly { kid: string }[]): boolean {
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const { kid, alg } = JSON.parse(Buffer.from(header, "base64url").toString()) as {
    kid: string;
    alg: string;
  };
  const jwk = keys.find((key) => key.kid === kid);
  if (alg !== "RS256" || jwk === undefined) return false;
  const key = createPublicKey({ key: jwk as never, format: "jwk" });
  return verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    key,
    Buffer.from(signature, "base64url"),
  );
}

describe("tokens", () => {
  it("carries Access's application claims under RS256 and the key's kid", () => {
    const access = standIn();
    const token = access.issue({ email: "grace.hall@example.com" });
    const { header, payload } = decodeToken(token);
    expect(header).toEqual({ alg: "RS256", kid: access.currentKid, typ: "JWT" });
    expect(payload).toMatchObject({
      aud: [AUDIENCE],
      email: "grace.hall@example.com",
      iss: ISSUER,
      type: "app",
      iat: NOW / 1000,
      nbf: NOW / 1000,
      exp: NOW / 1000 + 24 * 60 * 60,
      country: "XX",
    });
    expect(payload.sub).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(typeof payload.identity_nonce).toBe("string");
  });

  it("verifies with nothing but the certs endpoint's JWK", () => {
    const access = standIn();
    const token = access.issue({ email: "grace.hall@example.com" });
    expect(independentlyValid(token, access.certs().keys)).toBe(true);
  });

  it("lists keys as RSA signing JWKs with a 64-hex kid", () => {
    const [key] = standIn().certs().keys;
    expect(key).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig", e: "AQAB" });
    expect(key?.kid).toMatch(/^[0-9a-f]{64}$/);
    expect(fromBase64url(key?.n ?? "").byteLength).toBe(256);
  });

  it("gives the same subject to the same address", () => {
    const access = standIn();
    const a = decodeToken(access.issue({ email: "grace.hall@example.com" })).payload.sub;
    const b = decodeToken(access.issue({ email: "GRACE.HALL@example.com" })).payload.sub;
    const c = decodeToken(access.issue({ email: "hiro.sato@example.com" })).payload.sub;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("refuses to issue for an address the policy does not allow", () => {
    expect(() => standIn().issue({ email: "someone@example.org" })).toThrow("does not allow");
    const wider = new AccessStandIn({
      audience: AUDIENCE,
      issuer: ISSUER,
      allowedDomains: ["example.org"],
    });
    expect(() => wider.issue({ email: "someone@example.org" })).not.toThrow();
  });

  it("needs an issuer before it can issue", () => {
    const access = new AccessStandIn({ audience: AUDIENCE });
    expect(() => access.issue({ email: "grace.hall@example.com" })).toThrow("no issuer");
    expect(() => new AccessStandIn({ audience: "" })).toThrow("audience");
  });
});

describe("verify, as Access's edge checks a token", () => {
  const access = standIn();
  const now = NOW / 1000;

  it("accepts a fresh token", () => {
    const token = access.issue({ email: "grace.hall@example.com" });
    expect(access.verify(token)).toEqual({ email: "grace.hall@example.com", token });
  });

  it.each([
    ["an expired token", { expiresAt: now - 1 }],
    ["a token that expires now", { expiresAt: now }],
    ["a token not valid yet", { notBefore: now + 60 }],
    ["another application's audience", { audience: "another-aud" }],
    ["another issuer", { issuer: "https://other.cloudflareaccess.com" }],
    ["a token that is not an app token", { type: "org" }],
    ["an unknown kid", { kid: "f".repeat(64) }],
    ["a key the certs never listed", { signWith: "stranger" as const }],
  ])("refuses %s", (_name, overrides) => {
    expect(
      access.verify(access.issue({ email: "grace.hall@example.com", ...overrides })),
    ).toBeUndefined();
  });

  it("refuses an unsigned token, a tampered payload and garbage", () => {
    const token = access.issue({ email: "grace.hall@example.com" });
    const { header, payload } = decodeToken(token);
    expect(access.verify(unsignedToken({ ...header, alg: "none" }, payload))).toBeUndefined();
    const [h, , s] = token.split(".");
    const forged = base64url(JSON.stringify({ ...payload, email: "jonas.berg@example.com" }));
    expect(access.verify(`${h}.${forged}.${s}`)).toBeUndefined();
    expect(access.verify("not-a-token")).toBeUndefined();
    expect(access.verify("a.b.c")).toBeUndefined();
  });

  it("accepts an audience among several", () => {
    const token = access.issue({ email: "grace.hall@example.com", audience: ["other", AUDIENCE] });
    expect(access.verify(token)).toBeDefined();
  });
});

describe("key rotation", () => {
  it("signs with the new key and keeps the old one listed until it is retired", () => {
    const access = standIn();
    const old = access.issue({ email: "grace.hall@example.com" });
    const oldKid = access.currentKid;
    const newKid = access.rotate();
    expect(access.currentKid).toBe(newKid);
    const fresh = access.issue({ email: "grace.hall@example.com" });
    expect(decodeToken(fresh).header.kid).toBe(newKid);
    expect(access.certs().keys.map((k) => k.kid)).toEqual([oldKid, newKid]);
    expect(access.verify(old)).toBeDefined();
    access.retire(oldKid);
    expect(access.verify(old)).toBeUndefined();
    expect(access.verify(fresh)).toBeDefined();
    expect(() => access.retire(newKid)).toThrow("at least one key");
  });
});

describe("redirect guards", () => {
  it("allows only loopback app origins and local paths", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:4102")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:4102")).toBe(true);
    expect(isLoopbackOrigin("https://staff.example.com")).toBe(false);
    expect(isLoopbackOrigin("http://127.0.0.1:4102/path")).toBe(false);
    expect(isLoopbackOrigin("javascript:alert(1)")).toBe(false);
    expect(isLocalPath("/staff?x=1")).toBe(true);
    expect(isLocalPath("//evil.example.org/")).toBe(false);
    expect(isLocalPath("/\\evil.example.org")).toBe(false);
    expect(isLocalPath("https://evil.example.org/")).toBe(false);
  });
});

describe("the stand-in's server", () => {
  let running: RunningAccessStandIn;
  beforeAll(async () => {
    running = await startAccessStandIn(new AccessStandIn({ audience: AUDIENCE }));
  });
  afterAll(async () => {
    await running.close();
  });

  it("serves the certs and uses its own origin as the issuer", async () => {
    const response = await fetch(running.certsUrl);
    expect(response.status).toBe(200);
    const certs = (await response.json()) as { keys: { kid: string }[] };
    expect(certs.keys).toHaveLength(1);
    expect(running.standIn.issuer).toBe(running.origin);
    const token = running.standIn.issue({ email: "grace.hall@example.com" });
    expect(independentlyValid(token, certs.keys)).toBe(true);
  });

  it("signs in a fixture address and sends the browser back to the app", async () => {
    const login = new URL(running.standIn.loginUrl("http://127.0.0.1:4102", "/staff"));
    login.searchParams.set("email", "grace.hall@example.com");
    const response = await fetch(login, { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("http://127.0.0.1:4102");
    expect(location.pathname).toBe("/cdn-cgi/access/authorized");
    expect(location.searchParams.get("redirect_url")).toBe("/staff");
    expect(running.standIn.verify(location.searchParams.get("token") ?? "")?.email).toBe(
      "grace.hall@example.com",
    );
  });

  it("refuses what it should", async () => {
    const at = (query: string) =>
      fetch(`${running.origin}/cdn-cgi/access/login?${query}`, { redirect: "manual" });
    expect((await at("app=http://127.0.0.1:4102&redirect_url=/")).status).toBe(401);
    expect((await at("app=http://127.0.0.1:4102&redirect_url=/&email=x@example.org")).status).toBe(
      403,
    );
    expect(
      (await at("app=https://staff.example.com&redirect_url=/&email=grace.hall@example.com"))
        .status,
    ).toBe(400);
    expect(
      (await at("app=http://127.0.0.1:4102&redirect_url=//x&email=grace.hall@example.com")).status,
    ).toBe(400);
    expect((await fetch(`${running.origin}/elsewhere`)).status).toBe(404);
    expect((await fetch(running.certsUrl, { method: "POST" })).status).toBe(405);
  });
});
