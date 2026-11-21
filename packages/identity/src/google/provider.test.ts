// Fin's Google provider without a database (spec 02 §5.8): the authorization URL it builds, the
// exchange and the ID token check that the realm runs before a unit of work opens, the provider
// key cache, and that the library's calls inside the unit only ever read that prefetched outcome.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../ports/clock.ts";
import { MemoryLineSink } from "../ports/log.ts";
import { type GoogleFlow, newGoogleFlow } from "./flow.ts";
import { createGoogleSignIn, LINK_INTENT_KEY, stateIdentifier } from "./provider.ts";
import { fixtureEndpoints, type GoogleSettings } from "./settings.ts";

const ISSUER = "https://issuer.test.example.com";
const settings: GoogleSettings = {
  clientId: "fin-console.apps.example.com",
  clientSecret: `${"s".repeat(12)}0123456789`,
  redirectUri: "https://console.example.com/api/auth/callback/google",
  endpoints: fixtureEndpoints(ISSUER),
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function idToken(claims: Record<string, unknown>): string {
  const input = `${b64({ alg: "RS256", kid: "k1" })}.${b64(claims)}`;
  return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
}

const STATE = "s".repeat(32);
const VERIFIER = "v".repeat(64);
const NONCE = "n".repeat(32);

interface Calls {
  token: number;
  jwks: number;
  lastTokenBody: URLSearchParams | null;
}

function setup(options: { token?: () => Response; jwks?: () => Response } = {}) {
  const clock = new ManualClock(new Date("2026-11-21T12:00:00Z"));
  const lines = new MemoryLineSink();
  let flow: GoogleFlow = newGoogleFlow();
  const calls: Calls = { token: 0, jwks: 0, lastTokenBody: null };
  const now = () => Math.floor(clock.now().getTime() / 1000);
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === settings.endpoints.token) {
      calls.token += 1;
      calls.lastTokenBody = new URLSearchParams(String(init?.body));
      return (
        options.token?.() ??
        Response.json({
          id_token: idToken({
            iss: ISSUER,
            aud: settings.clientId,
            sub: "1234",
            email: "maya@example.com",
            email_verified: true,
            nonce: NONCE,
            iat: now(),
            exp: now() + 3600,
          }),
        })
      );
    }
    if (url === settings.endpoints.jwks) {
      calls.jwks += 1;
      return options.jwks?.() ?? Response.json({ keys: [jwk] });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const google = createGoogleSignIn({
    settings,
    clock,
    lines,
    realm: "developer",
    stateCookie: "__Host-fin.state",
    flow: () => flow,
    fetch: fakeFetch,
  });
  const stored = JSON.stringify({
    callbackURL: "https://console.example.com/sign-in",
    codeVerifier: VERIFIER,
    idTokenNonce: NONCE,
    expiresAt: Date.now() + 600_000,
    serverContext: { [LINK_INTENT_KEY]: "sti_01jd0000000000000000000000" },
  });
  const callback = (cookieState = STATE) =>
    new Request(
      `https://console.example.com/api/auth/callback/google?code=the-code&state=${STATE}`,
      { headers: { cookie: `__Host-fin.state=${encodeURIComponent(`${cookieState}.signature`)}` } },
    );
  const readState = async (identifier: string) =>
    identifier === stateIdentifier(STATE) ? stored : null;
  return {
    google,
    clock,
    lines,
    calls,
    callback,
    readState,
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
    await s.google.prefetch(s.callback(), s.readState);
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

  it("exchanges nothing for a browser without the state's cookie, or for an unknown state", async () => {
    const s = setup();
    await s.google.prefetch(s.callback("another-state-value-0123456789ab"), s.readState);
    await s.google.prefetch(
      new Request("https://console.example.com/api/auth/callback/google?code=x"),
      s.readState,
    );
    await s.google.prefetch(s.callback(), async () => null);
    expect(s.calls.token).toBe(0);
    expect(s.flow().prefetched).toBeNull();
  });

  it("records a failed exchange and an unavailable key set, each with its line", async () => {
    const failing = setup({ token: () => new Response("no", { status: 400 }) });
    await failing.google.prefetch(failing.callback(), failing.readState);
    expect(failing.flow().prefetched).toMatchObject({ failure: "token_exchange" });
    expect(failing.lines.named("auth.google_failed")).toEqual([
      { realm: "developer", reason: "token_exchange" },
    ]);
    const noKeys = setup({ jwks: () => new Response("down", { status: 503 }) });
    await noKeys.google.prefetch(noKeys.callback(), noKeys.readState);
    expect(noKeys.flow().prefetched).toMatchObject({ failure: "jwks" });
    expect(noKeys.lines.named("auth.google_failed")).toEqual([
      { realm: "developer", reason: "jwks" },
    ]);
  });

  it("keeps the provider's keys for an hour and asks again for a new kid at most once a minute", async () => {
    const s = setup();
    await s.google.prefetch(s.callback(), s.readState);
    s.reset();
    await s.google.prefetch(s.callback(), s.readState);
    expect(s.calls.jwks).toBe(1);
    s.clock.advance(61 * 60 * 1000);
    s.reset();
    await s.google.prefetch(s.callback(), s.readState);
    expect(s.calls.jwks).toBe(2);
  });
});
