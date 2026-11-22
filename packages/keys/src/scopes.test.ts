// T05-05: KEY_SCOPE_NEEDS and FULL_ACCESS_NEEDS are spec 05 §4.4's table; Sandbox scopes are refused on
// live keys; an unknown scope is refused; a key never does more than its maker's role.
import { dashboardCatalogue } from "@fin/access";
import { describe, expect, it } from "vitest";
import {
  accessLabel,
  checkScopes,
  FULL_ACCESS_NEEDS,
  KEY_SCOPE_NEEDS,
  makeableFor,
  managePermission,
  missingPermissions,
  permissionsNeeded,
  SCOPES,
  scopesAllowedFor,
} from "./scopes.ts";

const ALL = new Set<string>(dashboardCatalogue.keys);

describe("the scope table", () => {
  it("is spec 05 §4.4's, with no quotes:write", () => {
    expect(SCOPES).toEqual([
      "customers:read",
      "customers:write",
      "events:read",
      "money:read",
      "money:write",
      "beneficiaries:write",
      "sandbox:simulate",
      "sandbox:deposit",
    ]);
    expect(KEY_SCOPE_NEEDS).toEqual({
      "customers:read": ["customers.read"],
      "customers:write": [
        "customers.read",
        "customers.create",
        "customers.restart",
        "customers.delete",
      ],
      "events:read": ["webhooks.read"],
      "money:read": ["customers.read", "money.read"],
      "money:write": ["customers.read", "money.read", "money.transfer"],
      "beneficiaries:write": ["customers.read", "money.read", "money.beneficiaries"],
      "sandbox:simulate": ["customers.read", "simulator.use"],
      "sandbox:deposit": ["customers.read", "simulator.use", "money.read", "money.simulate"],
    });
    expect(FULL_ACCESS_NEEDS.test).toEqual([
      "webhooks.manage",
      "webhooks.roll_secret",
      "webhooks.redeliver",
      "sandbox.reset",
    ]);
    expect(FULL_ACCESS_NEEDS.live).toEqual([
      "webhooks.manage",
      "webhooks.roll_secret",
      "webhooks.redeliver",
    ]);
  });

  it("names only permissions of the dashboard catalogue", () => {
    for (const needs of [...Object.values(KEY_SCOPE_NEEDS), ...Object.values(FULL_ACCESS_NEEDS)]) {
      for (const permission of needs) expect(ALL.has(permission), permission).toBe(true);
    }
    expect(managePermission("test")).toBe("apiKey.sandbox");
    expect(managePermission("live")).toBe("apiKey.live");
  });
});

describe("checkScopes", () => {
  it("refuses Sandbox scopes on a live key and unknown, duplicate or missing scopes", () => {
    expect(scopesAllowedFor("live")).not.toContain("sandbox:simulate");
    expect(checkScopes("live", "rk", ["sandbox:deposit"])).toMatchObject({
      ok: false,
      problem: "sandbox_scope_on_live",
    });
    expect(checkScopes("test", "rk", ["quotes:write"])).toMatchObject({
      ok: false,
      problem: "unknown_scope",
    });
    expect(checkScopes("test", "rk", ["money:read", "money:read"])).toMatchObject({
      ok: false,
      problem: "duplicate_scope",
    });
    expect(checkScopes("test", "rk", [])).toMatchObject({ ok: false, problem: "no_scope" });
    expect(checkScopes("test", "sk", ["money:read"])).toMatchObject({
      ok: false,
      problem: "scopes_on_full_access",
    });
  });

  it("answers the scopes in catalogue order", () => {
    expect(checkScopes("test", "rk", ["events:read", "customers:read"])).toEqual({
      ok: true,
      scopes: ["customers:read", "events:read"],
    });
    expect(checkScopes("live", "sk", [])).toEqual({ ok: true, scopes: [] });
  });
});

describe("the maker's role bounds the key", () => {
  const developer = new Set([
    "customers.read",
    "customers.create",
    "customers.restart",
    "simulator.use",
    "money.read",
    "money.beneficiaries",
    "money.transfer",
    "money.simulate",
    "webhooks.read",
    "webhooks.manage",
    "webhooks.roll_secret",
    "webhooks.redeliver",
    "apiKey.read",
    "apiKey.sandbox",
    "member.read",
  ]);

  it("lets a Super admin make every key of either mode", () => {
    expect(missingPermissions(ALL, "test", "sk", [])).toEqual([]);
    expect(missingPermissions(ALL, "live", "sk", [])).toEqual([]);
    expect(makeableFor(ALL, "test")).toEqual({
      manage: true,
      fullAccess: true,
      scopes: [...SCOPES],
    });
  });

  it("keeps a Developer (no customers.delete, sandbox.reset or apiKey.live) to what the role holds", () => {
    expect(missingPermissions(developer, "test", "sk", [])).toEqual([
      "customers.delete",
      "sandbox.reset",
    ]);
    expect(missingPermissions(developer, "test", "rk", ["customers:write"])).toEqual([
      "customers.delete",
    ]);
    expect(missingPermissions(developer, "test", "rk", ["money:write", "events:read"])).toEqual([]);
    expect(missingPermissions(developer, "live", "rk", ["money:read"])).toEqual(["apiKey.live"]);
    expect(makeableFor(developer, "test")).toEqual({
      manage: true,
      fullAccess: false,
      scopes: SCOPES.filter((s) => s !== "customers:write"),
    });
    expect(makeableFor(developer, "live")).toEqual({
      manage: false,
      fullAccess: false,
      scopes: [],
    });
  });

  it("needs every scope's permissions, the webhook ones and sandbox.reset for a full-access Sandbox key", () => {
    const needed = permissionsNeeded("test", "sk", []);
    for (const scope of SCOPES) for (const p of KEY_SCOPE_NEEDS[scope]) expect(needed).toContain(p);
    expect(needed).toContain("sandbox.reset");
    expect(permissionsNeeded("live", "sk", [])).not.toContain("sandbox.reset");
    expect(permissionsNeeded("live", "sk", [])).not.toContain("simulator.use");
  });

  it("labels access as the console shows it", () => {
    expect(accessLabel("sk", 0)).toBe("Full access");
    expect(accessLabel("rk", 1)).toBe("Restricted · 1 scope");
    expect(accessLabel("rk", 4)).toBe("Restricted · 4 scopes");
  });
});
