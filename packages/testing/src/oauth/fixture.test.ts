// The fixture OpenID provider answers as Google's endpoints do, and refuses what Google refuses:
// an unknown client or redirect URI, no scope, no state, no S256 challenge, no nonce; a reused or
// expired code, another client, another redirect URI, a wrong verifier. Its ID tokens verify under
// its JWKS, and carry what the granted scope allows.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeToken, verifyRs256 } from "../access/jwt.ts";
import { type FixtureAccount, OAuthFixture } from "./fixture.ts";

const ISSUER = "http://127.0.0.1:4999";
const REDIRECT = "https://console.example.com/api/auth/callback/google";
// The client's secret and a wrong one are made at run time (a literal would be a secret's shape).
const CLIENT = {
  clientId: "fixture-client",
  clientSecret: randomBytes(18).toString("base64url"),
  redirectUris: [REDIRECT],
};
const WRONG_SECRET = randomBytes(18).toString("base64url");
const MAYA: FixtureAccount = { sub: "1001", email: "maya@example.com", name: "Maya Rivera" };

function setup(now = () => Date.parse("2026-11-21T12:00:00Z")) {
  const fixture = new OAuthFixture({ issuer: ISSUER, now });
  fixture.registerClient(CLIENT);
  return fixture;
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeUrl(params: Record<string, string | null>): string {
  const url = new URL("/authorize", ISSUER);
  const defaults: Record<string, string> = {
    client_id: CLIENT.clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid email profile",
    state: "state-1",
    code_challenge: pkce().challenge,
    code_challenge_method: "S256",
    nonce: "nonce-1",
  };
  for (const [key, value] of Object.entries({ ...defaults, ...params })) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.href;
}

async function codeFor(
  fixture: OAuthFixture,
  challenge: string,
  nonce = "nonce-1",
  params: Record<string, string> = {},
) {
  fixture.chooseNext(MAYA);
  const answer = await fixture.handle(
    new Request(authorizeUrl({ code_challenge: challenge, nonce, ...params })),
  );
  expect(answer.status).toBe(302);
  const back = new URL(String(answer.headers.get("location")));
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("state-1");
  return String(back.searchParams.get("code"));
}

function tokenRequest(form: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`${ISSUER}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

describe("the fixture's authorization endpoint", () => {
  it.each([
    ["an unknown client", { client_id: "other" }],
    ["a redirect URI that is not exactly registered", { redirect_uri: `${REDIRECT}/` }],
    ["another response type", { response_type: "token" }],
    ["no scope", { scope: null }],
    ["an empty scope", { scope: " " }],
    ["no state", { state: null }],
    ["a plain challenge", { code_challenge_method: "plain" }],
    ["no challenge", { code_challenge: null }],
    ["no nonce", { nonce: null }],
  ])("refuses %s", async (_label, params) => {
    const fixture = setup();
    fixture.chooseNext(MAYA);
    const answer = await fixture.handle(new Request(authorizeUrl(params)));
    expect(answer.status).toBe(400);
    expect(fixture.authorizations.at(-1)?.outcome).toBe("refused");
  });

  it("shows the account chooser with no account chosen, and signs in the one picked", async () => {
    const fixture = setup();
    fixture.addAccount(MAYA);
    const page = await fixture.handle(new Request(authorizeUrl({})));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Choose an account");
    expect(html).toContain("maya@example.com");
    const request = /name="request" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const form = new FormData();
    form.set("request", request);
    form.set("sub", MAYA.sub);
    const chosen = await fixture.handle(
      new Request(`${ISSUER}/authorize/choose`, { method: "POST", body: form }),
    );
    expect(chosen.status).toBe(302);
    expect(new URL(String(chosen.headers.get("location"))).searchParams.get("code")).toBeTruthy();
    // The chooser's request works once.
    const again = await fixture.handle(
      new Request(`${ISSUER}/authorize/choose`, { method: "POST", body: form }),
    );
    expect(again.status).toBe(400);
  });

  it("sends the person back with access_denied when they cancel", async () => {
    const fixture = setup();
    fixture.chooseNext("deny");
    const answer = await fixture.handle(new Request(authorizeUrl({})));
    const back = new URL(String(answer.headers.get("location")));
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("state-1");
  });
});

describe("the fixture's token endpoint", () => {
  it("issues an ID token for the code, the verifier and the same redirect URI, verifiable under its JWKS", async () => {
    const fixture = setup();
    const { verifier, challenge } = pkce();
    const code = await codeFor(fixture, challenge);
    const answer = await fixture.handle(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
      }),
    );
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { id_token: string; token_type: string };
    expect(body.token_type).toBe("Bearer");
    const decoded = decodeToken(body.id_token);
    expect(verifyRs256(decoded, fixture.jwks().keys[0] ?? {})).toBe(true);
    expect(decoded.payload).toMatchObject({
      iss: ISSUER,
      aud: CLIENT.clientId,
      azp: CLIENT.clientId,
      sub: MAYA.sub,
      email: MAYA.email,
      email_verified: true,
      name: MAYA.name,
      nonce: "nonce-1",
    });
    expect(fixture.exchanges.at(-1)).toMatchObject({ outcome: "issued", pkce: true });
  });

  it("carries the address only for the email scope, and the name only for profile", async () => {
    const fixture = setup();
    const exchange = async (scope: string) => {
      const { verifier, challenge } = pkce();
      const code = await codeFor(fixture, challenge, "nonce-1", { scope });
      const answer = await fixture.handle(
        tokenRequest({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
          client_id: CLIENT.clientId,
          client_secret: CLIENT.clientSecret,
        }),
      );
      expect(answer.status).toBe(200);
      return (await answer.json()) as { id_token?: string; scope: string };
    };
    const openid = await exchange("openid");
    expect(openid.scope).toBe("openid");
    const bare = decodeToken(String(openid.id_token)).payload;
    expect(bare).toMatchObject({ sub: MAYA.sub, nonce: "nonce-1" });
    expect(bare).not.toHaveProperty("email");
    expect(bare).not.toHaveProperty("email_verified");
    expect(bare).not.toHaveProperty("name");
    const email = decodeToken(String((await exchange("openid email")).id_token)).payload;
    expect(email).toMatchObject({ email: MAYA.email, email_verified: true });
    expect(email).not.toHaveProperty("name");
  });

  it("answers no ID token for a scope with no identity in it", async () => {
    const fixture = setup();
    const { verifier, challenge } = pkce();
    const scope = "https://www.googleapis.com/auth/drive.file";
    const code = await codeFor(fixture, challenge, "nonce-1", { scope });
    const answer = await fixture.handle(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
      }),
    );
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as Record<string, unknown>;
    expect(body.scope).toBe(scope);
    expect(body).not.toHaveProperty("id_token");
    expect(typeof body.access_token).toBe("string");
  });

  it("takes the client's credentials by HTTP Basic too", async () => {
    const fixture = setup();
    const { verifier, challenge } = pkce();
    const code = await codeFor(fixture, challenge);
    const basic = Buffer.from(`${CLIENT.clientId}:${CLIENT.clientSecret}`).toString("base64");
    const answer = await fixture.handle(
      tokenRequest(
        { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT },
        { authorization: `Basic ${basic}` },
      ),
    );
    expect(answer.status).toBe(200);
  });

  it.each([
    ["a wrong verifier", { code_verifier: randomBytes(48).toString("base64url") }, "invalid_grant"],
    ["no verifier", { code_verifier: "" }, "invalid_grant"],
    ["another redirect URI", { redirect_uri: `${REDIRECT}?x=1` }, "invalid_grant"],
    ["a wrong secret", { client_secret: WRONG_SECRET }, "invalid_client"],
    ["another grant", { grant_type: "refresh_token" }, "unsupported_grant_type"],
  ])("refuses %s", async (_label, overrides, error) => {
    const fixture = setup();
    const { verifier, challenge } = pkce();
    const code = await codeFor(fixture, challenge);
    const answer = await fixture.handle(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
        ...overrides,
      }),
    );
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(await answer.json()).toEqual({ error });
  });

  it("takes a code once, and not after it expires", async () => {
    let now = Date.parse("2026-11-21T12:00:00Z");
    const fixture = setup(() => now);
    const { verifier, challenge } = pkce();
    const form = (code: string) =>
      tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
      });
    const code = await codeFor(fixture, challenge);
    expect((await fixture.handle(form(code))).status).toBe(200);
    expect((await fixture.handle(form(code))).status).toBe(400);
    const late = await codeFor(fixture, challenge);
    now += 61_000;
    expect((await fixture.handle(form(late))).status).toBe(400);
  });

  it("plants the faults its tests ask for", async () => {
    const fixture = setup();
    const { verifier, challenge } = pkce();
    fixture.tamperNext("nonce");
    const code = await codeFor(fixture, challenge);
    const answer = await fixture.handle(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
      }),
    );
    const body = (await answer.json()) as { id_token: string };
    expect(decodeToken(body.id_token).payload.nonce).not.toBe("nonce-1");
  });
});
