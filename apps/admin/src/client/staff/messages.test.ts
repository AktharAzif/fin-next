// What each refusal of a staff change says (spec 02 §14.1, §8.5, §10.8).
import { ApiError } from "@fin/frame";
import { describe, expect, it } from "vitest";
import { staffActionError, TRY_AGAIN, UNREACHABLE } from "./messages.ts";
import { BEYOND, LAST_ADMIN, NO_PERMISSION, OUTRANKED, TOP_ONLY } from "./rules.ts";

function refused(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  retry?: number,
) {
  return new ApiError({
    kind: "problem",
    contract: "staff.add",
    status,
    problem: { type: "x", title: "x", status, code, request_id: "req_7", ...extra },
    ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
  });
}

describe("staffActionError", () => {
  it("says nothing when the person closed Confirm it's you", () => {
    expect(staffActionError(refused(403, "step_up_required"))).toEqual({
      message: null,
      requestId: "req_7",
    });
  });

  it.each([
    [refused(403, "step_up_invalid"), TRY_AGAIN],
    [refused(403, "forbidden", { permission: "staff.add" }), NO_PERMISSION],
    [refused(403, "outranked"), OUTRANKED],
    [refused(403, "giving_refused", { problem: "top_only" }), TOP_ONLY],
    [refused(403, "giving_refused", { problem: "beyond" }), BEYOND],
    [
      refused(403, "giving_refused", { problem: "self" }),
      "You can’t change your own role or remove yourself.",
    ],
    [refused(403, "giving_refused", { problem: "unchanged" }), "They already have that role."],
    [refused(409, "last_top_role"), LAST_ADMIN],
    [
      refused(429, "rate_limited", {}, 12),
      "Too many changes in a short time. Try again in 12 seconds.",
    ],
    [new ApiError({ kind: "network", contract: "staff.add" }), UNREACHABLE],
    [
      new ApiError({ kind: "unexpected_response", contract: "staff.add", status: 502 }),
      UNREACHABLE,
    ],
  ] as const)("%s", (error, message) => {
    expect(staffActionError(error).message).toBe(message);
  });

  it("says the role doesn't allow it when the server refuses the permission", () => {
    expect(staffActionError(refused(403, "forbidden", { permission: "staff.add" }))).toEqual({
      message: "Your role doesn’t allow this. Ask someone who can change roles.",
      requestId: "req_7",
    });
  });

  it("puts an address already on staff on the email field", () => {
    expect(staffActionError(refused(409, "already_staff"), "mei@example.com")).toEqual({
      message: null,
      emailError: "mei@example.com is already on staff.",
      requestId: "req_7",
    });
  });

  it("puts a refused address on the email field, by the field's path only", () => {
    const error = refused(400, "invalid", { fields: [{ path: "email", code: "too_long" }] });
    expect(staffActionError(error).emailError).toBe("Enter a work email address.");
    expect(staffActionError(refused(400, "invalid", { fields: [] })).message).toBe(
      "Check what you entered and try again.",
    );
  });

  it("blames Fin's side for anything else, with the request ID", () => {
    expect(staffActionError(refused(500, "internal"))).toEqual({
      message: "Something went wrong on our side. Nothing was changed.",
      requestId: "req_7",
    });
    expect(staffActionError(new Error("x")).message).toBe(
      "Something went wrong on our side. Nothing was changed.",
    );
  });

  it("says when the page is out of date, so it reads the list again before it shows the sentence", () => {
    expect(staffActionError(refused(404, "not_found"))).toEqual({
      message: "They’re no longer on staff. The list is up to date now.",
      requestId: "req_7",
      stale: true,
    });
    for (const code of ["conflict", "already_done"]) {
      expect(staffActionError(refused(409, code)), code).toEqual({
        message: "Someone changed this just now. The list is up to date now.",
        requestId: "req_7",
        stale: true,
      });
    }
    // A custom role deleted meanwhile: the roles are read again, so the picker leaves it out.
    for (const problem of ["gone", "unknown_role"]) {
      expect(staffActionError(refused(403, "giving_refused", { problem })), problem).toEqual({
        message: "That role no longer exists. Choose another.",
        requestId: "req_7",
        stale: true,
      });
    }
    for (const error of [
      refused(403, "giving_refused", { problem: "beyond" }),
      refused(403, "outranked"),
      refused(409, "last_top_role"),
      refused(429, "rate_limited", {}, 12),
    ]) {
      expect(staffActionError(error).stale, error.code ?? "").toBeUndefined();
    }
  });
});
