// The types are precise enough that a screen cannot ask for an unknown permission: every line
// marked @ts-expect-error must fail to compile, or `pnpm typecheck` fails ("unused directive").
// At run time the same calls fail closed.
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  allows,
  type Catalogue,
  can,
  canAny,
  type DashboardPermission,
  type DashboardRoleKey,
  dashboardCatalogue,
  needsOf,
  type PermissionOf,
  permissionSet,
  type StaffPermission,
  type StaffRoleKey,
  staffCatalogue,
  validateRole,
} from "./index.ts";

describe("the permission types", () => {
  it("refuse a misspelt or another realm's permission at compile time", () => {
    const held = permissionSet(dashboardCatalogue, ["customers.read"]);
    expect(can(held, "customers.read")).toBe(true);
    // @ts-expect-error: a misspelt permission does not type-check
    expect(can(held, "customers.raed")).toBe(false);
    // @ts-expect-error: a Fin Admin permission is not a dashboard one
    expect(can(held, "staff.read")).toBe(false);
    // @ts-expect-error: nor in a list
    expect(canAny(held, ["customers.read", "golive.decide"])).toBe(true);

    const staffHeld = permissionSet(staffCatalogue, ["staff.read"]);
    // @ts-expect-error: a dashboard permission is not a Fin Admin one
    expect(can(staffHeld, "apiKey.read")).toBe(false);
    // @ts-expect-error: nor in a page's requirement
    expect(allows(staffHeld, { allOf: ["member.read"] })).toBe(false);
    // @ts-expect-error: nor a need asked of the catalogue
    expect(needsOf(dashboardCatalogue, "staff.add").size).toBe(0);
    const draft = { name: "A", description: "", permissions: ["staff.read" as const] };
    // @ts-expect-error: nor in a role editor's draft
    expect(validateRole(dashboardCatalogue, draft, held)).toContain("beyond");
  });

  it("type the catalogues' own lookups", () => {
    expect(dashboardCatalogue.permissions["golive.submit"].label).toBe("Send it to Fin");
    // @ts-expect-error: no such permission to look up
    expect(dashboardCatalogue.permissions["golive.decide"]).toBeUndefined();
    // @ts-expect-error: and none in Fin Admin's
    expect(staffCatalogue.permissions["golive.submit"]).toBeUndefined();
  });

  it("name the role keys", () => {
    const top: DashboardRoleKey = dashboardCatalogue.topRoleKey;
    const staffTop: StaffRoleKey = staffCatalogue.topRoleKey;
    expect([top, staffTop]).toEqual(["super_admin", "admin"]);
    // @ts-expect-error: Viewer is a staff role
    const viewer: DashboardRoleKey = "viewer";
    // @ts-expect-error: Super admin is a dashboard role
    const superAdmin: StaffRoleKey = "super_admin";
    expect([viewer, superAdmin]).toHaveLength(2);
  });

  it("derive exactly the 26 keys of each catalogue", () => {
    expectTypeOf<PermissionOf<typeof dashboardCatalogue>>().toEqualTypeOf<DashboardPermission>();
    expectTypeOf<DashboardPermission>().toEqualTypeOf<
      | "customers.read"
      | "customers.create"
      | "customers.restart"
      | "customers.delete"
      | "simulator.use"
      | "sandbox.reset"
      | "money.read"
      | "money.beneficiaries"
      | "money.transfer"
      | "money.simulate"
      | "webhooks.read"
      | "webhooks.manage"
      | "webhooks.roll_secret"
      | "webhooks.redeliver"
      | "apiKey.read"
      | "apiKey.sandbox"
      | "apiKey.live"
      | "member.read"
      | "member.invite"
      | "member.role"
      | "role.manage"
      | "auditLog.read"
      | "organization.update"
      | "organization.delete"
      | "golive.edit"
      | "golive.submit"
    >();
    expectTypeOf<StaffPermission>().toEqualTypeOf<
      | "golive.read"
      | "golive.decide"
      | "customers.read"
      | "customers.reveal"
      | "documents.view"
      | "customers.decide"
      | "rfis.read"
      | "rfis.manage"
      | "organisations.read"
      | "organisations.pause"
      | "organisations.approvals"
      | "accounts.recover"
      | "money.read"
      | "money.operate"
      | "switches.manage"
      | "audit.read"
      | "forms.manage"
      | "reasons.manage"
      | "templates.manage"
      | "views.manage"
      | "staff.read"
      | "staff.add"
      | "staff.remove"
      | "staff.role"
      | "staff.reset_factors"
      | "staffRoles.manage"
    >();
    expectTypeOf(dashboardCatalogue).toExtend<Catalogue<DashboardPermission, DashboardRoleKey>>();
    expectTypeOf<DashboardRoleKey>().toEqualTypeOf<"super_admin" | "admin">();
    expectTypeOf<StaffRoleKey>().toEqualTypeOf<"viewer" | "compliance" | "operator" | "admin">();
  });
});
