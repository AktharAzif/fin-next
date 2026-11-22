// Google's setting (spec 02 §5.8, CR-12): off by default; on only with the console's OAuth client;
// the redirect URI exactly the console's callback; the fixture provider only in development and
// test; never through this switch for the staff realm, which has its own (staff.test.ts); and the
// T-SAT-01 path set unchanged with Google on (the provider mounts no route of its own).
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { untouchableDatabase } from "../../test/fake-db.ts";
import { DOCS_ORIGIN, testEnv } from "../../test/harness.ts";
import { RealmConfigError, readRealmSettings } from "../config.ts";
import { systemClock } from "../ports/clock.ts";
import { createRealm } from "../realm.ts";
import { GOOGLE_ENDPOINTS, readGoogleSettings } from "./settings.ts";

const secret = () => randomBytes(24).toString("base64url");
const client = () => ({
  FIN_FEATURE_GOOGLE: "on",
  FIN_GOOGLE_CLIENT_ID: "123456789012-abcdef.apps.googleusercontent.com",
  FIN_GOOGLE_CLIENT_SECRET: secret(),
});

describe("readGoogleSettings", () => {
  it("is off unless switched on, even with the client set", () => {
    expect(
      readGoogleSettings("developer", {}, "staging", "https://console.example.com"),
    ).toBeNull();
    const { FIN_FEATURE_GOOGLE: _on, ...clientOnly } = client();
    expect(
      readGoogleSettings("developer", clientOnly, "staging", "https://console.example.com"),
    ).toBeNull();
    expect(
      readGoogleSettings(
        "developer",
        { ...clientOnly, FIN_FEATURE_GOOGLE: "off" },
        "production",
        "https://console.example.com",
      ),
    ).toBeNull();
  });

  it("is on with the client, Google's endpoints and the exact redirect URI", () => {
    const settings = readGoogleSettings(
      "developer",
      client(),
      "staging",
      "https://console.example.com",
    );
    expect(settings?.redirectUri).toBe("https://console.example.com/api/auth/callback/google");
    expect(settings?.endpoints).toEqual(GOOGLE_ENDPOINTS);
    expect(settings?.endpoints.issuers).toEqual([
      "https://accounts.google.com",
      "accounts.google.com",
    ]);
  });

  it.each([
    ["a switch that is neither on nor off", { FIN_FEATURE_GOOGLE: "yes" }, /FIN_FEATURE_GOOGLE/],
    ["no client ID", { FIN_GOOGLE_CLIENT_ID: undefined }, /FIN_GOOGLE_CLIENT_ID is not set/],
    ["a malformed client ID", { FIN_GOOGLE_CLIENT_ID: "id with spaces" }, /malformed/],
    ["no client secret", { FIN_GOOGLE_CLIENT_SECRET: "" }, /FIN_GOOGLE_CLIENT_SECRET is not set/],
    ["a short client secret", { FIN_GOOGLE_CLIENT_SECRET: "short" }, /malformed/],
  ])("refuses %s", (_label, overrides, message) => {
    const env: Record<string, string | undefined> = { ...client(), ...overrides };
    expect(() =>
      readGoogleSettings("developer", env, "staging", "https://console.example.com"),
    ).toThrow(message);
  });

  it("takes the fixture provider only in development and test", () => {
    const env = { ...client(), FIN_GOOGLE_TEST_ISSUER: "http://127.0.0.1:4121" };
    const test = readGoogleSettings("developer", env, "test", "https://console.example.com");
    expect(test?.endpoints).toEqual({
      issuers: ["http://127.0.0.1:4121"],
      authorization: "http://127.0.0.1:4121/authorize",
      token: "http://127.0.0.1:4121/token",
      jwks: "http://127.0.0.1:4121/jwks",
    });
    for (const environment of ["staging", "production"] as const) {
      expect(() =>
        readGoogleSettings("developer", env, environment, "https://console.example.com"),
      ).toThrow(/outside development and test/);
      // Even with Google off: the variable has no business in a deployed service.
      expect(() =>
        readGoogleSettings(
          "developer",
          { FIN_GOOGLE_TEST_ISSUER: "http://127.0.0.1:4121" },
          environment,
          "https://console.example.com",
        ),
      ).toThrow(/outside development and test/);
    }
    for (const issuer of ["http://issuer.example.org", "http://127.0.0.1:4121/path", "nope"]) {
      expect(() =>
        readGoogleSettings(
          "developer",
          { ...client(), FIN_GOOGLE_TEST_ISSUER: issuer },
          "test",
          "https://console.example.com",
        ),
      ).toThrow(/FIN_GOOGLE_TEST_ISSUER/);
    }
  });

  it("refuses the developer realm's switch on the staff realm, which has its own", () => {
    expect(() =>
      readGoogleSettings("staff", client(), "staging", "https://admin.example.com"),
    ).toThrow(/staff realm/);
    expect(readGoogleSettings("staff", {}, "staging", "https://admin.example.com")).toBeNull();
  });
});

describe("the realm's settings with Google", () => {
  it("are off by default, and refuse a half-enabled start as a realm configuration error", () => {
    expect(readRealmSettings("developer", testEnv("developer")).features.google).toBe(false);
    expect(readRealmSettings("developer", testEnv("developer")).google).toBeNull();
    expect(() =>
      readRealmSettings("developer", testEnv("developer", { FIN_FEATURE_GOOGLE: "on" })),
    ).toThrow(RealmConfigError);
    expect(() => readRealmSettings("staff", testEnv("staff", client()))).toThrow(RealmConfigError);
    const on = readRealmSettings("developer", testEnv("developer", client()));
    expect(on.features.google).toBe(true);
    expect(on.google?.redirectUri).toBe("https://console.example.com/api/auth/callback/google");
  });

  it("refuse Google under the split-host fallback, whose callback would not be the registered one", () => {
    const split = { FIN_API_ORIGIN: "https://console-api.example.com" };
    expect(() =>
      readRealmSettings("developer", testEnv("developer", { ...client(), ...split })),
    ).toThrow(RealmConfigError);
    expect(() =>
      readRealmSettings("developer", testEnv("developer", { ...client(), ...split })),
    ).toThrow(/FIN_FEATURE_GOOGLE is on with FIN_API_ORIGIN set/);
    // The split host alone, and Google alone, still start.
    expect(readRealmSettings("developer", testEnv("developer", split)).apiOrigin).toBe(
      split.FIN_API_ORIGIN,
    );
  });
});

/** The paths the installed router mounts, as T-SAT-01 reads them. */
function routerPaths(api: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const endpoint of Object.values(api)) {
    const e = endpoint as { path?: string; options?: { metadata?: { SERVER_ONLY?: boolean } } };
    if (typeof e.path === "string" && e.options?.metadata?.SERVER_ONLY !== true) out.push(e.path);
  }
  return out.sort();
}

describe("the developer realm with Google on", () => {
  const fake = untouchableDatabase();
  const settings = readRealmSettings("developer", testEnv("developer", client()));
  const realm = createRealm({
    settings,
    db: fake.db,
    clock: systemClock,
    lines: fake.lines,
    docsOrigin: DOCS_ORIGIN,
  });

  it("mounts the same paths, every one listed (T-SAT-01)", () => {
    expect(routerPaths(realm.api as unknown as Record<string, unknown>)).toEqual(
      realm.policy.rules.map((r) => r.path).sort(),
    );
  });

  it("opens the Google paths with their classes and limits, and only /callback/google", () => {
    const rule = (path: string) => realm.policy.rules.find((r) => r.path === path);
    expect(rule("/sign-in/social")).toMatchObject({ class: "public", methods: ["POST"] });
    expect(rule("/callback/:id")).toMatchObject({ class: "public", methods: ["GET"] });
    expect(rule("/link-social")).toMatchObject({
      class: "step_up_self",
      reach: ["ok"],
      limit: "method_add",
    });
    expect(rule("/unlink-account")).toMatchObject({
      class: "step_up_self",
      reach: ["ok"],
      limit: "method_add",
    });
    expect(realm.policy.match("/callback/google", "GET")?.path).toBe("/callback/:id");
    expect(realm.policy.match("/callback/google", "POST")).toBeNull();
    expect(realm.policy.match("/callback/github", "GET")).toBeNull();
    // The route's pattern is never a path a request may use (§4.1: only /callback/google).
    expect(realm.policy.match("/callback/:id", "GET")).toBeNull();
    expect(realm.policy.match("/reset-password/:token", "GET")).toBeNull();
    // The token paths stay blocked: no Google token is handed out.
    for (const path of ["/get-access-token", "/refresh-token", "/account-info"]) {
      expect(rule(path)?.class, path).toBe("blocked");
    }
  });

  it.each(["/callback/github", "/callback/:id", "/callback/%3Aid", "/callback/Google"])(
    "answers an unlisted callback (%s) 404 before any unit of work",
    async (path) => {
      const before = fake.pool.connects;
      const answer = await realm.handler(
        new Request(`https://console.example.com/api/auth${path}?code=x&state=y`),
        { requestId: "req_test", clientIp: null, userAgent: null },
      );
      expect(answer.status).toBe(404);
      expect(await answer.text()).toBe("");
      expect(fake.pool.connects).toBe(before);
    },
  );

  it("refuses a bad redirect target with 400 before any unit of work", async () => {
    const before = fake.pool.connects;
    const answer = await realm.handler(
      new Request("https://console.example.com/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://console.example.com" },
        body: JSON.stringify({ provider: "google", callbackURL: "https://evil.example.org/" }),
      }),
      { requestId: "req_test", clientIp: null, userAgent: null },
    );
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ code: "invalid", fields: ["callbackURL"] });
    expect(fake.pool.connects).toBe(before);
  });
});
