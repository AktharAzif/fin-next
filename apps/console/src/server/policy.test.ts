// The route-policy walk (spec 02 §14.1, T-SAT-31's static half, AC-SAT-42): the routes the router
// registers are exactly the policy's, which are exactly §14.2's (API keys, stretch 1, aside); every
// route has its schemas; no GET writes an audit row, counts a budget or takes a step-up (§2.3,
// [SA-44]); every step-up route names an action the catalogue knows, binding the same fields; every
// organisation change takes the team-change lock; every audit event named is in a fragment.
import { IDENTITY_EVENTS } from "@fin/identity";
import { KEY_EVENTS, KEYS_ACTIONS } from "@fin/keys";
import { ORGS_ACTIONS, ORGS_EVENTS } from "@fin/orgs";
import type { FinEnv } from "@fin/server/http";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { CONSOLE_POLICY } from "./policy/index.ts";
import { registerRoutes } from "./routes.ts";

/** §14.2's routes, but `/api/auth/*` (the realm's allowlist) and API keys (stretch 1). */
const SPEC_ROUTES = [
  "POST /api/sign-up",
  "POST /api/sign-in/code-link",
  "GET /api/viewer",
  "PUT /api/viewer/organization",
  "POST /api/invitations/open",
  "GET /api/invitation",
  "GET /api/invitations/mine",
  "POST /api/invitations/:invitationId/accept",
  "POST /api/invitations/:invitationId/decline",
  "GET /api/account/security",
  "GET /api/account/passkeys",
  "GET /api/account/sessions",
  "GET /api/account/activity",
  "PATCH /api/account/name",
  "POST /api/account/sessions/:sessionId/revoke",
  "POST /api/account/sessions/revoke-others",
  "DELETE /api/account/trusted-browsers/:browserId",
  "GET /api/orgs",
  "POST /api/orgs",
  "POST /api/orgs/first",
  "GET /api/org",
  "PATCH /api/org",
  "DELETE /api/org",
  "GET /api/team",
  "GET /api/team/members/:memberId/credentials",
  "PATCH /api/team/members/:memberId",
  "POST /api/team/members/:memberId/remove",
  "POST /api/team/invitations",
  "PATCH /api/team/invitations/:invitationId",
  "POST /api/team/invitations/:invitationId/resend",
  "DELETE /api/team/invitations/:invitationId",
  "GET /api/roles",
  "GET /api/roles/:roleKey",
  "POST /api/roles",
  "PUT /api/roles/:roleId",
  "POST /api/roles/:roleId/delete",
  "GET /api/audit-log",
  // API keys (§12.3, stretch 1, L-SAT-11).
  "GET /api/keys",
  "POST /api/keys",
  "PATCH /api/keys/:keyId",
  "POST /api/keys/:keyId/roll",
  "POST /api/keys/:keyId/revoke",
];

function registered(): string[] {
  const api = new Hono<FinEnv>().basePath("/api");
  // Registration needs no running service: the handlers' dependencies are read per request.
  registerRoutes(api, { orgs: {} as never, docsOrigin: "https://developer.example.com" });
  return api.routes.map((r) => `${r.method} ${r.path}`);
}

describe("the console's route policy", () => {
  it("registers exactly the policy's routes, and the policy is exactly §14.2's", () => {
    const routes = registered();
    const policy = CONSOLE_POLICY.map((p) => `${p.method} /api${p.path}`);
    expect(new Set(routes).size).toBe(routes.length);
    expect([...routes].sort()).toEqual([...policy].sort());
    expect([...policy].sort()).toEqual([...SPEC_ROUTES].sort());
  });

  it("gives every route a unique ID, its schemas, its scope's guard and its assurance", () => {
    expect(new Set(CONSOLE_POLICY.map((p) => p.id)).size).toBe(CONSOLE_POLICY.length);
    for (const p of CONSOLE_POLICY) {
      expect(p.body, p.id).toBeDefined();
      expect(p.query, p.id).toBeDefined();
      const guard = { public: "public", person: "requirePerson", organization: "requireActor" };
      expect(p.guard, p.id).toBe(guard[p.scope]);
      if (p.guard === "public") expect(p.assurance, p.id).toBe("none");
      if (p.method === "GET") expect(p.body, p.id).toBe("none");
      else expect(p.query, p.id).toBe("none");
    }
  });

  it("lets no GET write an audit row, count a budget, take a step-up or redeem without fetchSite", () => {
    for (const p of CONSOLE_POLICY.filter((q) => q.method === "GET")) {
      expect(p.audit, p.id).toEqual([]);
      expect(p.limits, p.id).toEqual([]);
      expect(p.stepUp, p.id).toBe("none");
      expect(p.fetchSite, p.id).toBeUndefined();
    }
    for (const p of CONSOLE_POLICY.filter((q) => q.method !== "GET")) {
      expect(p.fetchSite, p.id).toBeUndefined();
    }
  });

  it("names, for every step-up, an action the catalogue knows, binding exactly its fields", () => {
    const actions = new Map<string, { bind: readonly { name: string }[] }>(
      [...ORGS_ACTIONS, ...KEYS_ACTIONS].map((a) => [a.key, a]),
    );
    for (const p of CONSOLE_POLICY.filter((q) => q.stepUp !== "none")) {
      expect(p.action, p.id).toMatch(/^[a-z][a-zA-Z]*\.[a-z][a-z_]*$/);
      if (p.stepUp === "window") continue;
      expect(p.limits, p.id).toContain("step_up_intents");
      if (p.action?.startsWith("account.") === true) {
        // The identity area's actions (its own fragment) bind nothing on these routes.
        expect(p.bind, p.id).toEqual([]);
        continue;
      }
      const action = actions.get(p.action ?? "");
      expect(action, p.id).toBeDefined();
      expect([...(p.bind ?? [])].sort(), p.id).toEqual(action?.bind.map((b) => b.name).sort());
    }
  });

  it("checks a permission on every organisation route but the profile, and locks every change", () => {
    for (const p of CONSOLE_POLICY.filter((q) => q.scope === "organization")) {
      if (p.id !== "orgGet") {
        expect(p.permission !== undefined || p.anyOf !== undefined, p.id).toBe(true);
      }
      if (p.method !== "GET") expect(p.lock, p.id).toBe(true);
    }
  });

  it("names only audit events the fragments define, and every changing route names one", () => {
    const known = new Set([
      ...Object.keys(ORGS_EVENTS),
      ...Object.keys(IDENTITY_EVENTS),
      ...Object.keys(KEY_EVENTS),
    ]);
    for (const p of CONSOLE_POLICY) {
      for (const event of p.audit) expect(known.has(event), `${p.id}: ${event}`).toBe(true);
    }
    const quiet = new Set(["signUp", "codeLink", "viewerOrganization", "invitationOpen"]);
    for (const p of CONSOLE_POLICY.filter((q) => q.method !== "GET" && !quiet.has(q.id))) {
      expect(p.audit.length, p.id).toBeGreaterThan(0);
    }
  });

  it("keeps the invitation's token out of every path (S2-15)", () => {
    for (const p of CONSOLE_POLICY) expect(p.path, p.id).not.toMatch(/token/i);
  });
});
