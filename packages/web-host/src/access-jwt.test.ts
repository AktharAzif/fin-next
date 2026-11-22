// spec 02 §10.5's Access token check: RS256 by kid, iss, aud, exp and nbf with 60 s leeway, type
// and email, keys cached 5 minutes, an unknown kid refreshing at most every 30 s, a 5-second timeout
// failing closed. Keys and tokens are made at run time.
import { createManualClock } from "@fin/core";
import { describe, expect, it } from "vitest";
import { AccessKeysUnavailable, AccessVerifier, accessIssuer } from "./access-jwt.ts";

const TEAM = "fin-team";
const AUD = "c".repeat(64);
const NOW = Date.UTC(2026, 10, 21, 9, 0, 0);

async function keyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as { privateKey: CryptoKey; publicKey: CryptoKey };
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { kid, kty: "RSA", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e },
  };
}

// Making an RSA key pair is most of these tests' work (tens to hundreds of milliseconds each, and
// far more on a loaded machine, where four pairs in one test went over its timeout), so each kid's
// pair is made once for the file and shared: every test still builds its own verifier and certs.
const pairs = new Map<string, ReturnType<typeof keyPair>>();
function sharedPair(kid: string): ReturnType<typeof keyPair> {
  let pair = pairs.get(kid);
  if (pair === undefined) {
    pair = keyPair(kid);
    pairs.set(kid, pair);
  }
  return pair;
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

async function sign(
  key: { kid: string; privateKey: CryptoKey },
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const head = b64({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const body = b64(claims);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${Buffer.from(signature).toString("base64url")}`;
}

function claims(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(NOW / 1000);
  return {
    iss: accessIssuer(TEAM),
    aud: [AUD],
    sub: "access-subject-1",
    email: "staff.member@example.com",
    type: "app",
    iat: now,
    nbf: now,
    exp: now + 3600,
    ...patch,
  };
}

async function setup(options: { failFetch?: boolean; hang?: boolean } = {}) {
  const k1 = await sharedPair("k1");
  const k2 = await sharedPair("k2");
  let served = [k1.jwk];
  let fetches = 0;
  const urls: string[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    fetches++;
    urls.push(url);
    if (options.hang) {
      await new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }
    if (options.failFetch) return new Response("no", { status: 500 });
    return new Response(JSON.stringify({ keys: served }), { status: 200 });
  }) as unknown as typeof fetch;
  const clock = createManualClock(NOW);
  const verifier = new AccessVerifier({ team: TEAM, aud: AUD, clock, fetch: fake, timeoutMs: 50 });
  return {
    k1,
    k2,
    clock,
    verifier,
    fetches: () => fetches,
    urls,
    serve: (keys: unknown[]) => {
      served = keys as typeof served;
    },
  };
}

describe("AccessVerifier", () => {
  it("accepts a valid token from the team's certs, built from the team name", async () => {
    const { k1, verifier, urls } = await setup();
    const result = await verifier.verify(await sign(k1, claims()));
    expect(result).toEqual({
      ok: true,
      identity: { sub: "access-subject-1", email: "staff.member@example.com" },
    });
    expect(urls).toEqual(["https://fin-team.cloudflareaccess.com/cdn-cgi/access/certs"]);
    expect(() => accessIssuer("https://evil.example.com")).toThrow(TypeError);
  });

  it("refuses each bad token with its reason", async () => {
    const { k1, k2, verifier } = await setup();
    const now = Math.floor(NOW / 1000);
    const cases: [Promise<string> | string | undefined, string][] = [
      [undefined, "missing"],
      ["", "missing"],
      ["a.b", "signature"],
      ["not.a.token", "signature"],
      [sign(k1, claims(), { alg: "HS256" }), "signature"],
      [sign(k1, claims(), { alg: "none" }), "signature"],
      [sign(k2, claims()), "signature"],
      [sign(k1, claims({ iss: "https://other.cloudflareaccess.com" })), "iss"],
      [sign(k1, claims({ aud: ["d".repeat(64)] })), "aud"],
      [sign(k1, claims({ aud: AUD })), "ok"],
      [sign(k1, claims({ exp: now - 61 })), "expired"],
      [sign(k1, claims({ exp: now - 59 })), "ok"],
      [sign(k1, claims({ nbf: now + 61 })), "expired"],
      [sign(k1, claims({ nbf: now + 59 })), "ok"],
      [sign(k1, claims({ exp: undefined })), "expired"],
      [sign(k1, claims({ type: "org" })), "type"],
      [sign(k1, claims({ email: undefined })), "missing"],
      [sign(k1, claims({ sub: "" })), "missing"],
    ];
    for (const [token, reason] of cases) {
      const result = await verifier.verify(await token);
      expect(result.ok ? "ok" : result.reason, String(reason)).toBe(reason);
    }
    const good = await sign(k1, claims());
    const [h, p] = good.split(".");
    const tampered = `${h}.${p}.${Buffer.from("x".repeat(256)).toString("base64url")}`;
    expect(await verifier.verify(tampered)).toEqual({ ok: false, reason: "signature" });
    const swapped = `${h}.${b64(claims({ sub: "someone-else" }))}.${good.split(".")[2]}`;
    expect(await verifier.verify(swapped)).toEqual({ ok: false, reason: "signature" });
  });

  it("caches keys for 5 minutes and refreshes an unknown kid at most every 30 seconds", async () => {
    const { k1, k2, clock, verifier, fetches, serve } = await setup();
    await verifier.verify(await sign(k1, claims()));
    await verifier.verify(await sign(k1, claims()));
    expect(fetches()).toBe(1);
    serve([k1.jwk, k2.jwk]);
    expect((await verifier.verify(await sign(k2, claims()))).ok).toBe(true);
    expect(fetches()).toBe(2);
    const k3 = await sharedPair("k3");
    await verifier.verify(await sign(k3, claims()));
    expect(fetches()).toBe(2);
    clock.advance(30_000);
    await verifier.verify(await sign(k3, claims()));
    expect(fetches()).toBe(3);
    clock.advance(5 * 60_000);
    await verifier.verify(await sign(k1, claims({ exp: Math.floor(clock.now() / 1000) + 60 })));
    expect(fetches()).toBe(4);
  });

  it("fails closed when the certs cannot be read or time out", async () => {
    const failing = await setup({ failFetch: true });
    await expect(failing.verifier.verify(await sign(failing.k1, claims()))).rejects.toBeInstanceOf(
      AccessKeysUnavailable,
    );
    const hanging = await setup({ hang: true });
    await expect(hanging.verifier.verify(await sign(hanging.k1, claims()))).rejects.toBeInstanceOf(
      AccessKeysUnavailable,
    );
  });
});
