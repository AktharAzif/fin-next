// Deleting a custom role (spec 02 §8.4): the request names the holders the dialog counted, and a
// refusal that shows the list is out of date has the page read it again before the dialog says so.
import { ApiError } from "@fin/frame";
import { describe, expect, it } from "vitest";
import { deleteRole, type RoleRow } from "../api/contracts/roles.ts";
import {
  deletionInput,
  deletionRefusal,
  GONE,
  HOLDERS_CHANGED,
  MOVE_GONE,
  MOVE_NEEDED,
  TRY_AGAIN,
} from "./role-deletion.ts";

const row = (over: Partial<RoleRow>): RoleRow => ({
  roleKey: "rol_01jd0000000000000000000000",
  roleId: "rol_01jd0000000000000000000000",
  label: "Developer",
  builtIn: false,
  permissionCount: 1,
  holders: 0,
  ...over,
});

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError({
    kind: "problem",
    contract: "roles.delete",
    status,
    problem: { type: "x", title: "x", status, code, request_id: "req_9", ...extra },
  });

describe("a role's deletion", () => {
  it("names the holders the dialog counted, and where they move when anyone does", () => {
    const held = row({
      holders: 2,
      holderIds: ["mem_01jd0000000000000000000001", "mem_01jd0000000000000000000002"],
    });
    expect(deletionInput(held, "admin")).toEqual({
      roleId: held.roleId,
      holders: held.holderIds,
      moveTo: "admin",
    });
    expect(deletionInput(row({}), null)).toEqual({ roleId: row({}).roleId, holders: [] });
    // A list that does not say who holds the role names nobody: the server answers a conflict.
    expect(deletionInput(row({ holders: 1 }), "admin").holders).toEqual([]);
    expect(deleteRole.input.safeParse(deletionInput(held, "admin")).success).toBe(true);
    expect(deleteRole.input.safeParse({ roleId: held.roleId, moveTo: "admin" }).success).toBe(
      false,
    );
  });

  it("reads the list again when it is out of date, and leaves a role that is gone", () => {
    const said = (error: unknown) => {
      const refused = deletionRefusal(error);
      return [refused.stale, refused.sentence];
    };
    expect(said(problem(409, "conflict"))).toEqual(["list", HOLDERS_CHANGED]);
    expect(said(problem(403, "giving_refused", { problem: "move_required" }))).toEqual([
      "list",
      MOVE_NEEDED,
    ]);
    for (const gone of ["gone", "unknown_role"]) {
      expect(said(problem(403, "giving_refused", { problem: gone }))).toEqual(["list", MOVE_GONE]);
    }
    expect(said(problem(404, "not_found"))).toEqual(["gone", GONE]);
    for (const [status, code, extra] of [
      [403, "outranked", {}],
      [403, "giving_refused", { problem: "beyond" }],
      [403, "forbidden", { permission: "member.role" }],
      [429, "rate_limited", {}],
      [500, "internal", {}],
    ] as const) {
      expect(said(problem(status, code, extra)), code).toEqual([null, TRY_AGAIN]);
    }
    expect(said(new Error("x"))).toEqual([null, TRY_AGAIN]);
  });
});
