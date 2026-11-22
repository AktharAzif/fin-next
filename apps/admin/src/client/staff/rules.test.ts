// The Staff page mirrors the server's rules (spec 02 §8.5, §8.7, §10.8): disabled with a reason,
// never hidden from the page; the server refuses either way.
import { describe, expect, it } from "vitest";
import type { StaffMember, StaffRole } from "../api/contracts.ts";
import {
  type Actor,
  addReason,
  BEYOND,
  defaultRoleKey,
  givingReason,
  isLastActiveAdmin,
  LAST_ADMIN,
  NO_PERMISSION,
  OUTRANKED,
  OWN_REMOVAL,
  OWN_ROLE,
  rowControls,
  TOP_ONLY,
} from "./rules.ts";

const READS = [
  "golive.read",
  "customers.read",
  "rfis.read",
  "organisations.read",
  "money.read",
  "audit.read",
  "staff.read",
];
const COMPLIANCE = [
  ...READS,
  "customers.reveal",
  "documents.view",
  "customers.decide",
  "rfis.manage",
  "forms.manage",
  "golive.decide",
  "views.manage",
];
const OPERATOR = [
  ...COMPLIANCE,
  "organisations.pause",
  "organisations.approvals",
  "switches.manage",
];
const ADMIN = [
  ...OPERATOR,
  "accounts.recover",
  "money.operate",
  "reasons.manage",
  "templates.manage",
  "staff.add",
  "staff.remove",
  "staff.role",
  "staff.reset_factors",
  "staffRoles.manage",
];

const ROLES: StaffRole[] = [
  { key: "viewer", label: "Viewer", summary: "Sees.", builtIn: true, permissions: READS },
  {
    key: "compliance",
    label: "Compliance",
    summary: "Decides.",
    builtIn: true,
    permissions: COMPLIANCE,
  },
  {
    key: "operator",
    label: "Operator",
    summary: "Operates.",
    builtIn: true,
    permissions: OPERATOR,
  },
  { key: "admin", label: "Admin", summary: "Everything.", builtIn: true, permissions: ADMIN },
];

function member(id: string, roleKey: string, status: "active" | "pending" = "active"): StaffMember {
  return {
    id,
    email: `${id}@example.com`,
    roleKey,
    roleLabel: roleKey,
    status,
    lastSignedInAt: null,
    factors: status === "active" ? ["passkey"] : [],
  };
}

const admin = (id: string): Actor => ({ id, roleKey: "admin", permissions: new Set(ADMIN) });
const viewer = (id: string): Actor => ({ id, roleKey: "viewer", permissions: new Set(READS) });

describe("rowControls", () => {
  const nadia = member("nadia", "admin");
  const owen = member("owen", "operator");
  const mei = member("mei", "viewer", "pending");
  const staff = [nadia, owen, mei];

  it("lets an Admin change and remove someone else", () => {
    expect(rowControls(admin("nadia"), owen, staff, ROLES)).toEqual({
      changeRole: null,
      remove: null,
    });
  });

  it("keeps the last active Admin, with the reason", () => {
    expect(isLastActiveAdmin(nadia, staff)).toBe(true);
    expect(rowControls(admin("nadia"), nadia, staff, ROLES)).toEqual({
      changeRole: LAST_ADMIN,
      remove: LAST_ADMIN,
    });
  });

  it("refuses one's own row when another Admin exists", () => {
    const ines = member("ines", "admin");
    const both = [...staff, ines];
    expect(isLastActiveAdmin(nadia, both)).toBe(false);
    expect(rowControls(admin("nadia"), nadia, both, ROLES)).toEqual({
      changeRole: OWN_ROLE,
      remove: OWN_REMOVAL,
    });
    expect(rowControls(admin("nadia"), ines, both, ROLES)).toEqual({
      changeRole: null,
      remove: null,
    });
  });

  it("does not count a pending Admin as one who stays", () => {
    const pendingAdmin = member("ravi", "admin", "pending");
    expect(isLastActiveAdmin(nadia, [...staff, pendingAdmin])).toBe(true);
  });

  it("offers a pending member a new code, with staff.add", () => {
    expect(rowControls(admin("nadia"), mei, staff, ROLES).newCode).toBeNull();
    expect(rowControls(admin("nadia"), owen, staff, ROLES).newCode).toBeUndefined();
  });

  it("disables everything for a role without the permission, saying why", () => {
    expect(rowControls(viewer("owen"), mei, staff, ROLES)).toEqual({
      changeRole: NO_PERMISSION,
      remove: NO_PERMISSION,
      newCode: NO_PERMISSION,
    });
    expect(addReason(viewer("owen"))).toBe(NO_PERMISSION);
    expect(addReason(admin("nadia"))).toBeNull();
  });

  it("refuses a target whose role allows more than the actor's", () => {
    const remover: Actor = {
      id: "x",
      roleKey: "custom",
      permissions: new Set([...READS, "staff.remove", "staff.role"]),
    };
    expect(rowControls(remover, owen, staff, ROLES).remove).toBe(OUTRANKED);
    expect(rowControls(remover, member("v", "viewer"), staff, ROLES).remove).toBeNull();
  });
});

describe("givingReason", () => {
  it("lets only an Admin give the Admin role", () => {
    const strong: Actor = { id: "x", roleKey: "custom", permissions: new Set(ADMIN) };
    expect(givingReason(strong, ROLES[3] as StaffRole)).toBe(TOP_ONLY);
    expect(givingReason(admin("nadia"), ROLES[3] as StaffRole)).toBeNull();
  });

  it("refuses a role holding a permission the actor lacks", () => {
    const actor: Actor = { id: "x", roleKey: "custom", permissions: new Set(READS) };
    expect(givingReason(actor, ROLES[1] as StaffRole)).toBe(BEYOND);
    expect(givingReason(actor, ROLES[0] as StaffRole)).toBeNull();
  });

  it("starts a new member on the first role the actor may give", () => {
    expect(defaultRoleKey(admin("nadia"), ROLES)).toBe("viewer");
    expect(
      defaultRoleKey({ id: "x", roleKey: "custom", permissions: new Set() }, ROLES),
    ).toBeNull();
  });
});
