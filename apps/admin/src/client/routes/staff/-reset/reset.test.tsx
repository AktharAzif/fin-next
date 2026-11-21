// The factor reset's screen pieces (spec 02 §10.2, §8.5, §8.7, §10.8, §15.5): the contract reads the
// API half's answer and refuses one without the code; the row offers the reset for an active member,
// and for a pending one only while they still list a factor, and mirrors the server's refusals with
// their reasons; a refusal says the right thing and marks the list stale when it is; the row's
// control carries the member's address in its name.
import { ApiError } from "@fin/frame";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StaffMember, StaffRole } from "../../../api/contracts.ts";
import { TRY_AGAIN, UNREACHABLE } from "../../../staff/messages.ts";
import { type Actor, LAST_ADMIN, NO_PERMISSION, OUTRANKED } from "../../../staff/rules.ts";
import { reasonSentence } from "../../../step-up/reasons.ts";
import { resetFactorsAnswer, resetStaffFactors } from "./contract.ts";
import { resetError } from "./messages.ts";
import { RESET_CONFIRM, ResetFactorsButton } from "./ResetFactors.tsx";
import { OWN_RESET, RESET_PERMISSION, resetControl } from "./rules.ts";

const READS = ["customers.read", "audit.read", "staff.read"];
const OPERATOR = [...READS, "customers.decide", "switches.manage"];
const ADMIN = [
  ...OPERATOR,
  "staff.add",
  "staff.remove",
  "staff.role",
  "staff.reset_factors",
  "staffRoles.manage",
];

const ROLES: StaffRole[] = [
  { key: "viewer", label: "Viewer", summary: "Sees.", builtIn: true, permissions: READS },
  { key: "operator", label: "Operator", summary: "Runs.", builtIn: true, permissions: OPERATOR },
  { key: "admin", label: "Admin", summary: "Everything.", builtIn: true, permissions: ADMIN },
];

function member(id: string, roleKey: string, status: "active" | "pending" = "active"): StaffMember {
  return {
    id,
    email: `${id}@example.com`,
    roleKey,
    roleLabel: roleKey,
    status,
    lastSignedInAt: status === "active" ? "2026-11-20T13:40:00.000Z" : null,
    factors: status === "active" ? ["passkey"] : [],
  };
}

const actor = (id: string, roleKey: string, permissions: readonly string[]): Actor => ({
  id,
  roleKey,
  permissions: new Set(permissions),
});
const nadia = actor("nadia", "admin", ADMIN);
const noop = () => {};

function refused(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new ApiError({
    kind: "problem",
    contract: "staff.resetFactors",
    status,
    problem: { type: "x", title: "x", status, code, request_id: "req_9", ...extra },
  });
}

describe("the reset's contract", () => {
  it("posts to the member's reset path under /api, the ID in the path and no body", () => {
    expect(resetStaffFactors).toMatchObject({
      name: "staff.resetFactors",
      method: "POST",
      path: "/staff/:staffId/reset-factors",
    });
    expect(resetStaffFactors.creates).toBeUndefined();
  });

  it("reads the API half's answer, the code once, and refuses one without the code", () => {
    // The exact answer of apps/admin/src/server/routes/handlers.ts's `staff.reset_factors`.
    const answer = {
      staffId: "stf_01jd0000000000000000000000",
      status: "pending",
      enrolmentCode: "ABCD-EFGH-JKMN-PQRS",
      enrolmentCodeId: "enc_01jd0000000000000000000000",
      expiresAt: "2026-11-21T10:30:00.000Z",
    };
    expect(resetFactorsAnswer.safeParse(answer).success).toBe(true);
    const { enrolmentCode: _code, ...without } = answer;
    expect(resetFactorsAnswer.safeParse(without).success).toBe(false);
    expect(resetFactorsAnswer.safeParse({ ...answer, status: "active" }).success).toBe(false);
  });
});

describe("resetControl", () => {
  const owen = member("owen", "operator");
  const nadiaRow = member("nadia", "admin");
  const ines = member("ines", "admin");
  const mei = member("mei", "viewer", "pending");
  const staff = [nadiaRow, owen, ines, mei];

  it("offers an Admin the reset of someone else's factors", () => {
    expect(resetControl(nadia, owen, staff, ROLES)).toBeNull();
    expect(resetControl(nadia, ines, staff, ROLES)).toBeNull();
  });

  it("draws nothing for a pending member, who has no second factor yet", () => {
    expect(resetControl(nadia, mei, staff, ROLES)).toBeUndefined();
  });

  it("offers it for a pending member who still lists a factor, whom a new code cannot help", () => {
    const stuck: StaffMember = { ...member("ana", "viewer", "pending"), factors: ["passkey"] };
    expect(resetControl(nadia, stuck, [...staff, stuck], ROLES)).toBeNull();
    const narrow = actor("x", "custom", [...READS, RESET_PERMISSION]);
    const outranking: StaffMember = { ...stuck, roleKey: "operator" };
    expect(resetControl(narrow, outranking, [...staff, outranking], ROLES)).toBe(OUTRANKED);
    const operator = actor("owen", "operator", OPERATOR);
    expect(resetControl(operator, stuck, [...staff, stuck], ROLES)).toBe(NO_PERMISSION);
  });

  it("refuses one's own row, with the reason, even as the last Admin", () => {
    expect(resetControl(nadia, nadiaRow, staff, ROLES)).toBe(OWN_RESET);
    expect(resetControl(nadia, nadiaRow, [nadiaRow, owen], ROLES)).toBe(OWN_RESET);
  });

  it("disables it for a role without staff.reset_factors, saying why", () => {
    const operator = actor("owen", "operator", OPERATOR);
    expect(operator.permissions.has(RESET_PERMISSION)).toBe(false);
    expect(resetControl(operator, member("v", "viewer"), staff, ROLES)).toBe(NO_PERMISSION);
  });

  it("keeps the last active Admin, as the server does (§10.8)", () => {
    const holder = actor("x", "custom", ADMIN);
    expect(resetControl(holder, nadiaRow, [nadiaRow, owen], ROLES)).toBe(LAST_ADMIN);
  });

  it("refuses a target whose role allows more than the actor's", () => {
    const narrow = actor("x", "custom", [...READS, RESET_PERMISSION]);
    expect(resetControl(narrow, owen, staff, ROLES)).toBe(OUTRANKED);
    expect(resetControl(narrow, member("v", "viewer"), staff, ROLES)).toBeNull();
  });
});

describe("resetError", () => {
  it("says nothing when Confirm it's you was closed, and nothing is stale", () => {
    expect(resetError(refused(403, "step_up_required"))).toEqual({
      message: null,
      requestId: "req_9",
      stale: false,
    });
  });

  it.each([
    [refused(403, "giving_refused", { problem: "self" }), OWN_RESET, false],
    [refused(403, "forbidden", { permission: "staff.reset_factors" }), NO_PERMISSION, false],
    [refused(403, "outranked"), OUTRANKED, true],
    [refused(409, "last_top_role"), LAST_ADMIN, true],
    [refused(403, "step_up_invalid", { reason: "used" }), TRY_AGAIN, false],
    [refused(404, "not_found"), "They’re no longer on staff. The list is up to date now.", true],
    [refused(409, "conflict"), "Someone changed this just now. The list is up to date now.", true],
    [new ApiError({ kind: "network", contract: "staff.resetFactors" }), UNREACHABLE, false],
    [refused(500, "internal"), "Something went wrong on our side. Nothing was changed.", false],
  ] as const)("%s", (error, message, stale) => {
    expect(resetError(error)).toMatchObject({ message, stale });
  });

  it("blames Fin's side for something that is not an answer", () => {
    expect(resetError(new Error("x"))).toEqual({
      message: "Something went wrong on our side. Nothing was changed.",
      requestId: null,
      stale: false,
    });
  });
});

describe("the row's control and the dialog's words", () => {
  it("names the member in the control, and draws nothing for a pending one", () => {
    const html = renderToStaticMarkup(
      <ResetFactorsButton member={member("owen", "operator")} reason={null} onOpen={noop} />,
    );
    expect(html).toContain('aria-label="Reset factors for owen@example.com"');
    expect(html).toContain("Reset factors");
    expect(html).not.toContain('aria-disabled="true"');
    const pending = member("mei", "viewer", "pending");
    expect(
      renderToStaticMarkup(
        <ResetFactorsButton member={pending} reason={undefined} onOpen={noop} />,
      ),
    ).toBe("");
  });

  it("draws a refused control disabled, with its reason", () => {
    const html = renderToStaticMarkup(
      <ResetFactorsButton member={member("owen", "operator")} reason={OWN_RESET} onOpen={noop} />,
    );
    expect(html).toContain('aria-disabled="true"');
  });

  it("asks for the second factor with the member's address, from the page's own state", () => {
    expect(reasonSentence("staff.reset_factors", { email: "mei@example.com" })).toBe(
      "Use your second factor to reset mei@example.com’s second factors.",
    );
    expect(reasonSentence("staff.reset_factors", {})).toBe("Use your second factor to continue.");
  });

  it("says the outcome first, and that the Admin hands the new code over", () => {
    expect(RESET_CONFIRM.startsWith("They’re signed out of Fin Admin at once")).toBe(true);
    expect(RESET_CONFIRM).toContain("new enrolment code to hand them");
  });
});
