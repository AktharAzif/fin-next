// The custom staff role editor's checks without a database (spec 02 §8.4, §8.6, §14.1): a draft is
// refused as the access engine's `validateRole` refuses it, with the identity package's full name
// rules, and as taken when the database's name index holds its name; `beyond` is a giving refusal
// and every other problem names its field and code, never the value; the name index's own refusal
// reads as the editor's; the edit allowance is §8.4's.
import { type StaffPermission, staffCatalogue } from "@fin/access";
import { describe, expect, it } from "vitest";
import {
  checkStaffRoleDraft,
  cleanRoleText,
  nameTakenRefusal,
  STAFF_ROLE_EDIT_BUCKET,
  STAFF_ROLE_EDIT_WINDOWS,
} from "./custom-roles.ts";
import { StaffRefusal } from "./errors.ts";

const ADMIN = new Set<StaffPermission>(staffCatalogue.keys);
const VIEWER = new Set<StaffPermission>([
  "golive.read",
  "customers.read",
  "rfis.read",
  "organisations.read",
  "money.read",
  "audit.read",
  "staff.read",
]);

function refusal(run: () => void): { code: string; extensions: unknown; status: number } | null {
  try {
    run();
    return null;
  } catch (error) {
    if (!(error instanceof StaffRefusal)) throw error;
    return { code: error.code, extensions: error.extensions, status: error.status };
  }
}

describe("cleanRoleText", () => {
  it("stores what the name rule accepts in its checked form, and leaves the rest to be refused", () => {
    expect(cleanRoleText("roleName", "  Case   handlers ")).toBe("Case handlers");
    expect(cleanRoleText("roleDescription", "")).toBe("");
    expect(cleanRoleText("roleName", "visit example.com")).toBe("visit example.com");
  });
});

describe("checkStaffRoleDraft", () => {
  const draft = (name: string, permissions: string[], description = "") => ({
    name,
    description,
    permissions,
  });

  it("passes a draft within the editor's role", () => {
    expect(
      refusal(() => checkStaffRoleDraft(ADMIN, draft("Support", ["customers.read"]), [])),
    ).toBe(null);
  });

  it("refuses beyond the editor's role (or a key Fin does not know) as giving_refused", () => {
    expect(
      refusal(() =>
        checkStaffRoleDraft(VIEWER, draft("Deciders", ["customers.read", "customers.decide"]), []),
      ),
    ).toEqual({ code: "giving_refused", extensions: { problem: "beyond" }, status: 403 });
    expect(
      refusal(() => checkStaffRoleDraft(ADMIN, draft("Odd", ["customers.read", "root.all"]), [])),
    ).toMatchObject({ code: "giving_refused" });
  });

  it("names each other problem's field and code, never the value", () => {
    const cases: [ReturnType<typeof draft>, string[], { path: string; code: string }[]][] = [
      [draft("Operators", ["customers.read"]), [], [{ path: "name", code: "reads_as_built_in" }]],
      [draft("Support", ["customers.read"]), ["support"], [{ path: "name", code: "name_taken" }]],
      [draft(`Call ${"55".repeat(5)}`, ["customers.read"]), [], [{ path: "name", code: "name" }]],
      [draft("Empty", []), [], [{ path: "permissions", code: "empty" }]],
      [
        draft("Resetters", ["staff.read", "staff.reset_factors"]),
        [],
        [{ path: "permissions", code: "restricted" }],
      ],
      [draft("Deciders", ["golive.decide"]), [], [{ path: "permissions", code: "missing_need" }]],
      [
        draft("Long", ["customers.read"], "word ".repeat(30).trim()),
        [],
        [{ path: "description", code: "description" }],
      ],
    ];
    for (const [input, taken, fields] of cases) {
      const refused = refusal(() => checkStaffRoleDraft(ADMIN, input, taken));
      expect(refused, input.name).toEqual({ code: "invalid", extensions: { fields }, status: 400 });
      expect(JSON.stringify(refused)).not.toContain(input.name);
    }
  });

  it("refuses a name the database's index holds as taken, in the engine's order, once", () => {
    const store = { takenInStore: true };
    expect(
      refusal(() => checkStaffRoleDraft(ADMIN, draft("İnfo desk", ["customers.read"]), [])),
    ).toBe(null);
    expect(
      refusal(() => checkStaffRoleDraft(ADMIN, draft("İnfo desk", ["customers.read"]), [], store)),
    ).toEqual({
      code: "invalid",
      extensions: { fields: [{ path: "name", code: "name_taken" }] },
      status: 400,
    });
    // After a name the rules refuse, before one that reads as a built-in; never twice.
    expect(
      refusal(() =>
        checkStaffRoleDraft(ADMIN, draft(`Call ${"55".repeat(5)}`, []), ["Other"], store),
      ),
    ).toMatchObject({
      extensions: {
        fields: [
          { path: "name", code: "name" },
          { path: "name", code: "name_taken" },
          { path: "permissions", code: "empty" },
        ],
      },
    });
    expect(
      refusal(() => checkStaffRoleDraft(ADMIN, draft("Operators", ["customers.read"]), [], store)),
    ).toMatchObject({
      extensions: {
        fields: [
          { path: "name", code: "name_taken" },
          { path: "name", code: "reads_as_built_in" },
        ],
      },
    });
    expect(
      refusal(() =>
        checkStaffRoleDraft(ADMIN, draft("Support", ["customers.read"]), ["support"], store),
      ),
    ).toMatchObject({ extensions: { fields: [{ path: "name", code: "name_taken" }] } });
    // Beyond the editor's role is still the giving refusal.
    expect(
      refusal(() =>
        checkStaffRoleDraft(VIEWER, draft("Deciders", ["customers.decide"]), [], store),
      ),
    ).toMatchObject({ code: "giving_refused" });
  });
});

describe("nameTakenRefusal", () => {
  it("reads the name index's unique violation as name_taken, and nothing else", () => {
    expect(nameTakenRefusal({ code: "23505", constraint: "staff_role_name" })).toMatchObject({
      code: "invalid",
      status: 400,
      lineReason: "staff_role.name_taken",
      extensions: { fields: [{ path: "name", code: "name_taken" }] },
    });
    for (const other of [
      { code: "23505", constraint: "staff_role_pkey" },
      { code: "23514", constraint: "staff_role_name" },
      { code: "23505" },
      new Error("23505"),
      null,
      undefined,
    ]) {
      expect(nameTakenRefusal(other), JSON.stringify(other)).toBe(null);
    }
  });
});

describe("the edit allowance", () => {
  it("is 30 an hour and 100 a day per person (§8.4)", () => {
    expect(STAFF_ROLE_EDIT_BUCKET).toBe("staff_role_edit");
    expect(STAFF_ROLE_EDIT_WINDOWS).toEqual([
      { ms: 3_600_000, max: 30 },
      { ms: 86_400_000, max: 100 },
    ]);
  });
});
