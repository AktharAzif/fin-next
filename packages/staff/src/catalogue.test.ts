// Fin Admin's roles at run time (spec 02 §8.3, [SA-12]): what each prebuilt role allows, a role Fin
// does not know allows nothing, and a custom role never holds an Admin-only permission.
import type { StaffRoleKey } from "@fin/access";
import { describe, expect, it } from "vitest";
import {
  isStaffPermission,
  lowers,
  PREBUILT_ROLE_KEYS,
  STAFF_CATALOGUE,
  staffPermissionsOf,
  staffRoleLabel,
  TOP_ROLE,
} from "./catalogue.ts";

const builtIn = (key: StaffRoleKey) => ({ kind: "built_in", key }) as const;

describe("the staff roles", () => {
  it("are the four prebuilt roles, Admin on top", () => {
    expect(PREBUILT_ROLE_KEYS).toEqual(["viewer", "compliance", "operator", "admin"]);
    expect(TOP_ROLE).toBe("admin");
    expect(STAFF_CATALOGUE.keys).toHaveLength(26);
  });

  it("allow what §8.3 says, each one holding the one below it", () => {
    const viewer = staffPermissionsOf(builtIn("viewer"));
    expect([...viewer].sort()).toEqual(
      [
        "audit.read",
        "customers.read",
        "golive.read",
        "money.read",
        "organisations.read",
        "rfis.read",
        "staff.read",
      ].sort(),
    );
    const compliance = staffPermissionsOf(builtIn("compliance"));
    const operator = staffPermissionsOf(builtIn("operator"));
    const admin = staffPermissionsOf(builtIn("admin"));
    for (const key of viewer) expect(compliance.has(key)).toBe(true);
    for (const key of compliance) expect(operator.has(key)).toBe(true);
    expect(operator.has("switches.manage")).toBe(true);
    expect(compliance.has("switches.manage")).toBe(false);
    expect(admin.size).toBe(26);
    for (const key of ["staff.add", "staff.remove", "staff.role", "staff.reset_factors"] as const) {
      expect(admin.has(key)).toBe(true);
      expect(operator.has(key)).toBe(false);
    }
  });

  it("allow nothing for a role Fin does not know or one that is gone", () => {
    expect(staffPermissionsOf("unknown").size).toBe(0);
    expect(staffPermissionsOf("gone").size).toBe(0);
    expect(staffRoleLabel("unknown")).toBe("No access");
  });

  it("never let a custom role hold an Admin-only permission", () => {
    const custom = {
      kind: "custom",
      id: "srl_01jd0000000000000000000000",
      name: "Staff keepers",
      description: "",
      permissions: [
        "staff.read",
        "staff.add",
        "staff.role",
        "staff.reset_factors",
        "staffRoles.manage",
      ],
    } as const;
    expect([...staffPermissionsOf(custom)].sort()).toEqual(["staff.add", "staff.read"]);
  });

  it("know a lowered role: one that loses a permission the old one held", () => {
    expect(lowers(builtIn("admin"), builtIn("viewer"))).toBe(true);
    expect(lowers(builtIn("viewer"), builtIn("compliance"))).toBe(false);
    expect(lowers(builtIn("operator"), builtIn("compliance"))).toBe(true);
    expect(lowers(builtIn("viewer"), "gone")).toBe(true);
  });

  it("name only the catalogue's permissions", () => {
    expect(isStaffPermission("staff.add")).toBe(true);
    expect(isStaffPermission("member.invite")).toBe(false);
    expect(isStaffPermission("toString")).toBe(false);
  });
});
