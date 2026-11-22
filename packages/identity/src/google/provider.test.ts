// Fin's Google provider without a database (spec 02 §5.8): the authorization URL it builds, the
// exchange and the ID token check that the realm runs before a unit of work opens (only for a
// state cookie the realm signed, and only once the realm's claim says so), how it reads the token
// endpoint's answers, the provider key cache, and that the library's calls inside the unit only
// ever read that prefetched outcome.
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../ports/clock.ts";
import { MemoryLineSink } from "../ports/log.ts";
import { type GoogleFlow, newGoogleFlow } from "./flow.ts";
import { createGoogleSignIn } from "./provider.ts";
import { fixtureEndpoints, type GoogleSettings } from "./settings.ts";
import type { StateClaim, StoredState } from "./state.ts";

const ISSUER = "https://issuer.test.example.com";
const settings: GoogleSettings = {
  clientId: "fin-console.apps.example.com",
  clientSecret: `${"s".repeat(12)}0123456789`,
  redirectUri: "https://console.example.com/api/auth/callback/google",
  endpoints: fixtureEndpoints(ISSUER),
};
/** The realm's newest secret, which signs the state cookie (made at run time). */
const SECRET = randomBytes(32).toString("base64url");

function signingKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" },
  };
}
type SigningKey = ReturnType<typeof signingKey>;
const K1 = signingKey("k1");
const K2 = signingKey("k2");
const K3 = signingKey("k3");
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function idToken(claims: Record<string, unknown>, key: SigningKey = K1): string {
  const input = `${b64({ alg: "RS256", kid: key.kid })}.${b64(claims)}`;
  return `${input}.${sign("sha256", Buffer.from(input), key.privateKey).toString("base64url")}`;
}

/** A cookie value as the library signs it: `<value>.<base64 HMAC-SHA256>`, URL-encoded. */
function signedCookie(value: string, secret = SECRET): string {
  const signature = createHmac("sha256", secret).update(value).digest("base64");
  return encodeURIComponent(`${value}.${signature}`);
}

const STATE = "s".repeat(32);
const VERIFIER = "v".repeat(64);
const NONCE = "n".repeat(32);
const STORED: StoredState = {
  codeVerifier: VERIFIER,
  idTokenNonce: NONCE,
  linkIntentId: "sti_01jd0000000000000000000000",
  errorURL: "https://console.example.com/sign-in",
  claimed: false,
};

interface Calls {
  token: number;
  jwks: number;
  claims: string[];
  lastTokenBody: URLSearchParams | null;
}

function setup(
  options: { token?: () => Response; jwks?: () => Response; claim?: StateClaim } = {},
) {
  const clock = new ManualClock(new Date("2026-11-21T12:00:00Z"));
  const lines = new MemoryLineSink();
  let flow: GoogleFlow = newGoogleFlow();
  const calls: Calls = { token: 0, jwks: 0, claims: [], lastTokenBody: null };
  // Which key signs the provider's next token, and which keys its JWKS lists.
  const keys: { signer: SigningKey; listed: SigningKey[] } = { signer: K1, listed: [K1] };
  const now = () => Math.floor(clock.now().getTime() / 1000);
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === settings.endpoints.token) {
      calls.token += 1;
      calls.lastTokenBody = new URLSearchParams(String(init?.body));
      return (
        options.token?.() ??
        Response.json({
          id_token: idToken(
            {
              iss: ISSUER,
              aud: settings.clientId,
              sub: "1234",
              email: "maya@example.com",
              email_verified: true,
              nonce: NONCE,
              iat: now(),
              exp: now() + 3600,
            },
            keys.signer,
          ),
        })
      );
    }
    if (url === settings.endpoints.jwks) {
      calls.jwks += 1;
      return options.jwks?.() ?? Response.json({ keys: keys.listed.map((k) => k.jwk) });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const google = createGoogleSignIn({
    settings,
    clock,
    lines,
    realm: "developer",
    stateCookie: "__Host-fin.state",
    stateSecret: SECRET,
    flow: () => flow,
    fetch: fakeFetch,
  });
  // The realm's short unit, as the provider sees it: counted, then the state claimed.
  const claim = async (state: string): Promise<StateClaim> => {
    calls.claims.push(state);
    if (options.claim !== undefined) return options.claim;
    return state === STATE ? { kind: "claimed", stored: STORED } : { kind: "none" };
  };
  const callback = (cookie: string | null = signedCookie(STATE)) =>
    new Request(
      `https://console.example.com/api/auth/callback/google?code=the-code&state=${STATE}`,
      cookie === null ? {} : { headers: { cookie: `__Host-fin.state=${cookie}` } },
    );
  return {
    google,
    clock,
    lines,
    calls,
    keys,
    claim,
    callback,
    flow: () => flow,
    reset: () => {
      flow = newGoogleFlow();
    },
  };
}

type Provider = {
  createAuthorizationURL(input: Record<string, unknown>): URL;
  validateAuthorizationCode(input: Record<string, unknown>): Promise<unknown>;
  getUserInfo(tokens: Record<string, unknown>): Promise<unknown>;
  accountSubject(input: { profile: Record<string, unknown> }): string;
};

describe("the authorization URL", () => {
  const { google } = setup();
  const provider = google.provider as unknown as Provider;

  it("asks for a code with PKCE (S256), the nonce, the exact redirect URI and the account chooser", () => {
    const url = provider.createAuthorizationURL({
      state: STATE,
      codeVerifier: VERIFIER,
      redirectURI: settings.redirectUri,
      idTokenNonce: NONCE,
    });
    expect(`${url.origin}${url.pathname}`).toBe(settings.endpoints.authorization);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: settings.clientId,
      redirect_uri: settings.redirectUri,
      scope: "openid email profile",
      state: STATE,
      code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
      code_challenge_method: "S256",
      nonce: NONCE,
      prompt: "select_account",
    });
  });

  it("refuses to start without a nonce, or towards another redirect URI", () => {
    const base = { state: STATE, codeVerifier: VERIFIER, redirectURI: settings.redirectUri };
    expect(() => provider.createAuthorizationURL(base)).toThrow(/nonce/);
    expect(() =>
      provider.createAuthorizationURL({
        ...base,
        idTokenNonce: NONCE,
        redirectURI: "https://console-api.example.com/api/auth/callback/google",
      }),
    ).toThrow(/redirect URI/);
  });

  it("keys the account by the subject only", () => {
    expect(provider.accountSubject({ profile: { sub: "1234", email: "x@example.com" } })).toBe(
      "1234",
    );
    expect(() => provider.accountSubject({ profile: { email: "x@example.com" } })).toThrow();
  });
});

describe("the prefetch and the library's calls", () => {
  it("exchanges the code with the verifier and redirect URI, then answers only that code", async () => {
    const s = setup();
    const provider = s.google.provider as unknown as Provider;
    expect(await s.google.prefetch(s.callback(), s.claim)).toBeNull();
    expect(s.calls.claims).toEqual([STATE]);
    expect(s.calls.token).toBe(1);
    expect(Object.fromEntries(s.calls.lastTokenBody ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: VERIFIER,
      redirect_uri: settings.redirectUri,
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
    });
    const prefetched = s.flow().prefetched;
    expect(prefetched?.kind).toBe("token");
    expect(prefetched?.linkIntentId).toBe("sti_01jd0000000000000000000000");
    const right = { code: "the-code", codeVerifier: VERIFIER, redirectURI: settings.redirectUri };
    expect(await provider.validateAuthorizationCode({ ...right, code: "other" })).toBeNull();
    expect(await provider.validateAuthorizationCode({ ...right, codeVerifier: "x" })).toBeNull();
    expect(
      await provider.validateAuthorizationCode({
        ...right,
        redirectURI: "https://elsewhere.example.com",
      }),
    ).toBeNull();
    const tokens = (await provider.validateAuthorizationCode(right)) as { idToken: string };
    expect(Object.keys(tokens).sort()).toEqual(["idToken", "tokenType"]);
    // The nonce the library parsed from the state must be the one the token was checked against.
    expect(await provider.getUserInfo({ ...tokens, expectedIdTokenNonce: "other" })).toBeNull();
    expect(await provider.getUserInfo({ ...tokens })).toBeNull();
    expect(
      await provider.getUserInfo({ idToken: "other", expectedIdTokenNonce: NONCE }),
    ).toBeNull();
    expect(await provider.getUserInfo({ ...tokens, expectedIdTokenNonce: NONCE })).toEqual({
      user: { email: "maya@example.com", emailVerified: true, name: "" },
      data: { sub: "1234", email: "maya@example.com", email_verified: true },
    });
    expect(s.flow().claims?.sub).toBe("1234");
  });

  it("answers nothing inside the unit without a prefetch, so the library never fetches there", async () => {
    const s = setup();
    const provider = s.google.provider as unknown as Provider;
    expect(
      await provider.validateAuthorizationCode({
        code: "the-code",
        codeVerifier: VERIFIER,
        redirectURI: settings.redirectUri,
      }),
    ).toBeNull();
    expect(await provider.getUserInfo({ idToken: "x", expectedIdTokenNonce: NONCE })).toBeNull();
    expect(s.calls.token + s.calls.jwks).toBe(0);
  });

  it.each([
    ["no state cookie", null],
    ["a cookie for another state", signedCookie("another-state-value-0123456789ab")],
    ["a made-up signature", encodeURIComponent(`${STATE}.forged-signature`)],
    ["a signature under another secret", signedCookie(STATE, "another-secret-0123456789abcdef")],
    [
      "a signature in another encoding",
      encodeURIComponent(`${STATE}.${createHmac("sha256", SECRET).update(STATE).digest("hex")}`),
    ],
    ["no signature at all", STATE],
    ["a value that is not URL-encoded right", `${STATE}.%E0%A4%A`],
  ])("neither claims nor exchanges for %s", async (_label, cookie) => {
    const s = setup();
    expect(await s.google.prefetch(s.callback(cookie), s.claim)).toBeNull();
    // The cookie is checked before the realm's short unit: nothing reaches the database.
    expect(s.calls.claims).toEqual([]);
    expect(s.calls.token).toBe(0);
    expect(s.flow().prefetched).toBeNull();
  });

  it("exchanges nothing for a callback without a code or state", async () => {
    const s = setup();
    await s.google.prefetch(
      new Request("https://console.example.com/api/auth/callback/google?code=x", {
        headers: { cookie: `__Host-fin.state=${signedCookie(STATE)}` },
      }),
      s.claim,
    );
    expect(s.calls.claims).toEqual([]);
    expect(s.calls.token).toBe(0);
  });

  it("exchanges nothing for an unknown or expired state", async () => {
    const s = setup({ claim: { kind: "none" } });
    expect(await s.google.prefetch(s.callback(), s.claim)).toBeNull();
    expect(s.calls.claims).toEqual([STATE]);
    expect(s.calls.token).toBe(0);
    expect(s.flow().prefetched).toBeNull();
    expect(s.flow().spentState).toBeNull();
  });

  it("exchanges nothing for a state another callback holds, and marks it spent for the before-hook", async () => {
    const s = setup({ claim: { kind: "spent", stored: { ...STORED, claimed: true } } });
    expect(await s.google.prefetch(s.callback(), s.claim)).toBeNull();
    expect(s.calls.token).toBe(0);
    expect(s.flow().prefetched).toBeNull();
    expect(s.flow().spentState).toEqual({ errorURL: "https://console.example.com/sign-in" });
  });

  it("exchanges nothing past the network's allowance, and asks the realm to refuse", async () => {
    const s = setup({ claim: { kind: "limited", retryAfter: 42 } });
    expect(await s.google.prefetch(s.callback(), s.claim)).toEqual({ retryAfter: 42 });
    expect(s.calls.token).toBe(0);
    expect(s.flow().prefetched).toBeNull();
  });

  it("records a failed exchange and an unavailable key set, each with its line", async () => {
    const failing = setup({ token: () => new Response("down", { status: 503 }) });
    await failing.google.prefetch(failing.callback(), failing.claim);
    expect(failing.flow().prefetched).toMatchObject({ kind: "failed", failure: "token_exchange" });
    expect(failing.lines.named("auth.google_failed")).toEqual([
      { realm: "developer", reason: "token_exchange" },
    ]);
    const noKeys = setup({ jwks: () => new Response("down", { status: 503 }) });
    await noKeys.google.prefetch(noKeys.callback(), noKeys.claim);
    expect(noKeys.flow().prefetched).toMatchObject({ kind: "failed", failure: "jwks" });
    expect(noKeys.lines.named("auth.google_failed")).toEqual([
      { realm: "developer", reason: "jwks" },
    ]);
  });

  it("reads a refused code (invalid_grant) as the client's refusal, not a failure", async () => {
    const s = setup({ token: () => Response.json({ error: "invalid_grant" }, { status: 400 }) });
    expect(await s.google.prefetch(s.callback(), s.claim)).toBeNull();
    expect(s.calls.token).toBe(1);
    expect(s.flow().prefetched).toMatchObject({ kind: "refused", code: "the-code" });
    expect(s.lines.named("auth.google_failed")).toEqual([]);
    const provider = s.google.provider as unknown as Provider;
    expect(
      await provider.validateAuthorizationCode({
        code: "the-code",
        codeVerifier: VERIFIER,
        redirectURI: settings.redirectUri,
      }),
    ).toBeNull();
  });

  it.each([
    ["another error", () => Response.json({ error: "invalid_request" }, { status: 400 })],
    ["a refused client", () => Response.json({ error: "invalid_client" }, { status: 401 })],
    ["invalid_grant with the wrong status", () => Response.json({ error: "invalid_grant" })],
    ["an unreadable error", () => new Response("<html>", { status: 400 })],
    ["a server error", () => Response.json({ error: "invalid_grant" }, { status: 500 })],
    ["an answer without an ID token", () => Response.json({ access_token: "x" })],
    ["an answer that is not an object", () => Response.json(null)],
    [
      "a timeout",
      () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    ],
  ])("reads %s from the token endpoint as a failure", async (_label, token) => {
    const s = setup({ token });
    await s.google.prefetch(s.callback(), s.claim);
    expect(s.flow().prefetched).toMatchObject({ kind: "failed", failure: "token_exchange" });
    expect(s.lines.named("auth.google_failed")).toEqual([
      { realm: "developer", reason: "token_exchange" },
    ]);
  });

  it("keeps the provider's keys for an hour, and asks again for an unknown kid at most once a minute", async () => {
    const s = setup();
    const prefetch = async () => {
      s.reset();
      await s.google.prefetch(s.callback(), s.claim);
      return s.flow().prefetched;
    };
    const verified = { kind: "token", result: { ok: true } };
    const unknown = { kind: "token", result: { ok: false, reason: "unknown_key" } };
    // The first sign-in fetches the keys; another within the hour reads them from the cache.
    expect(await prefetch()).toMatchObject(verified);
    expect(await prefetch()).toMatchObject(verified);
    expect(s.calls.jwks).toBe(1);
    // A token under a kid the cached set does not list, within a minute of the last fetch: the
    // keys are not fetched again, and the token is refused.
    s.keys.signer = K2;
    s.clock.advance(30 * 1000);
    expect(await prefetch()).toMatchObject(unknown);
    expect(s.calls.jwks).toBe(1);
    expect(s.lines.named("auth.google_failed").at(-1)).toEqual({
      realm: "developer",
      reason: "unknown_key",
    });
    // The provider has rotated its keys; past the minute, the unknown kid fetches the set once,
    // and its token verifies.
    s.keys.listed = [K1, K2];
    s.clock.advance(31 * 1000);
    expect(await prefetch()).toMatchObject(verified);
    expect(s.calls.jwks).toBe(2);
    // A kid the new set does not list either, within the minute of that fetch: no fetch.
    s.keys.signer = K3;
    s.clock.advance(59 * 1000);
    expect(await prefetch()).toMatchObject(unknown);
    expect(s.calls.jwks).toBe(2);
    // A listed kid reads the cache; past the hour, the set is fetched again even for it.
    s.keys.signer = K1;
    expect(await prefetch()).toMatchObject(verified);
    expect(s.calls.jwks).toBe(2);
    s.clock.advance(61 * 60 * 1000);
    expect(await prefetch()).toMatchObject(verified);
    expect(s.calls.jwks).toBe(3);
  });
});
