// T-SAT-01 ([SA-09], AC-SAT-02): per realm, the installed router's path set equals the policy;
// unlisted, double-slash and encoded paths, and blocked ones, answer 404 before any unit of work
// or limit; `/change-email` and the staff backup-code paths answer 404; `step_up_org` and
// `session` are empty.
import { describe, expect, it } from "vitest";
import { untouchableDatabase } from "../test/fake-db.ts";
import { DOCS_ORIGIN, testEnv } from "../test/harness.ts";
import { type RealmName, readRealmSettings } from "./config.ts";
import {
  authPathOf,
  createEndpointPolicy,
  type EndpointRule,
  indexRules,
} from "./endpoint-policy.ts";
import { systemClock } from "./ports/clock.ts";
import { newId } from "./ports/ids.ts";
import { createRealm } from "./realm.ts";

function build(realm: RealmName) {
  const fake = untouchableDatabase();
  const settings = readRealmSettings(realm, testEnv(realm));
  return {
    ...fake,
    realm: createRealm({
      settings,
      db: fake.db,
      clock: systemClock,
      lines: fake.lines,
      docsOrigin: DOCS_ORIGIN,
    }),
  };
}

/** The paths the installed router mounts: every endpoint with a path that is not server-only. */
function routerPaths(api: Record<string, unknown>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const endpoint of Object.values(api)) {
    const e = endpoint as {
      path?: string;
      options?: { method?: string | string[]; metadata?: { SERVER_ONLY?: boolean } };
    };
    if (typeof e.path !== "string" || e.options?.metadata?.SERVER_ONLY === true) continue;
    const methods = Array.isArray(e.options?.method)
      ? e.options.method
      : [e.options?.method ?? "*"];
    out.set(e.path, new Set(methods.map(String)));
  }
  return out;
}

describe.each(["developer", "staff"] as const)("the %s realm's allowlist", (realmName) => {
  const { realm, pool, lines } = build(realmName);

  it("lists exactly the paths the installed router mounts, each with its methods", () => {
    const mounted = routerPaths(realm.api as unknown as Record<string, unknown>);
    const listed = new Map(realm.policy.rules.map((r) => [r.path, new Set<string>(r.methods)]));
    expect([...listed.keys()].sort()).toEqual([...mounted.keys()].sort());
    for (const [path, methods] of mounted) expect(listed.get(path), path).toEqual(methods);
  });

  it("throws at start-up when a path is listed twice", () => {
    const rules = createEndpointPolicy(realmName, { passwords: false, google: false }).rules;
    expect(() => indexRules(realmName, rules)).not.toThrow();
    expect(() => indexRules(realmName, [...rules, rules[0] as EndpointRule])).toThrow(/twice/);
  });

  it("keeps step_up_org and session empty (§4.1)", () => {
    expect(realm.policy.rules.filter((r) => r.class === "step_up_org")).toEqual([]);
    expect(realm.policy.rules.filter((r) => r.class === "session")).toEqual([]);
  });

  it("gives every reachable path at least one gate state and every blocked one none", () => {
    for (const rule of realm.policy.rules) {
      if (rule.class === "blocked") expect(rule.reach, rule.path).toEqual([]);
      else expect(rule.reach.length, rule.path).toBeGreaterThan(0);
      expect(rule.note.length > 0 || rule.class !== "blocked", rule.path).toBe(true);
    }
  });

  const refused: [string, string][] = [
    ["GET", "/api/auth/not-a-path"],
    ["POST", "/api/auth//sign-in/email-otp"],
    ["POST", "/api/auth/sign-in/%65mail-otp"],
    ["POST", "/api/auth/sign-in/email-otp/"],
    ["POST", "/api/auth/change-email"],
    ["POST", "/api/auth/sign-up/email"],
    ["GET", "/api/auth/verify-email?token=x"],
    ["GET", "/api/auth/reset-password/abc"],
    ["POST", "/api/auth/email-otp/check-verification-otp"],
    ["POST", "/api/auth/two-factor/get-totp-uri"],
    ["GET", "/api/auth/ok"],
    ["GET", "/api/auth/sign-out"],
    ["POST", "/api/auth/callback/google"],
    ["GET", "/api/authx/get-session"],
  ];
  if (realmName === "staff") {
    refused.push(
      ["POST", "/api/auth/two-factor/verify-backup-code"],
      ["POST", "/api/auth/two-factor/generate-backup-codes"],
      ["GET", "/api/auth/error"],
    );
  }

  it.each(refused)(
    "answers %s %s with an empty 404 before any limit is counted",
    async (method, path) => {
      const before = pool.connects;
      const response = await realm.handler(
        new Request(`${realm.settings.publicOrigin}${path}`, {
          method,
          headers: { origin: realm.settings.publicOrigin },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
        { requestId: newId("req", systemClock), clientIp: "203.0.113.5", userAgent: null },
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
      expect(pool.connects).toBe(before);
      const blocked = lines.named("auth.endpoint_blocked").at(-1);
      expect(blocked?.realm).toBe(realmName);
      expect(["unlisted", "blocked"]).toContain(blocked?.class);
      expect(JSON.stringify(lines.lines.at(-1))).not.toContain(path.slice(10));
    },
  );
});

describe("authPathOf", () => {
  it("returns the path after /api/auth, keeping encodings as they arrived", () => {
    expect(authPathOf("https://console.example.com/api/auth/sign-in/email-otp")).toBe(
      "/sign-in/email-otp",
    );
    expect(authPathOf("https://console.example.com/api/auth/sign-in/%65mail")).toBe(
      "/sign-in/%65mail",
    );
    expect(authPathOf("https://console.example.com/api/authentic")).toBeNull();
    expect(authPathOf("https://console.example.com/api/auth")).toBeNull();
  });
});
