// T-SAT-14 and the route-policy walk (spec 02 §6.4, §14.1, §14.3; AC-SAT-40, AC-SAT-42): the shared
// host built with Fin Admin's hooks routes exactly the policy's entries (beside the host's own
// `/api/health` and the realm's `/api/auth/*`), each with its schemas; exactly two routes are
// reachable below aal2; no GET declares an audit event, a budget or an intent; every intent route
// names a staff step-up action and binds exactly that action's fields.
import { staffCatalogue } from "@fin/access";
import { Readiness } from "@fin/server/health";
import { ConnectorPeers } from "@fin/server/ingress";
import { capture } from "@fin/server/testing";
import { STAFF_ACTIONS, type StaffDeps } from "@fin/staff";
import { AccessVerifier, createApiHost } from "@fin/web-host";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { adminHooks } from "./app.ts";
import { ADMIN_POLICIES } from "./policy/index.ts";

// @fin/identity's staff-realm actions these routes spend (its fragment, not exported by name).
const IDENTITY_STAFF_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  "staff.session_revoke": [],
  "staff.sessions_revoke_others": [],
};

function hostRoutes(): { method: string; path: string }[] {
  const captured = capture({ service: "admin" });
  const realm = {
    policy: { match: () => null },
    handler: async () => new Response(null, { status: 404 }),
  };
  const host = createApiHost({
    app: "admin",
    environment: "ci",
    release: "0123456789abcdef0123456789abcdef01234567",
    docsOrigin: "https://developer.example.com",
    ingress: {
      origins: { admin: "https://admin.example.com" },
      connectorServices: ["cloudflared-admin"],
      proofs: { admin: ["p".repeat(43)] },
    },
    telemetry: captured.telemetry,
    reporter: captured.reporter,
    clock: captured.clock,
    readiness: new Readiness(),
    peers: new ConnectorPeers({
      services: ["cloudflared-admin"],
      resolver: { resolveAll: async () => [] },
      clock: captured.clock,
    }),
    accessVerifier: new AccessVerifier({
      team: "fin-test-team",
      aud: "a".repeat(32),
      clock: captured.clock,
    }),
    ...adminHooks({ realm } as unknown as StaffDeps, "https://developer.example.com"),
  });
  return host.routes
    .filter((r) => !(r.method === "ALL" && (r.path === "*" || r.path === "/*")))
    .map((r) => ({ method: r.method, path: r.path }));
}

const isStrict = (schema: z.ZodObject) =>
  (schema._zod.def as { catchall?: { _zod: { def: { type: string } } } }).catchall?._zod.def
    .type === "never";

describe("Fin Admin's route policy", () => {
  it("is exactly what the API half routes, beside /api/health and the realm's /api/auth/*", () => {
    const routed = hostRoutes()
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    const declared = ADMIN_POLICIES.map((p) => `${p.method} ${p.path}`);
    expect(routed).toEqual(
      [...declared, "ALL /api/auth/*", "GET /api/health", "HEAD /api/health"].sort(),
    );
  });

  it("reaches exactly two Fin routes below aal2 (T-SAT-14)", () => {
    expect(
      ADMIN_POLICIES.filter((p) => p.assurance === "aal1_allowed").map(
        (p) => `${p.method} ${p.path}`,
      ),
    ).toEqual(["GET /api/viewer", "POST /api/enrolment/redeem"]);
  });

  it("declares no audit event, budget or intent on a GET, and a strict body on every other method", () => {
    for (const policy of ADMIN_POLICIES) {
      expect(policy.guard, policy.id).toBe("requireStaff");
      expect(policy.scope, policy.id).toBe("staff");
      expect(
        policy.path.startsWith("/api/") && !policy.path.startsWith("/api/auth"),
        policy.id,
      ).toBe(true);
      expect(isStrict(policy.params), policy.id).toBe(true);
      if (policy.method === "GET") {
        expect(policy.audit, policy.id).toEqual([]);
        expect(policy.limits, policy.id).toEqual([]);
        expect(policy.stepUp, policy.id).toBe("none");
        expect(policy.body, policy.id).toBeNull();
        expect(policy.secret, policy.id).toBe(false);
        expect("fetchSite" in policy, policy.id).toBe(false);
      } else {
        expect(policy.body, policy.id).not.toBeNull();
        expect(isStrict(policy.body as z.ZodObject), policy.id).toBe(true);
      }
    }
  });

  it("names a staff action for every intent and binds exactly its fields", () => {
    const actions: Record<string, readonly string[]> = {
      ...IDENTITY_STAFF_ACTIONS,
      ...Object.fromEntries(STAFF_ACTIONS.map((a) => [a.key, a.bind.map((b) => b.name)])),
    };
    for (const policy of ADMIN_POLICIES) {
      if (policy.stepUp === "none") {
        expect(policy.action, policy.id).toBeNull();
        expect(policy.bind, policy.id).toEqual([]);
        continue;
      }
      expect(policy.stepUp, policy.id).toBe("intent");
      const bind = actions[policy.action ?? ""];
      expect(bind, policy.id).toBeDefined();
      expect([...policy.bind], policy.id).toEqual([...(bind ?? [])]);
      expect(policy.limits, policy.id).toContain("step_up_intents");
      // Every bound field is a field of the body.
      for (const field of policy.bind) {
        expect(Object.keys((policy.body as z.ZodObject).shape), policy.id).toContain(field);
      }
    }
    // Every staff action has its route.
    for (const action of STAFF_ACTIONS) {
      expect(
        ADMIN_POLICIES.some((p) => p.action === action.key),
        action.key,
      ).toBe(true);
    }
  });

  it("guards every staff route by a permission of the staff catalogue, as §14.3 says", () => {
    const expected: Record<string, string | null> = {
      "viewer.get": null,
      "enrolment.redeem": null,
      "account.get": null,
      "account.session_revoke": null,
      "account.sessions_revoke_others": null,
      "staff.list": "staff.read",
      "staff.add": "staff.add",
      "staff.role": "staff.role",
      "staff.remove": "staff.remove",
      "staff.reset_factors": "staff.reset_factors",
      "staff.enrolment_code": "staff.add",
      "staff_roles.list": "staff.read",
      "staff_roles.get": "staff.read",
      "switches.list": "switches.manage",
      "switches.set": "switches.manage",
    };
    expect(Object.fromEntries(ADMIN_POLICIES.map((p) => [p.id, p.permission]))).toEqual(expected);
    for (const policy of ADMIN_POLICIES) {
      if (policy.permission !== null) {
        expect(Object.hasOwn(staffCatalogue.permissions, policy.permission)).toBe(true);
      }
    }
  });

  it("marks exactly the answers that carry an enrolment code as secret", () => {
    expect(ADMIN_POLICIES.filter((p) => p.secret).map((p) => p.id)).toEqual([
      "staff.add",
      "staff.reset_factors",
      "staff.enrolment_code",
    ]);
  });
});
