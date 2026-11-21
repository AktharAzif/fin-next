// T-SAT-03: §3.3 and §3.4 for both realms as createRealm() builds them; start-up refuses
// BETTER_AUTH_TRUSTED_ORIGINS, an http origin outside development and a short secret; each
// realm's resolved trusted origins are exactly its FIN_PUBLIC_ORIGIN (and the API origin under
// the split host). Also the cookie configuration test of [SA-43] on the built instance.
import { describe, expect, it } from "vitest";
import { untouchableDatabase } from "../test/fake-db.ts";
import { DOCS_ORIGIN, testEnv } from "../test/harness.ts";
import {
  expectedTrustedOrigins,
  RealmConfigError,
  type RealmName,
  readRealmSettings,
} from "./config.ts";
import { systemClock } from "./ports/clock.ts";
import { createRealm } from "./realm.ts";

function build(realm: RealmName, env: Record<string, string | undefined> = {}) {
  const { db, lines } = untouchableDatabase();
  const settings = readRealmSettings(realm, testEnv(realm, env));
  return createRealm({ settings, db, clock: systemClock, lines, docsOrigin: DOCS_ORIGIN });
}

interface ResolvedContext {
  trustedOrigins: string[];
  skipOriginCheck: boolean | string[];
  skipCSRFCheck: boolean;
  baseURL: string;
  secretConfig: { currentVersion: number; keys: Map<number, string> };
  authCookies: { sessionToken: { name: string; attributes: Record<string, unknown> } };
  createAuthCookie(
    name: string,
    overrides?: Record<string, unknown>,
  ): { name: string; attributes: Record<string, unknown> };
  options: Record<string, unknown> & { advanced?: Record<string, unknown> };
}

async function context(realm: RealmName, env: Record<string, string | undefined> = {}) {
  const built = build(realm, env);
  return { built, ctx: (await built.auth.$context) as unknown as ResolvedContext };
}

describe("readRealmSettings refuses a bad start", () => {
  it.each([
    ["BETTER_AUTH_TRUSTED_ORIGINS", { BETTER_AUTH_TRUSTED_ORIGINS: "https://evil.example.org" }],
    ["BETTER_AUTH_TRUSTED_ORIGINS even when empty", { BETTER_AUTH_TRUSTED_ORIGINS: "" }],
    ["BETTER_AUTH_SECRET", { BETTER_AUTH_SECRET: "x".repeat(40) }],
    ["BETTER_AUTH_URL", { BETTER_AUTH_URL: "https://console.example.com" }],
    ["an http origin outside development", { FIN_PUBLIC_ORIGIN: "http://console.example.com" }],
    ["an origin with a path", { FIN_PUBLIC_ORIGIN: "https://console.example.com/app" }],
    ["a short secret", { BETTER_AUTH_SECRETS: "1:short-secret" }],
    ["a low-entropy secret", { BETTER_AUTH_SECRETS: `1:${"ab".repeat(20)}` }],
    [
      "secrets not newest first",
      { BETTER_AUTH_SECRETS: `1:${"Ab3-".repeat(12)}x,2:${"Zy9_".repeat(12)}y` },
    ],
    ["a missing limit key", { FIN_LIMIT_KEY_1: undefined }],
    ["a short limit key", { FIN_LIMIT_KEY_1: "00ff" }],
    ["an unknown environment", { FIN_ENVIRONMENT: "qa" }],
    ["passwords switched on before they are built", { FIN_FEATURE_PASSWORDS: "on" }],
  ])("refuses %s", (_label, env) => {
    const merged = { ...testEnv("developer"), ...env };
    for (const [key, value] of Object.entries(env))
      if (value === undefined) delete merged[key as keyof typeof merged];
    expect(() => readRealmSettings("developer", merged)).toThrow(RealmConfigError);
  });

  it("allows http only in development", () => {
    const settings = readRealmSettings(
      "developer",
      testEnv("developer", {
        FIN_ENVIRONMENT: "development",
        FIN_PUBLIC_ORIGIN: "http://localhost:5173",
      }),
    );
    expect(settings.publicOrigin).toBe("http://localhost:5173");
  });

  it("names the TOTP issuer per environment (S2-02)", () => {
    expect(
      readRealmSettings("developer", testEnv("developer", { FIN_ENVIRONMENT: "production" }))
        .totpIssuer,
    ).toBe("Fin");
    expect(
      readRealmSettings("developer", testEnv("developer", { FIN_ENVIRONMENT: "staging" }))
        .totpIssuer,
    ).toBe("Fin (staging)");
    expect(
      readRealmSettings("staff", testEnv("staff", { FIN_ENVIRONMENT: "staging" })).totpIssuer,
    ).toBe("Fin Admin (staging)");
  });
});

describe.each(["developer", "staff"] as const)("the %s realm as built", (realm) => {
  const prefix = realm === "developer" ? "__Host-fin" : "__Host-fin-admin";
  const origin =
    realm === "developer" ? "https://console.example.com" : "https://admin.example.com";

  it("trusts exactly the app's origin (the resolved set: baseURL's origin and the explicit one)", async () => {
    const { ctx, built } = await context(realm);
    expect(new Set(ctx.trustedOrigins)).toEqual(new Set([origin]));
    expect(expectedTrustedOrigins(built.settings)).toEqual([origin]);
    expect(ctx.baseURL).toBe(`${origin}/api/auth`);
  });

  it("keeps the origin and CSRF checks on, even under the test runner", async () => {
    const { ctx } = await context(realm);
    expect(ctx.skipOriginCheck).toBe(false);
    expect(ctx.skipCSRFCheck).toBe(false);
    expect(ctx.options.advanced?.disableOriginCheck).toBe(false);
    expect(ctx.options.advanced?.disableCSRFCheck).toBe(false);
    expect(ctx.options.advanced?.crossSubDomainCookies).toBeUndefined();
  });

  it("passes the versioned secrets, the newest signing", async () => {
    const { ctx } = await context(realm);
    expect(ctx.secretConfig.currentVersion).toBe(2);
    expect([...ctx.secretConfig.keys.keys()].sort()).toEqual([1, 2]);
  });

  it("makes every cookie host-only __Host-, Secure, HttpOnly, Path=/; the session Strict, the rest Lax", async () => {
    const { ctx } = await context(realm);
    const session = ctx.authCookies.sessionToken;
    expect(session.name).toBe(`${prefix}.session_token`);
    expect(session.attributes).toMatchObject({
      secure: true,
      httpOnly: true,
      path: "/",
      sameSite: "strict",
    });
    expect(session.attributes.domain).toBeUndefined();
    for (const name of [
      "better-auth-passkey",
      "two_factor",
      "state",
      "dont_remember",
      "trust_device",
    ]) {
      const cookie = ctx.createAuthCookie(name);
      expect(cookie.name).toBe(`${prefix}.${name}`);
      expect(cookie.name.startsWith("__Secure-")).toBe(false);
      expect(cookie.attributes).toMatchObject({
        secure: true,
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      });
      expect(cookie.attributes.domain).toBeUndefined();
    }
  });

  it("sets the session lifetimes and keeps the cookie cache off (§11.1)", async () => {
    const { ctx } = await context(realm);
    const session = ctx.options.session as Record<string, unknown>;
    expect(session.expiresIn).toBe(realm === "developer" ? 86_400 : 3_600);
    expect(session.updateAge).toBe(realm === "developer" ? 600 : 300);
    expect(session.cookieCache).toEqual({ enabled: false });
    expect(ctx.options.telemetry).toEqual({ enabled: false });
  });

  it("mounts exactly the three plugins", async () => {
    const { ctx } = await context(realm);
    const ids = (ctx.options.plugins as { id: string }[]).map((p) => p.id).sort();
    expect(ids).toEqual(["email-otp", "passkey", "two-factor"]);
  });

  it("gives the passkey plugin the app host and origin", async () => {
    const { ctx } = await context(realm);
    const plugin = (
      ctx.options.plugins as { id: string; options?: Record<string, unknown> }[]
    ).find((p) => p.id === "passkey");
    expect(plugin?.options).toMatchObject({
      rpID: new URL(origin).hostname,
      origin,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
  });
});

describe("the split-host fallback (§2.6, S2-01, T-SAT-06)", () => {
  it("trusts the page and the API host, and keeps the passkey on the page's host", async () => {
    const { ctx, built } = await context("developer", {
      FIN_API_ORIGIN: "https://console-api.example.com",
    });
    expect(new Set(ctx.trustedOrigins)).toEqual(
      new Set(["https://console-api.example.com", "https://console.example.com"]),
    );
    expect(ctx.baseURL).toBe("https://console-api.example.com/api/auth");
    expect(built.settings.rpId).toBe("console.example.com");
  });

  it("refuses an API origin equal to the page's", () => {
    expect(() =>
      readRealmSettings(
        "developer",
        testEnv("developer", { FIN_API_ORIGIN: "https://console.example.com" }),
      ),
    ).toThrow(RealmConfigError);
  });
});
