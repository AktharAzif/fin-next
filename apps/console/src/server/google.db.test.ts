// Google sign-in through the console's whole front door (spec 02 §2.2, §2.3, §5.8; stretch 5): the
// API half booted on a real socket with the ingress check and the origin gate, the developer realm
// behind, Postgres 18 as the console's own login, and the fixture OpenID provider on loopback.
// `GET /api/sign-in/methods` says whether the pages offer Google; the round trip starts with a
// gated POST, comes back on the one ungated GET the gate exempts (a POST there is refused), and
// leaves a session the console's own routes accept, down to the first organisation.
import { randomBytes } from "node:crypto";
import { bootApi } from "@fin/web-host/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../../packages/orgs/test/index.ts";
import {
  OAuthFixture,
  type RunningOAuthFixture,
  startOAuthFixture,
} from "../../../../packages/testing/src/oauth/fixture.ts";
import { type Booted, Client, ORIGIN } from "../../test/client.ts";
import { defineConsoleService } from "./main.ts";

const CLIENT_ID = "fin-console-test.apps.example.com";
const clientSecret = randomBytes(24).toString("base64url");

let database: TestDatabase;
let provider: RunningOAuthFixture;
let fixture: OAuthFixture;
let on: Booted;
let off: Booted;

function env(google: boolean): Record<string, string> {
  return {
    FIN_PUBLIC_ORIGIN: ORIGIN,
    FIN_CONNECTOR_SERVICES: "cloudflared-public",
    FIN_DOCS_ORIGIN: "https://developer.example.com",
    BETTER_AUTH_SECRETS: `1:${randomBytes(32).toString("base64url")}`,
    FIN_LIMIT_KEY_1: randomBytes(32).toString("hex"),
    ...(google
      ? {
          FIN_FEATURE_GOOGLE: "on",
          FIN_GOOGLE_CLIENT_ID: CLIENT_ID,
          FIN_GOOGLE_CLIENT_SECRET: clientSecret,
          FIN_GOOGLE_TEST_ISSUER: provider.origin,
        }
      : {}),
  };
}

beforeAll(async () => {
  database = await createTestDatabase("google");
  fixture = new OAuthFixture();
  provider = await startOAuthFixture(fixture);
  fixture.registerClient({
    clientId: CLIENT_ID,
    clientSecret,
    redirectUris: [`${ORIGIN}/api/auth/callback/google`],
  });
  const boot = (google: boolean) =>
    bootApi(defineConsoleService({ pool: database.login("fin_console") }), {
      service: "console",
      roles: ["console"],
      env: env(google),
    });
  on = await boot(true);
  off = await boot(false);
});

afterAll(async () => {
  await on?.stop();
  await off?.stop();
  await provider?.close();
  await database?.drop();
});

describe("GET /api/sign-in/methods", () => {
  it("says whether Google is on, to anyone, with no session", async () => {
    expect((await new Client(off).call("GET", "/api/sign-in/methods")).json).toEqual({
      google: false,
    });
    const answer = await new Client(on).call("GET", "/api/sign-in/methods");
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ google: true });
  });

  it("refuses a query, as every route without one does", async () => {
    const answer = await new Client(on).call("GET", "/api/sign-in/methods?x=1");
    expect(answer.status).toBe(400);
  });
});

describe("a Google round trip through the front door", () => {
  it("starts on a gated POST, returns on the exempt GET, and the session works on Fin's routes", async () => {
    const browser = new Client(on);
    // Without X-Fin-App the origin gate refuses the start, as every unsafe request.
    const ungated = await browser.call(
      "POST",
      "/api/auth/sign-in/social",
      { provider: "google", callbackURL: "/sign-in?via=google" },
      { "x-fin-app": "" },
    );
    expect(ungated.status).toBe(403);
    expect(ungated.json.code).toBe("invalid_origin");

    const start = await browser.call("POST", "/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: "/sign-in?via=google",
      errorCallbackURL: "/sign-in",
      disableRedirect: true,
    });
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const email = `front.${randomBytes(3).toString("hex")}@example.com`;
    fixture.chooseNext({ sub: `9${Date.now()}`, email, name: "Front Door" });
    const fromProvider = await fetch(String(start.json.url), { redirect: "manual" });
    const back = new URL(String(fromProvider.headers.get("location")));
    expect(`${back.origin}${back.pathname}`).toBe(`${ORIGIN}/api/auth/callback/google`);

    // A POST to the callback is refused by the gate (§2.3): only the GET is exempt.
    const posted = await new Client(on).call(
      "POST",
      `/api/auth/callback/google${back.search}`,
      undefined,
      { origin: "https://accounts.google.com", "sec-fetch-site": "cross-site" },
    );
    expect(posted.status).toBe(403);

    // The provider's top-level redirect: cross-site, no Origin, no X-Fin-App.
    const callback = await browser.call("GET", `${back.pathname}${back.search}`, undefined, {
      "sec-fetch-site": "cross-site",
    });
    expect(callback.status).toBe(302);
    expect(
      callback.cookies.some((c) => /^__Host-fin\.session_token=.*SameSite=Strict/i.test(c)),
    ).toBe(true);

    const viewer = await browser.call("GET", "/api/viewer");
    expect(viewer.status).toBe(200);
    expect(viewer.json).toMatchObject({ gate: "ok", memberships: [], user: { email } });
    const first = await browser.call("POST", "/api/orgs/first");
    expect(first.status, JSON.stringify(first.json)).toBe(201);
  });

  it("answers 404 on every Google path when Google is off", async () => {
    const browser = new Client(off);
    const start = await browser.call("POST", "/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: "/sign-in",
    });
    expect(start.status).toBe(404);
    const callback = await browser.call("GET", "/api/auth/callback/google?code=x&state=y");
    expect(callback.status).toBe(404);
  });
});
