// The staff realm's Google settings and allowlist without a database (spec 02 §4.3, §5.8; CR-12):
// off unless its own switch is on (the developer realm's switch is refused there, and its switch
// on the developer realm); on only with its client and the Workspace domain; the redirect URI the
// staff host's callback; the authorization request naming the domain; the router's path set
// unchanged (T-SAT-01); only `/sign-in/social` and `/callback/google` opened; and the redirect rule
// and every unlisted or switched-off path answered before any unit of work.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { untouchableDatabase } from "../../test/fake-db.ts";
import { DOCS_ORIGIN, testEnv } from "../../test/harness.ts";
import { RealmConfigError, readRealmSettings } from "../config.ts";
import { ManualClock, systemClock } from "../ports/clock.ts";
import { MemoryLineSink } from "../ports/log.ts";
import { createRealm } from "../realm.ts";
import { newGoogleFlow } from "./flow.ts";
import { createGoogleSignIn } from "./provider.ts";
import { GOOGLE_ENDPOINTS, readGoogleSettings } from "./settings.ts";

const ADMIN = "https://admin.example.com";
const secret = () => randomBytes(24).toString("base64url");
const staffClient = () => ({
  FIN_FEATURE_STAFF_GOOGLE: "on",
  FIN_GOOGLE_CLIENT_ID: "210987654321-staff.apps.googleusercontent.com",
  FIN_GOOGLE_CLIENT_SECRET: secret(),
  FIN_GOOGLE_HOSTED_DOMAIN: "Workspace.Example.com",
});

describe("the staff realm's Google settings", () => {
  it("are off unless the staff switch is on, even with the client and the domain set", () => {
    expect(readGoogleSettings("staff", {}, "staging", ADMIN)).toBeNull();
    const { FIN_FEATURE_STAFF_GOOGLE: _on, ...clientOnly } = staffClient();
    expect(readGoogleSettings("staff", clientOnly, "staging", ADMIN)).toBeNull();
    expect(
      readGoogleSettings(
        "staff",
        { ...clientOnly, FIN_FEATURE_STAFF_GOOGLE: "off" },
        "production",
        ADMIN,
      ),
    ).toBeNull();
    expect(readRealmSettings("staff", testEnv("staff")).features.google).toBe(false);
  });

  it("are on with the client, the staff host's exact callback and the Workspace domain", () => {
    const settings = readGoogleSettings("staff", staffClient(), "staging", ADMIN);
    expect(settings?.redirectUri).toBe(`${ADMIN}/api/auth/callback/google`);
    expect(settings?.endpoints).toEqual(GOOGLE_ENDPOINTS);
    expect(settings?.hostedDomain).toBe("workspace.example.com");
    const realm = readRealmSettings("staff", testEnv("staff", staffClient()));
    expect(realm.features.google).toBe(true);
    expect(realm.google?.redirectUri).toBe(`${ADMIN}/api/auth/callback/google`);
  });

  it.each([
    ["a switch that is neither on nor off", { FIN_FEATURE_STAFF_GOOGLE: "yes" }, /STAFF_GOOGLE/],
    ["no client ID", { FIN_GOOGLE_CLIENT_ID: undefined }, /FIN_GOOGLE_CLIENT_ID is not set/],
    ["no client secret", { FIN_GOOGLE_CLIENT_SECRET: "" }, /FIN_GOOGLE_CLIENT_SECRET is not set/],
    ["no Workspace domain", { FIN_GOOGLE_HOSTED_DOMAIN: undefined }, /HOSTED_DOMAIN is not set/],
    ["a domain that is no DNS name", { FIN_GOOGLE_HOSTED_DOMAIN: "not a domain" }, /malformed/],
    ["a domain with a scheme", { FIN_GOOGLE_HOSTED_DOMAIN: "https://example.com" }, /malformed/],
    ["a one-label domain", { FIN_GOOGLE_HOSTED_DOMAIN: "localhost" }, /malformed/],
    ["the developer realm's switch", { FIN_FEATURE_GOOGLE: "on" }, /developer realm's switch/],
  ])("refuse %s", (_label, overrides, message) => {
    const env: Record<string, string | undefined> = { ...staffClient(), ...overrides };
    expect(() => readGoogleSettings("staff", env, "staging", ADMIN)).toThrow(message);
    expect(() => readRealmSettings("staff", testEnv("staff", env))).toThrow(RealmConfigError);
  });

  it("are refused on the developer realm: its switch and the Workspace domain", () => {
    const console = "https://console.example.com";
    expect(() =>
      readGoogleSettings("developer", { FIN_FEATURE_STAFF_GOOGLE: "on" }, "staging", console),
    ).toThrow(/FIN_FEATURE_STAFF_GOOGLE is the staff realm's switch/);
    expect(() =>
      readGoogleSettings(
        "developer",
        { FIN_GOOGLE_HOSTED_DOMAIN: "workspace.example.com" },
        "staging",
        console,
      ),
    ).toThrow(/FIN_GOOGLE_HOSTED_DOMAIN/);
    // Off is no setting at all, on either realm.
    expect(
      readGoogleSettings("developer", { FIN_FEATURE_STAFF_GOOGLE: "off" }, "staging", console),
    ).toBeNull();
    expect(readGoogleSettings("staff", { FIN_FEATURE_GOOGLE: "off" }, "staging", ADMIN)).toBeNull();
  });

  it("are refused under the split-host fallback, naming the staff switch", () => {
    const split = { FIN_API_ORIGIN: "https://admin-api.example.com" };
    expect(() =>
      readRealmSettings("staff", testEnv("staff", { ...staffClient(), ...split })),
    ).toThrow(/FIN_FEATURE_STAFF_GOOGLE is on with FIN_API_ORIGIN set/);
  });
});

describe("the staff provider", () => {
  it("names the Workspace domain and asks for the account chooser, with PKCE and a nonce", () => {
    const settings = readGoogleSettings("staff", staffClient(), "staging", ADMIN);
    if (settings === null) throw new Error("Google is off");
    const google = createGoogleSignIn({
      settings,
      clock: new ManualClock(new Date("2026-11-22T09:00:00Z")),
      lines: new MemoryLineSink(),
      realm: "staff",
      stateCookie: "__Host-fin-admin.state",
      stateSecret: secret(),
      flow: () => newGoogleFlow(),
    });
    const build = google.provider.createAuthorizationURL as (input: {
      state: string;
      codeVerifier: string;
      redirectURI: string;
      idTokenNonce?: string;
    }) => URL;
    const url = build({
      state: "s".repeat(32),
      codeVerifier: "v".repeat(64),
      redirectURI: settings.redirectUri,
      idTokenNonce: "n".repeat(32),
    });
    expect(url.searchParams.get("hd")).toBe("workspace.example.com");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBe("n".repeat(32));
    expect(url.searchParams.get("redirect_uri")).toBe(`${ADMIN}/api/auth/callback/google`);
    // The library is told never to make a member from a Google profile.
    expect((google.provider.options as { disableSignUp?: boolean }).disableSignUp).toBe(true);
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

function staffRealm(env: Record<string, string | undefined>) {
  const fake = untouchableDatabase();
  const realm = createRealm({
    settings: readRealmSettings("staff", testEnv("staff", env)),
    db: fake.db,
    clock: systemClock,
    lines: fake.lines,
    docsOrigin: DOCS_ORIGIN,
  });
  return { realm, fake };
}

const context = {
  requestId: "req_test",
  clientIp: null,
  userAgent: null,
  access: { email: "nadia@example.com", sub: "sub-nadia" },
};

describe("the staff realm with Google on", () => {
  const { realm, fake } = staffRealm(staffClient());

  it("mounts the same paths, every one listed (T-SAT-01)", () => {
    expect(routerPaths(realm.api as unknown as Record<string, unknown>)).toEqual(
      realm.policy.rules.map((r) => r.path).sort(),
    );
  });

  it("opens only /sign-in/social and /callback/google; linking stays blocked", () => {
    const rule = (path: string) => realm.policy.rules.find((r) => r.path === path);
    expect(rule("/sign-in/social")).toMatchObject({ class: "public", methods: ["POST"] });
    expect(rule("/callback/:id")).toMatchObject({ class: "public", methods: ["GET"] });
    expect(realm.policy.match("/callback/google", "GET")?.path).toBe("/callback/:id");
    expect(realm.policy.match("/callback/google", "POST")).toBeNull();
    expect(realm.policy.match("/callback/:id", "GET")).toBeNull();
    for (const path of ["/link-social", "/unlink-account", "/get-access-token", "/account-info"]) {
      expect(rule(path)?.class, path).toBe("blocked");
    }
  });

  it.each(["/callback/github", "/callback/:id", "/callback/%3Aid", "/link-social"])(
    "answers %s 404 before any unit of work",
    async (path) => {
      const before = fake.pool.connects;
      const answer = await realm.handler(
        new Request(`${ADMIN}/api/auth${path}?code=x&state=y`),
        context,
      );
      expect(answer.status).toBe(404);
      expect(await answer.text()).toBe("");
      expect(fake.pool.connects).toBe(before);
    },
  );

  it.each([
    ["a page outside Fin Admin's sign-in", { callbackURL: "/sign-up" }, ["callbackURL"]],
    ["another origin", { callbackURL: "https://evil.example.org/sign-in" }, ["callbackURL"]],
    [
      "the console's origin",
      { callbackURL: "https://console.example.com/sign-in" },
      ["callbackURL"],
    ],
    [
      "a new-user page (no member is made)",
      { callbackURL: "/sign-in", newUserCallbackURL: "/sign-in" },
      ["newUserCallbackURL"],
    ],
    ["no callback", {}, ["callbackURL"]],
    ["another provider", { provider: "github", callbackURL: "/sign-in" }, ["provider"]],
  ])("refuses %s with 400 before any unit of work", async (_label, body, fields) => {
    const before = fake.pool.connects;
    const answer = await realm.handler(
      new Request(`${ADMIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ADMIN },
        body: JSON.stringify({ provider: "google", ...body }),
      }),
      context,
    );
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ code: "invalid", fields });
    expect(fake.pool.connects).toBe(before);
  });
});

describe("the staff realm with Google off (the default)", () => {
  it("answers 404 on every Google path before any unit of work, the client set or not", async () => {
    const { FIN_FEATURE_STAFF_GOOGLE: _on, ...clientOnly } = staffClient();
    for (const env of [{}, clientOnly]) {
      const { realm, fake } = staffRealm(env);
      expect(realm.settings.google).toBeNull();
      for (const [method, path] of [
        ["POST", "/sign-in/social"],
        ["GET", "/callback/google"],
        ["GET", "/callback/:id"],
      ] as const) {
        const answer = await realm.handler(
          new Request(`${ADMIN}/api/auth${path}`, {
            method,
            headers: { "content-type": "application/json", origin: ADMIN },
            ...(method === "POST"
              ? { body: JSON.stringify({ provider: "google", callbackURL: "/sign-in" }) }
              : {}),
          }),
          context,
        );
        expect(answer.status, path).toBe(404);
        expect(await answer.text()).toBe("");
      }
      expect(fake.pool.connects).toBe(0);
      expect(fake.lines.named("auth.endpoint_blocked")).toContainEqual(
        expect.objectContaining({ realm: "staff", class: "blocked" }),
      );
    }
  });
});
