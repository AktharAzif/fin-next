// AdminRoles and AdminRoleEditor without a browser (spec 02 §8.3, §8.4, §8.7, §10.7, §15.5): the
// contracts read what the server answers, the loaders fail to the page's own state, the editor
// model ticks needs and locks what the member of staff cannot give, the refusals say the right
// thing, the step-up line names the role, and the skeletons draw shapes, never a spinner.
import type { StaffViewer } from "@fin/app-contracts";
import { ApiError } from "@fin/frame";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { STAFF_DESCRIPTION } from "../staff/StaffPage.tsx";
import { reasonSentence } from "../step-up/reasons.ts";
import {
  createStaffRole,
  deleteStaffRole,
  type StaffRoleRow,
  saveStaffRole,
  staffRoleDetail,
  staffRolesIndex,
} from "./contracts.ts";
import {
  ADMIN_ONLY,
  countLine,
  draftProblems,
  duplicateHref,
  givableCopy,
  groupShort,
  groupState,
  holdersText,
  lockReason,
  NOT_YOURS,
  type Permission,
  permissionsText,
  problemSentence,
  roleHref,
  STAFF_PAGE_DESCRIPTION,
  toggle,
  toggleGroup,
  toPermissions,
  whySaveIsOff,
} from "./editor.ts";
import { loadRoleEditor, loadRoles } from "./load.ts";
import { BEYOND_YOURS, CONFLICT, LIMIT, MOVE_NEEDED, roleActionError } from "./messages.ts";
import { RoleEditorSkeleton } from "./RoleEditorPage.tsx";
import { moveChoices, RolesSkeleton } from "./RolesPage.tsx";

const ALL: Permission[] = [
  "golive.read",
  "golive.decide",
  "customers.read",
  "customers.reveal",
  "documents.view",
  "customers.decide",
  "rfis.read",
  "rfis.manage",
  "organisations.read",
  "organisations.pause",
  "organisations.approvals",
  "accounts.recover",
  "money.read",
  "money.operate",
  "switches.manage",
  "audit.read",
  "forms.manage",
  "reasons.manage",
  "templates.manage",
  "views.manage",
  "staff.read",
  "staff.add",
  "staff.remove",
  "staff.role",
  "staff.reset_factors",
  "staffRoles.manage",
];
const ADMIN = toPermissions(ALL);
const VIEWER = toPermissions([
  "golive.read",
  "customers.read",
  "rfis.read",
  "organisations.read",
  "money.read",
  "audit.read",
  "staff.read",
]);

const row = (over: Partial<StaffRoleRow> & { key: string }): StaffRoleRow => ({
  kind: "custom",
  builtIn: false,
  label: over.key,
  description: "",
  summary: "",
  topRole: false,
  holders: 0,
  permissions: [],
  permissionCount: 0,
  version: 1,
  ...over,
});

const ADMIN_VIEWER: StaffViewer = {
  state: "ok",
  staff: { id: "stf_1", email: "nadia@example.com", roleKey: "admin", roleLabel: "Admin" },
  permissions: [...ALL],
  environment: "staging",
};

const viewerStore = (viewer: StaffViewer | null) => ({ get: () => viewer }) as never;

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError({
    kind: "problem",
    contract: "staffRoles.save",
    status,
    problem: { type: "x", title: "x", status, code, request_id: "req_9", ...extra },
  });

describe("the contracts", () => {
  it("name the staff roles routes under /api, and making one carries an idempotency key", () => {
    expect(staffRolesIndex).toMatchObject({ method: "GET", path: "/staff-roles" });
    expect(staffRoleDetail).toMatchObject({ method: "GET", path: "/staff-roles/:roleKey" });
    expect(createStaffRole).toMatchObject({ method: "POST", path: "/staff-roles", creates: true });
    expect(saveStaffRole).toMatchObject({ method: "PUT", path: "/staff-roles/:roleId" });
    expect(deleteStaffRole).toMatchObject({ method: "POST", path: "/staff-roles/:roleId/delete" });
  });

  it("read the list as @fin/staff answers it, and refuse a row without its version", () => {
    const answer = {
      roles: [
        {
          key: "admin",
          kind: "prebuilt",
          builtIn: true,
          label: "Admin",
          description: "",
          summary: "Does everything.",
          topRole: true,
          holders: 1,
          permissions: ALL,
          permissionCount: 26,
          version: null,
        },
        {
          key: "srl_01jd0000000000000000000000",
          kind: "custom",
          builtIn: false,
          label: "Support desk",
          description: "Answers questions.",
          summary: "Answers questions.",
          topRole: false,
          holders: 0,
          permissions: ["customers.read"],
          permissionCount: 1,
          version: 3,
        },
      ],
    };
    expect(staffRolesIndex.output.safeParse(answer).success).toBe(true);
    const { version: _v, ...noVersion } = answer.roles[1] as Record<string, unknown>;
    expect(staffRolesIndex.output.safeParse({ roles: [noVersion] }).success).toBe(false);
    // The detail's groups are the server's; the editor reads the row's own fields.
    expect(staffRoleDetail.output.safeParse({ ...answer.roles[1], groups: [] }).success).toBe(true);
  });
});

describe("the loaders", () => {
  it("read nothing without staff.read", async () => {
    const api = vi.fn();
    const viewer = viewerStore({ ...ADMIN_VIEWER, permissions: ["audit.read"] });
    expect(await loadRoles({ api, viewer })).toEqual({ kind: "notAllowed" });
    expect(await loadRoleEditor({ api, viewer }, "viewer", undefined)).toEqual({
      kind: "notAllowed",
    });
    expect(api).not.toHaveBeenCalled();
  });

  it("fail to the page's own state, with the request ID", async () => {
    const api = vi.fn(async () => {
      throw problem(500, "internal");
    });
    expect(await loadRoles({ api: api as never, viewer: viewerStore(ADMIN_VIEWER) })).toEqual({
      kind: "failed",
      requestId: "req_9",
      offline: false,
    });
  });

  it("say a role is not found, without asking for a key that cannot name one", async () => {
    const api = vi.fn(async (contract: { name: string }) => {
      if (contract.name === "staffRoles.get") throw problem(404, "not_found");
      return { roles: [] };
    });
    const fin = { api: api as never, viewer: viewerStore(ADMIN_VIEWER) };
    expect(await loadRoleEditor(fin, "superuser", undefined)).toEqual({ kind: "notFound" });
    expect(api).not.toHaveBeenCalled();
    expect(await loadRoleEditor(fin, "srl_01jd0000000000000000000000", undefined)).toEqual({
      kind: "notFound",
    });
    // A duplicate of a role that has gone starts blank.
    expect(await loadRoleEditor(fin, "new", "srl_01jd0000000000000000000000")).toEqual({
      kind: "ready",
      role: null,
      roles: [],
    });
  });
});

describe("the editor model", () => {
  it("locks Admin-only permissions for everyone, and what the member of staff lacks", () => {
    expect(lockReason("staffRoles.manage", ADMIN)).toBe(ADMIN_ONLY);
    expect(lockReason("accounts.recover", ADMIN)).toBe(ADMIN_ONLY);
    expect(lockReason("customers.decide", VIEWER)).toBe(NOT_YOURS);
    expect(lockReason("customers.read", VIEWER)).toBeNull();
  });

  it("ticks what a permission needs and unticks what depends on one", () => {
    const ticked = toggle(new Set(), "rfis.manage", true);
    expect([...ticked].sort()).toEqual(["customers.read", "rfis.manage", "rfis.read"]);
    const unticked = toggle(ticked, "customers.read", false);
    expect([...unticked]).toEqual([]);
    const group = toggleGroup(
      new Set(),
      ["staff.read", "staff.add", "staffRoles.manage"],
      true,
      (k) => lockReason(k, ADMIN) === null,
    );
    expect([...group].sort()).toEqual(["staff.add", "staff.read"]);
    expect(groupState(group, ["staff.read", "staff.add", "staff.remove"])).toBe("some");
    expect(groupShort("some", 2, 3)).toBe("2 of 3");
  });

  it("copies a prebuilt role as far as the member of staff may give it", () => {
    const copy = givableCopy(ALL, ADMIN);
    expect(copy.has("staffRoles.manage")).toBe(false);
    expect(copy.has("staff.role")).toBe(false);
    expect(copy.has("staff.add")).toBe(true);
    expect(givableCopy(["customers.decide", "customers.read"], VIEWER)).toEqual(
      new Set(["customers.read"]),
    );
  });

  it("refuses with the engine's problems, and says why Save is off", () => {
    expect(
      draftProblems({ name: "Admins", description: "", permissions: new Set() }, ADMIN),
    ).toEqual(["reads_as_built_in", "empty"]);
    expect(
      draftProblems(
        { name: "Support", description: "", permissions: new Set(["customers.read"]) },
        ADMIN,
        ["support"],
      ),
    ).toEqual(["name_taken"]);
    expect(whySaveIsOff(["empty"], "")).toBe("Name the role and tick at least one permission.");
    expect(whySaveIsOff(["restricted"], "x")).toBe("Untick the permissions you can’t give first.");
    expect(whySaveIsOff(["name_taken"], "x")).toBeNull();
    expect(problemSentence("reads_as_built_in")).toBe(
      "That reads like a prebuilt role’s name. Choose another.",
    );
    expect(problemSentence("missing_need")).toBeNull();
  });

  it("words counts and links", () => {
    expect(countLine("", 0)).toBe("This role can’t do anything yet.");
    expect(countLine("Support desk", 1)).toBe("Support desk can do 1 thing.");
    expect(holdersText(0)).toBe("Nobody");
    expect(holdersText(3)).toBe("3 people");
    expect(permissionsText(1)).toBe("1 permission");
    expect(roleHref("srl_01jd0000000000000000000000")).toBe(
      "/staff/roles/srl_01jd0000000000000000000000",
    );
    expect(duplicateHref("admin")).toBe("/staff/roles/new?from=admin");
    expect(STAFF_PAGE_DESCRIPTION).toBe(STAFF_DESCRIPTION);
  });
});

describe("deleting a role", () => {
  it("offers every other role to move to, refusing the top role and beyond as the server would", () => {
    const deleted = row({ key: "srl_01jd0000000000000000000000", holders: 2 });
    const roles = [
      row({ key: "viewer", builtIn: true, permissions: [...VIEWER] }),
      row({ key: "admin", builtIn: true, topRole: true, permissions: ALL }),
      deleted,
    ];
    const operator = {
      id: "stf_2",
      roleKey: "operator",
      permissions: new Set<string>([...VIEWER, "switches.manage"]),
    };
    const choices = moveChoices(deleted, roles, operator);
    expect(choices.map((c) => c.role.key)).toEqual(["viewer", "admin"]);
    expect(choices.map((c) => c.disabledReason)).toEqual([
      null,
      "Only an Admin can give the Admin role.",
    ]);
  });
});

describe("what a refused change says", () => {
  it("names the conflict, the limit, the move and a role beyond the actor's", () => {
    expect(roleActionError(problem(409, "conflict")).message).toBe(CONFLICT);
    expect(roleActionError(problem(409, "limit_reached", { limit: 30 })).message).toBe(LIMIT);
    expect(
      roleActionError(problem(403, "giving_refused", { problem: "move_required" })).message,
    ).toBe(MOVE_NEEDED);
    expect(roleActionError(problem(403, "giving_refused", { problem: "beyond" })).message).toBe(
      BEYOND_YOURS,
    );
    expect(roleActionError(problem(403, "step_up_required")).message).toBeNull();
  });

  it("puts a field's problem beside the field, never the value", () => {
    const refused = roleActionError(
      problem(400, "invalid", { fields: [{ path: "name", code: "name_taken" }] }),
    );
    expect(refused).toEqual({
      message: null,
      fields: { name: "Another role already has that name." },
      requestId: "req_9",
    });
    expect(
      roleActionError(problem(400, "invalid", { fields: [{ path: "permissions", code: "empty" }] }))
        .message,
    ).toBe("Check what you entered and try again.");
    expect(
      roleActionError(new ApiError({ kind: "network", contract: "staffRoles.create" })).message,
    ).toBe("Couldn’t reach Fin. Check your connection and try again.");
  });
});

describe("the step-up line (§15.5)", () => {
  it("names the staff role the page is changing", () => {
    expect(reasonSentence("staff_role.create", { role: "Support desk" })).toBe(
      "Use your second factor to create the staff role Support desk.",
    );
    expect(reasonSentence("staff_role.update", { role: "Support desk" })).toBe(
      "Use your second factor to save the staff role Support desk.",
    );
    expect(reasonSentence("staff_role.delete", { role: "Support desk" })).toBe(
      "Use your second factor to delete the staff role Support desk.",
    );
    expect(reasonSentence("staff_role.delete", {})).toBe("Use your second factor to continue.");
  });
});

describe("the skeletons", () => {
  it("draw AdminRoles and AdminRoleEditor with shapes and a header, never a spinner", () => {
    const roles = renderToStaticMarkup(<RolesSkeleton />);
    expect(roles).toContain(">Staff</h1>");
    expect(roles).toContain("data-skeleton");
    expect(roles).not.toContain("fin-ico-spin");
    const editor = renderToStaticMarkup(<RoleEditorSkeleton />);
    expect(editor).toContain(">Role</h1>");
    expect(editor).toContain("data-skeleton");
    expect(editor).not.toContain("fin-ico-spin");
  });
});
