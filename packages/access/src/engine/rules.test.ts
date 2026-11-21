// Table tests: every rule of spec 02 §8.5 (who may act on whom) and §8.4 (custom roles), in both
// realms, with the refusal each maps to. One row per rule and case.
import { describe, expect, it } from "vitest";
import { dashboardCatalogue as dash } from "../catalogue/dashboard/index.ts";
import { staffCatalogue as staff } from "../catalogue/staff/index.ts";
import {
  actingProblem,
  deletionProblem,
  editingProblem,
  givingProblem,
  lastTopRoleProblem,
  type TopRoleChange,
} from "./giving.ts";
import { withNeeds } from "./permissions.ts";
import {
  CUSTOM_ROLE_LIMIT,
  customRoleLimitReached,
  ROLE_EDIT_LIMITS,
  validateRole,
} from "./role-editor.ts";
import { permissionsOf, roleKeyOf } from "./roles.ts";
import type { Catalogue, RoleLookup, RoleRef } from "./types.ts";

const id = (prefix: string, n: number) => `${prefix}_${String(n).padStart(26, "0")}`;
const builtIn = (key: string): RoleRef => ({ kind: "built_in", key });
const customRole = (cat: Catalogue, n: number, permissions: readonly string[]): RoleRef => ({
  kind: "custom",
  id: id(cat.customRolePrefix, n),
  name: `Custom ${n}`,
  description: "",
  permissions: [...withNeeds(cat, permissions)],
});

// The dashboard's cast.
const SUPER = builtIn("super_admin");
const ADMIN = builtIn("admin");
const ROLE_CHANGER = customRole(dash, 1, ["member.role"]); // may change roles, nothing else
const REMOVER = customRole(dash, 2, ["member.invite"]); // may invite and remove
const SUPPORT = customRole(dash, 3, ["customers.read", "customers.create"]);
const READ_ONLY = customRole(dash, 4, ["customers.read", "member.read", "auditLog.read"]);
const CHANGER_PLUS = customRole(dash, 5, ["member.role", "customers.read", "customers.create"]);

// Fin Admin's cast.
const VIEWER = builtIn("viewer");
const COMPLIANCE = builtIn("compliance");
const OPERATOR = builtIn("operator");
const STAFF_ADMIN = builtIn("admin");
const STAFF_ADDER = customRole(staff, 1, ["staff.add", "staff.remove", "customers.read"]);
const STAFF_ADDER_PLUS = customRole(staff, 2, [
  ...permissionsOf(staff, builtIn("operator")),
  "staff.add",
  "staff.remove",
]);

interface Actor {
  readonly key: string;
  readonly perms: ReadonlySet<string>;
}
const actorOf = (cat: Catalogue, role: RoleRef): Actor => ({
  key: roleKeyOf(role),
  perms: permissionsOf(cat, role),
});

type GiveRow = [
  rule: string,
  cat: Catalogue,
  actor: RoleRef,
  targetIsSelf: boolean,
  current: RoleLookup | undefined,
  newRole: RoleLookup,
  expected: string | null,
];

// biome-ignore format: one rule per line
const give: GiveRow[] = [
  // Nobody gives a role holding a permission they lack (403 giving_refused, problem beyond).
  ["beyond: a role changer gives Admin", dash, ROLE_CHANGER, false, READ_ONLY, ADMIN, "beyond"],
  ["beyond: a role changer gives a role with customers", dash, ROLE_CHANGER, false, undefined, SUPPORT, "beyond"],
  ["beyond: an inviter invites as Support", dash, REMOVER, false, undefined, SUPPORT, "beyond"],
  ["beyond: an Admin gives a role it holds all of", dash, ADMIN, false, READ_ONLY, SUPPORT, null],
  ["beyond: staff Compliance gives Operator", staff, COMPLIANCE, false, VIEWER, OPERATOR, "beyond"],
  ["beyond: a staff adder adds a Viewer", staff, STAFF_ADDER, false, undefined, VIEWER, "beyond"],
  ["beyond: an Operator-plus adder adds an Operator", staff, STAFF_ADDER_PLUS, false, undefined, OPERATOR, null],
  // Only the top role gives the top role (problem top_only).
  ["top_only: an Admin gives Super admin", dash, ADMIN, false, ADMIN, SUPER, "top_only"],
  ["top_only: an Admin invites a Super admin", dash, ADMIN, false, undefined, SUPER, "top_only"],
  ["top_only: a Super admin gives Super admin", dash, SUPER, false, ADMIN, SUPER, null],
  ["top_only: a Super admin invites a Super admin", dash, SUPER, false, undefined, SUPER, null],
  ["top_only: a staff Operator adds an Admin", staff, OPERATOR, false, undefined, STAFF_ADMIN, "top_only"],
  ["top_only: a staff adder adds an Admin", staff, STAFF_ADDER_PLUS, false, undefined, STAFF_ADMIN, "top_only"],
  ["top_only: a staff Admin makes an Admin", staff, STAFF_ADMIN, false, VIEWER, STAFF_ADMIN, null],
  // Nobody changes their own role (problem self), the top role included.
  ["self: a Super admin changes their own role", dash, SUPER, true, SUPER, ADMIN, "self"],
  ["self: an Admin changes their own role", dash, ADMIN, true, ADMIN, READ_ONLY, "self"],
  ["self: a role changer keeps their own role", dash, ROLE_CHANGER, true, ROLE_CHANGER, ROLE_CHANGER, "self"],
  ["self: a staff Admin demotes themselves", staff, STAFF_ADMIN, true, STAFF_ADMIN, VIEWER, "self"],
  // Both the target's current role and the new one within the actor (403 outranked).
  ["outranked: an Admin demotes a Super admin", dash, ADMIN, false, SUPER, ADMIN, "outranked"],
  ["outranked: a role changer demotes an Admin", dash, CHANGER_PLUS, false, ADMIN, SUPPORT, "outranked"],
  ["outranked: a role changer moves a Support member", dash, CHANGER_PLUS, false, SUPPORT, ROLE_CHANGER, null],
  ["outranked: an Admin changes a Super admin's invitation", dash, ADMIN, false, SUPER, READ_ONLY, "outranked"],
  ["outranked: a staff adder-plus changes an Admin", staff, STAFF_ADDER_PLUS, false, STAFF_ADMIN, VIEWER, "outranked"],
  ["outranked: a Super admin demotes an Admin", dash, SUPER, false, ADMIN, READ_ONLY, null],
  ["outranked: a Super admin demotes another Super admin", dash, SUPER, false, SUPER, ADMIN, null],
  ["outranked: anyone may fix a No access member", dash, ROLE_CHANGER, false, "unknown", ROLE_CHANGER, null],
  // A role that no longer exists, or a key Fin does not know (gone, unknown_role).
  ["gone: a deleted custom role", dash, SUPER, false, ADMIN, "gone", "gone"],
  ["unknown_role: a key Fin does not know", dash, SUPER, false, ADMIN, "unknown", "unknown_role"],
  ["unknown_role: in Fin Admin", staff, STAFF_ADMIN, false, VIEWER, "unknown", "unknown_role"],
  // The same role again (problem unchanged).
  ["unchanged: Admin to Admin", dash, SUPER, false, ADMIN, ADMIN, "unchanged"],
  ["unchanged: a custom role to itself", dash, ADMIN, false, SUPPORT, { ...SUPPORT }, "unchanged"],
  ["unchanged: Viewer to Viewer", staff, STAFF_ADMIN, false, VIEWER, VIEWER, "unchanged"],
];

describe("§8.5 giving a role: invitations, new staff and role changes", () => {
  it.each(give)("%s", (_rule, cat, actorRole, targetIsSelf, current, newRole, expected) => {
    const actor = actorOf(cat, actorRole);
    const problem = givingProblem(cat, {
      actorRoleKey: actor.key,
      actorPerms: actor.perms,
      targetIsSelf,
      ...(current === undefined ? {} : { targetCurrentRole: current }),
      newRole,
    });
    expect(problem).toBe(expected);
  });

  it("refuses the top role to an actor who holds every permission but not the top role", () => {
    const problem = givingProblem(dash, {
      actorRoleKey: id("rol", 9),
      actorPerms: new Set(dash.keys),
      targetIsSelf: false,
      newRole: SUPER,
    });
    expect(problem).toBe("top_only");
  });

  it("gives nothing for an actor whose role Fin does not know", () => {
    for (const newRole of [SUPPORT, READ_ONLY, ADMIN]) {
      const problem = givingProblem(dash, {
        actorRoleKey: "owner",
        actorPerms: permissionsOf(dash, "unknown"),
        targetIsSelf: false,
        newRole,
      });
      expect(problem).toBe("beyond");
    }
  });
});

type ActRow = [
  rule: string,
  cat: Catalogue,
  actor: RoleRef,
  targetIsSelf: boolean,
  target: RoleLookup,
  expected: string | null,
];

// biome-ignore format: one rule per line
const act: ActRow[] = [
  // Nobody removes themselves or resets themselves (problem self).
  ["self: a Super admin removes themselves", dash, SUPER, true, SUPER, "self"],
  ["self: a remover removes themselves", dash, REMOVER, true, REMOVER, "self"],
  ["self: a staff Admin resets their own factors", staff, STAFF_ADMIN, true, STAFF_ADMIN, "self"],
  ["self: a staff adder removes themselves", staff, STAFF_ADDER, true, STAFF_ADDER, "self"],
  // Only a target within the actor's permissions (403 outranked).
  ["outranked: a remover removes an Admin", dash, REMOVER, false, ADMIN, "outranked"],
  ["outranked: a remover removes Support", dash, REMOVER, false, SUPPORT, "outranked"],
  ["outranked: an Admin removes a Super admin", dash, ADMIN, false, SUPER, "outranked"],
  ["outranked: an Admin cancels a Super admin's invitation", dash, ADMIN, false, SUPER, "outranked"],
  ["outranked: an Admin removes Support", dash, ADMIN, false, SUPPORT, null],
  ["outranked: a remover removes another remover", dash, REMOVER, false, customRole(dash, 7, ["member.invite"]), null],
  ["outranked: a remover removes a No access member", dash, REMOVER, false, "unknown", null],
  ["outranked: a staff adder removes an Admin", staff, STAFF_ADDER_PLUS, false, STAFF_ADMIN, "outranked"],
  ["outranked: a staff adder-plus removes an Operator", staff, STAFF_ADDER_PLUS, false, OPERATOR, null],
  ["outranked: a staff adder removes a Viewer", staff, STAFF_ADDER, false, VIEWER, "outranked"],
  ["outranked: a staff Admin resets another Admin", staff, STAFF_ADMIN, false, STAFF_ADMIN, null],
];

describe("§8.5 acting on someone: removing, resetting, resending and cancelling", () => {
  it.each(act)("%s", (_rule, cat, actorRole, targetIsSelf, targetRole, expected) => {
    const actor = actorOf(cat, actorRole);
    expect(actingProblem(cat, { actorPerms: actor.perms, targetIsSelf, targetRole })).toBe(
      expected,
    );
  });
});

type TopRow = [
  rule: string,
  cat: Catalogue,
  target: RoleLookup,
  change: TopRoleChange,
  holders: number,
  expected: string | null,
];

// biome-ignore format: one rule per line
const top: TopRow[] = [
  // The last holder of the top role cannot be removed or demoted (409 last_top_role).
  ["the last Super admin removed", dash, SUPER, "remove", 1, "last_top_role"],
  ["the last Super admin demoted", dash, SUPER, { newRole: ADMIN }, 1, "last_top_role"],
  ["the last Super admin moved to a custom role", dash, SUPER, { newRole: SUPPORT }, 1, "last_top_role"],
  ["the last Super admin given an unknown role", dash, SUPER, { newRole: "unknown" }, 1, "last_top_role"],
  ["one of two Super admins removed", dash, SUPER, "remove", 2, null],
  ["one of two Super admins demoted", dash, SUPER, { newRole: ADMIN }, 2, null],
  ["the last Super admin kept a Super admin", dash, SUPER, { newRole: SUPER }, 1, null],
  ["an Admin removed with no Super admin counted", dash, ADMIN, "remove", 0, null],
  ["a count below one is the last holder", dash, SUPER, "remove", 0, "last_top_role"],
  // Staff: the last active Admin cannot be removed, demoted or reset.
  ["the last staff Admin removed", staff, STAFF_ADMIN, "remove", 1, "last_top_role"],
  ["the last staff Admin demoted", staff, STAFF_ADMIN, { newRole: OPERATOR }, 1, "last_top_role"],
  ["the last staff Admin reset", staff, STAFF_ADMIN, "reset", 1, "last_top_role"],
  ["one of two staff Admins reset", staff, STAFF_ADMIN, "reset", 2, null],
  ["one of three staff Admins demoted", staff, STAFF_ADMIN, { newRole: VIEWER }, 3, null],
  ["a Viewer reset", staff, VIEWER, "reset", 1, null],
  ["a custom staff role removed", staff, STAFF_ADDER, "remove", 1, null],
];

describe("§8.5 the last holder of the top role", () => {
  it.each(top)("%s", (_rule, cat, targetRole, change, topHolders, expected) => {
    expect(lastTopRoleProblem(cat, { targetRole, change, topHolders })).toBe(expected);
  });
});

describe("§8.4 editing and deleting a custom role", () => {
  const manager = customRole(dash, 6, ["role.manage"]);
  // biome-ignore format: one rule per line
  const editRows: [string, Catalogue, RoleRef, RoleLookup, string | null][] = [
    ["a built-in role is immutable", dash, SUPER, ADMIN, "built_in"],
    ["a prebuilt staff role is immutable", staff, STAFF_ADMIN, VIEWER, "built_in"],
    ["never the role the editor holds", dash, CHANGER_PLUS, CHANGER_PLUS, "self"],
    ["never a role that does more than the editor", dash, manager, SUPPORT, "outranked"],
    ["a role within the editor", dash, ADMIN, SUPPORT, null],
    ["a staff role within the editor", staff, STAFF_ADMIN, STAFF_ADDER, null],
    ["a role that no longer exists", dash, ADMIN, "gone", "gone"],
    ["a key Fin does not know", dash, ADMIN, "unknown", "gone"],
  ];
  it.each(editRows)("editing: %s", (_rule, cat, actorRole, role, expected) => {
    const actor = actorOf(cat, actorRole);
    expect(editingProblem(cat, { actorRoleKey: actor.key, actorPerms: actor.perms, role })).toBe(
      expected,
    );
  });

  const managerOfSupport = customRole(dash, 8, [
    "role.manage",
    "customers.read",
    "customers.create",
  ]);
  const managerMover = customRole(dash, 10, [
    "role.manage",
    "member.role",
    "customers.read",
    "customers.create",
  ]);
  const customersOnly = customRole(dash, 11, ["customers.read"]);
  type DeleteRow = [
    string,
    Catalogue,
    RoleRef,
    RoleRef,
    number,
    number,
    RoleLookup | undefined,
    string | null,
  ];
  // biome-ignore format: one rule per line
  const deleteRows: DeleteRow[] = [
    ["an unused role, with no move", dash, ADMIN, SUPPORT, 0, 0, undefined, null],
    ["a held role needs somewhere to move its holders", dash, ADMIN, SUPPORT, 2, 0, undefined, "move_required"],
    ["an offered role needs somewhere to move its invitations", dash, ADMIN, SUPPORT, 0, 1, undefined, "move_required"],
    ["moving people needs member.role", dash, managerOfSupport, SUPPORT, 1, 0, customersOnly, "move_forbidden"],
    ["moving only invitations does not", dash, managerOfSupport, SUPPORT, 0, 1, customersOnly, null],
    ["the move must be a role the actor may give", dash, managerMover, SUPPORT, 1, 0, ADMIN, "beyond"],
    ["the move may not be the top role from below it", dash, ADMIN, SUPPORT, 1, 0, SUPER, "top_only"],
    ["the move may not be the role itself", dash, ADMIN, SUPPORT, 1, 0, SUPPORT, "unchanged"],
    ["the move may not be a role that is gone", dash, ADMIN, SUPPORT, 1, 0, "gone", "gone"],
    ["a move within the actor", dash, managerMover, SUPPORT, 3, 2, customersOnly, null],
    ["the editing rules come first", dash, ADMIN, ADMIN, 1, 0, READ_ONLY, "built_in"],
    ["Fin Admin moves people with staff.role", staff, STAFF_ADMIN, STAFF_ADDER, 1, 0, VIEWER, null],
  ];
  it.each(deleteRows)("deleting: %s", (...row) => {
    const [, cat, actorRole, role, holders, invitations, moveTo, expected] = row;
    const actor = actorOf(cat, actorRole);
    expect(
      deletionProblem(cat, {
        actorRoleKey: actor.key,
        actorPerms: actor.perms,
        role,
        holders,
        invitations,
        ...(moveTo === undefined ? {} : { moveTo }),
      }),
    ).toBe(expected);
  });
});

describe("§8.4 a custom role's draft", () => {
  const adminPerms = permissionsOf(dash, ADMIN);
  const superPerms = permissionsOf(dash, SUPER);
  const staffAdminPerms = permissionsOf(staff, STAFF_ADMIN);
  const supportPerms = permissionsOf(dash, SUPPORT);
  const draft = (permissions: string[], name = "Support desk", description = "") => ({
    name,
    description,
    permissions,
  });
  const d = (permissions: string[]) => draft(permissions);
  const named = (name: string) => draft(["customers.read"], name);
  const described = (description: string) => draft(["customers.read"], "Support desk", description);

  type DraftRow = [string, Catalogue, ReturnType<typeof draft>, ReadonlySet<string>, string[]];
  // biome-ignore format: one rule per line
  const rows: DraftRow[] = [
    ["a good draft", dash, d(["customers.read", "customers.create"]), adminPerms, []],
    ["at least one permission", dash, d([]), adminPerms, ["empty"]],
    ["never a restricted one (Super admin only)", dash, d(["organization.delete"]), superPerms, ["restricted"]],
    ["never an Admin-only one in Fin Admin", staff, d(["staff.read", "staff.role"]), staffAdminPerms, ["restricted"]],
    ["never one the editor lacks", dash, d(["customers.read", "money.read", "money.transfer"]), supportPerms, ["beyond"]],
    ["never one the catalogue does not know", dash, d(["customers.read", "customers.raed"]), adminPerms, ["beyond"]],
    ["every need held", dash, d(["sandbox.reset", "simulator.use"]), adminPerms, ["missing_need"]],
    ["a name of at most 40 characters", dash, named("x".repeat(41)), adminPerms, ["name"]],
    ["a name of at least 1 character", dash, named(""), adminPerms, ["name"]],
    ["at most 5 words", dash, named("One two three four five six"), adminPerms, ["name"]],
    ["5 words are allowed", dash, named("One two three four five"), adminPerms, []],
    ["40 characters are allowed", dash, named("y".repeat(40)), adminPerms, []],
    ["never a built-in's name", dash, named("Admin"), adminPerms, ["reads_as_built_in"]],
    ["never one that reads as one", dash, named("Super Admin"), adminPerms, ["reads_as_built_in"]],
    ["never a plural that reads as one", dash, named("Admins"), adminPerms, ["reads_as_built_in"]],
    ["against the staff built-ins in Fin Admin", staff, draft(["staff.read"], "Operators"), staffAdminPerms, ["reads_as_built_in"]],
    ["a staff name is fine in the dashboard", dash, named("Viewer"), adminPerms, []],
    ["a description of at most 120 characters", dash, described("d".repeat(121)), adminPerms, ["description"]],
    ["120 characters are allowed", dash, described("d".repeat(120)), adminPerms, []],
    ["several problems at once", dash, draft(["organization.delete", "golive.submit"], "Super-admins", " x"), adminPerms, ["reads_as_built_in", "description", "restricted", "beyond", "missing_need"]],
  ];
  it.each(rows)("%s", (_rule, cat, roleDraft, actorPerms, expected) => {
    expect(validateRole(cat, roleDraft, actorPerms)).toEqual(expected);
  });

  it("is unique per organisation, ignoring case", () => {
    const options = { takenNames: ["Support Desk", "Billing"] };
    const cat: Catalogue = dash;
    expect(validateRole(cat, named("support desk"), adminPerms, options)).toEqual(["name_taken"]);
    expect(validateRole(cat, named("Payments"), adminPerms, options)).toEqual([]);
  });

  it("holds at most 30 custom roles, and limits edits to 30 an hour and 100 a day", () => {
    expect(CUSTOM_ROLE_LIMIT).toBe(30);
    expect(customRoleLimitReached(29)).toBe(false);
    expect(customRoleLimitReached(30)).toBe(true);
    expect(customRoleLimitReached(31)).toBe(true);
    expect(customRoleLimitReached(Number.NaN)).toBe(true);
    expect(ROLE_EDIT_LIMITS).toEqual({ perHour: 30, perDay: 100 });
    expect(Object.isFrozen(ROLE_EDIT_LIMITS)).toBe(true);
  });
});
