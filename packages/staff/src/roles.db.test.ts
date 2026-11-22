// `GET /api/staff-roles` (spec 02 §10.7): the prebuilt roles, then the custom staff roles by name in
// code-point order (COLLATE "C"), so a person sees the same order on every server. A bare ORDER BY
// would follow the database's collation, and glibc's en_US.utf8 (CI's Postgres image) orders the
// names below otherwise, while a Mac sorts them by bytes and never shows the difference.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaffHarness, type StaffHarness, unique } from "../test/harness.ts";
import { PREBUILT_ROLE_KEYS } from "./catalogue.ts";
import { requireStaff } from "./require-staff.ts";
import { listStaffRoles } from "./roles.ts";

let h: StaffHarness;

beforeAll(async () => {
  h = await createStaffHarness("sat04roles");
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("the staff roles list", () => {
  it("lists the prebuilt roles, then the custom roles by lower-cased name in code-point order", async () => {
    // Lower-cased, these differ first at a space, "(", "-", "_" or a letter, and code point puts
    // them in that order; they are seeded out of it.
    const ordered = ["Risk (EU)", "Risk ops", "Risk-review", "risk_audit", "Riskdesk"];
    const ids = new Map<string, string>();
    for (const name of ["Riskdesk", "Risk-review", "risk_audit", "Risk (EU)", "Risk ops"]) {
      ids.set(name, await h.seedCustomRole(name, ["staff.read"]));
    }
    const viewer = await h.enrolled(unique("roles.viewer"), "viewer");
    const roles = await h.route(
      viewer.browser,
      { method: "GET", path: "/api/staff-roles" },
      async (tx, req, ctx) => {
        await requireStaff(h.realm, req, ctx, { permission: "staff.read" });
        return listStaffRoles(tx);
      },
    );
    expect(roles.filter((r) => r.kind === "custom").map((r) => r.label)).toEqual(ordered);
    expect(roles.map((r) => r.key)).toEqual([
      ...PREBUILT_ROLE_KEYS,
      ...ordered.map((name) => ids.get(name)),
    ]);
  });
});
