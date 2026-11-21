// Resolving roles, what each allows, labels and summaries.
import { describe, expect, it } from "vitest";
import { dashboardCatalogue as dash } from "../catalogue/dashboard/index.ts";
import { staffCatalogue as staff } from "../catalogue/staff/index.ts";
import { randomCustomRecord } from "../test-support/roles.ts";
import { propertyRuns, propertySeeds, seeded } from "../test-support/seeded.ts";
import { missingNeed } from "./permissions.ts";
import {
  builtInRole,
  describePermissions,
  isBuiltInKey,
  isCustomRoleId,
  isTopRole,
  listInWords,
  NO_ACCESS_LABEL,
  NOTHING_YET,
  permissionLabel,
  permissionsOf,
  resolveRole,
  roleKeyOf,
  roleLabel,
  sameRole,
  summary,
} from "./roles.ts";
import type { Catalogue, CustomRoleRecord, RoleRef } from "./types.ts";

const ID = "01JD6Z3Q8W5K2M4N7P9R0S1T2V";
const rolId = `rol_${ID}`;
const srlId = `srl_${ID}`;

const custom = (id: string, permissions: string[], extra: Partial<CustomRoleRecord> = {}) =>
  ({ kind: "custom", id, name: "Support", description: "", permissions, ...extra }) as const;

describe("resolveRole", () => {
  const records = new Map<string, CustomRoleRecord>([
    [rolId, { id: rolId, name: "Support", description: "", permissions: ["customers.read"] }],
  ]);
  const find = (id: string) => records.get(id);

  it("resolves built-in keys without a lookup", () => {
    expect(resolveRole(dash, "super_admin", () => undefined)).toEqual({
      kind: "built_in",
      key: "super_admin",
    });
    expect(resolveRole(staff, "compliance", () => undefined)).toEqual({
      kind: "built_in",
      key: "compliance",
    });
  });

  it("resolves a custom role ID through the lookup", () => {
    expect(resolveRole(dash, rolId, find)).toEqual({
      kind: "custom",
      id: rolId,
      name: "Support",
      description: "",
      permissions: ["customers.read"],
    });
  });

  it("answers gone for a custom ID with no row, or a row for another ID", () => {
    expect(resolveRole(dash, `rol_${"Z".repeat(26)}`, find)).toBe("gone");
    expect(
      resolveRole(dash, rolId, () => ({ ...(find(rolId) as CustomRoleRecord), id: "x" })),
    ).toBe("gone");
  });

  it.each([
    ["a staff role key in the dashboard", dash, "viewer"],
    ["a dashboard role key in Fin Admin", staff, "super_admin"],
    ["the other realm's custom ID", dash, srlId],
    ["a malformed ID", dash, "rol_123"],
    ["an ID with letters Crockford leaves out", dash, `rol_${"U".repeat(26)}`],
    ["an empty key", dash, ""],
    ["a label instead of a key", dash, "Super admin"],
  ] as const)("answers unknown for %s", (_what, cat, key) => {
    expect(resolveRole(cat as Catalogue, key, find)).toBe("unknown");
  });

  it("knows the shapes of keys", () => {
    expect(isBuiltInKey(dash, "admin")).toBe(true);
    expect(isBuiltInKey(dash, "viewer")).toBe(false);
    expect(isCustomRoleId(dash, rolId)).toBe(true);
    expect(isCustomRoleId(dash, srlId)).toBe(false);
    expect(isCustomRoleId(staff, srlId)).toBe(true);
    expect(isCustomRoleId(dash, `rol_${ID.toLowerCase()}`)).toBe(true);
    expect(isCustomRoleId(dash, `ROL_${ID}`)).toBe(false);
  });
});

describe("permissionsOf", () => {
  it("gives a built-in role its row", () => {
    expect(permissionsOf(dash, { kind: "built_in", key: "super_admin" }).size).toBe(26);
    expect(permissionsOf(dash, { kind: "built_in", key: "admin" }).has("organization.delete")).toBe(
      false,
    );
    expect([...permissionsOf(staff, { kind: "built_in", key: "viewer" })]).toEqual([
      "golive.read",
      "customers.read",
      "rfis.read",
      "organisations.read",
      "money.read",
      "audit.read",
      "staff.read",
    ]);
  });

  it("allows nothing to a role that is gone or unknown, or a built-in key it does not know", () => {
    expect(permissionsOf(dash, "gone").size).toBe(0);
    expect(permissionsOf(dash, "unknown").size).toBe(0);
    expect(permissionsOf(dash, { kind: "built_in", key: "viewer" }).size).toBe(0);
  });

  it("drops restricted and unknown names from a custom role", () => {
    const role = custom(rolId, [
      "customers.read",
      "organization.delete",
      "golive.edit",
      "golive.submit",
      "x.y",
    ]);
    expect([...permissionsOf(dash, role)]).toEqual(["customers.read", "golive.edit"]);
    const staffRole = custom(srlId, ["staff.read", "staff.role", "staffRoles.manage", "staff.add"]);
    expect([...permissionsOf(staff, staffRole)]).toEqual(["staff.read", "staff.add"]);
  });

  it("drops a custom role's permission whose need it does not hold, transitively", () => {
    expect([...permissionsOf(dash, custom(rolId, ["sandbox.reset", "simulator.use"]))]).toEqual([]);
    expect([
      ...permissionsOf(dash, custom(rolId, ["sandbox.reset", "simulator.use", "customers.read"])),
    ]).toEqual(["customers.read", "simulator.use", "sandbox.reset"]);
    expect([...permissionsOf(staff, custom(srlId, ["forms.manage", "rfis.read"]))]).toEqual([]);
  });

  const runs = propertyRuns(300);
  for (const seed of propertySeeds()) {
    it(`never lets a custom role hold a restricted permission or an unmet need (seed ${seed})`, () => {
      const rng = seeded(seed);
      for (const cat of [dash, staff] as Catalogue[]) {
        for (let run = 0; run < runs; run += 1) {
          const role = { kind: "custom", ...randomCustomRecord(rng, cat) } as const;
          const held = permissionsOf(cat, role);
          const at = `${cat.realm}, seed ${seed}, run ${run}`;
          for (const key of held) expect(cat.permissions[key]?.restricted, at).toBe(false);
          for (const key of held) expect(role.permissions, at).toContain(key);
          expect(missingNeed(cat, held), at).toEqual([]);
          // The largest such subset: every stored, unrestricted name whose needs are all stored
          // and unrestricted is kept.
          const usable = (key: string): boolean =>
            cat.keys.includes(key) &&
            !cat.permissions[key]?.restricted &&
            (cat.closure[key] ?? []).every(
              (need) => role.permissions.includes(need) && !cat.permissions[need]?.restricted,
            );
          for (const key of role.permissions) expect(held.has(key), at).toBe(usable(key));
        }
      }
    });
  }
});

describe("labels", () => {
  it("label built-in roles, custom roles and no role", () => {
    expect(roleLabel(dash, { kind: "built_in", key: "super_admin" })).toBe("Super admin");
    expect(roleLabel(staff, { kind: "built_in", key: "operator" })).toBe("Operator");
    expect(roleLabel(dash, custom(rolId, []))).toBe("Support");
    expect(roleLabel(dash, "unknown")).toBe(NO_ACCESS_LABEL);
    expect(roleLabel(dash, "gone")).toBe("No access");
    expect(roleLabel(dash, { kind: "built_in", key: "viewer" })).toBe("No access");
  });

  it("label permissions", () => {
    expect(permissionLabel(dash, "golive.submit")).toBe("Send it to Fin");
    expect(permissionLabel(staff, "switches.manage")).toBe("Use the kill switches");
    expect(permissionLabel(dash, "nope.x" as never)).toBe("");
  });

  it("find built-in rows and the top role", () => {
    expect(builtInRole(staff, "admin")?.holds).toBe("all");
    expect(builtInRole(staff, "super_admin")).toBeUndefined();
    expect(isTopRole(dash, { kind: "built_in", key: "super_admin" })).toBe(true);
    expect(isTopRole(dash, { kind: "built_in", key: "admin" })).toBe(false);
    expect(isTopRole(staff, { kind: "built_in", key: "admin" })).toBe(true);
    expect(isTopRole(dash, "unknown")).toBe(false);
    expect(isTopRole(dash, custom("super_admin", []) as unknown as RoleRef)).toBe(false);
  });

  it("compare roles by kind and key", () => {
    const a: RoleRef = { kind: "built_in", key: "admin" };
    expect(sameRole(a, { kind: "built_in", key: "admin" })).toBe(true);
    expect(sameRole(a, { kind: "built_in", key: "super_admin" })).toBe(false);
    expect(sameRole(custom(rolId, []), custom(rolId, ["customers.read"]))).toBe(true);
    expect(sameRole(custom("admin", []) as unknown as RoleRef, a)).toBe(false);
    expect(sameRole("gone", "gone")).toBe(false);
    expect(sameRole("unknown", a)).toBe(false);
    expect(roleKeyOf(a)).toBe("admin");
    expect(roleKeyOf(custom(rolId, []))).toBe(rolId);
  });
});

describe("summaries (spec 02 §8.2)", () => {
  it("say the spec's example sentence", () => {
    expect(
      describePermissions(dash, [
        "customers.read",
        "webhooks.read",
        "webhooks.manage",
        "apiKey.read",
        "apiKey.sandbox",
        "member.read",
      ]),
    ).toBe(
      "Can see customers, keys and the team, manage webhooks and manage Sandbox keys. Can't change the team.",
    );
  });

  it('say "Can\'t do anything yet." for no permission', () => {
    expect(describePermissions(dash, [])).toBe("Can't do anything yet.");
    expect(describePermissions(staff, [])).toBe(NOTHING_YET);
    expect(summary(dash, custom(rolId, []))).toBe(NOTHING_YET);
    expect(summary(dash, "unknown")).toBe(NOTHING_YET);
  });

  it("leave out the team sentence once the role can change the team", () => {
    expect(describePermissions(dash, ["member.read", "member.invite"])).toBe(
      "Can see the team and invite and remove people.",
    );
    expect(describePermissions(dash, ["customers.read"])).toBe(
      "Can see customers. Can't change the team.",
    );
    expect(
      describePermissions(staff, ["staff.read", "rfis.read", "rfis.manage", "customers.read"]),
    ).toBe("Can see customers and staff and handle requests for information. Can't change staff.");
  });

  it("use the built-in summary, a custom role's description, or the generated sentence", () => {
    expect(summary(dash, { kind: "built_in", key: "admin" })).toBe(
      "Everything except deleting the organisation, sending the Production request and making Super admins.",
    );
    expect(
      summary(dash, custom(rolId, ["customers.read"], { description: "Helps customers." })),
    ).toBe("Helps customers.");
    expect(summary(dash, custom(rolId, ["customers.read", "organization.delete"]))).toBe(
      "Can see customers. Can't change the team.",
    );
  });

  it("join lists in words", () => {
    expect(listInWords([])).toBe("");
    expect(listInWords(["a"])).toBe("a");
    expect(listInWords(["a", "b"])).toBe("a and b");
    expect(listInWords(["a", "b", "c"])).toBe("a, b and c");
  });
});
