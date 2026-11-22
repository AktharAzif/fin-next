import { describe, expect, it } from "vitest";
import { consoleViewer } from "./identity/viewer.ts";
import { health } from "./platform/health.ts";
import { problemSchema, stepUpRequiredSchema } from "./problem.ts";
import { staffViewer } from "./staff/viewer.ts";

const maya = {
  gate: "ok",
  user: { id: "usr_maya", name: "Maya Rivera", email: "maya@example.com" },
  assurance: "aal2",
  factors: { passkeys: 1, authenticator: false, backupCodesLeft: null },
  canSkipProtect: false,
  canTrustBrowser: true,
  memberships: [
    {
      orgId: "org_acme",
      name: "Acme Remit",
      roleKey: "super_admin",
      roleLabel: "Super admin",
      roleKnown: true,
      liveStatus: "sandbox",
    },
  ],
  currentOrgId: "org_acme",
  permissions: ["customers.read", "auditLog.read"],
  invitations: [],
};

describe("the console viewer (spec 02 §14.4)", () => {
  it("parses a signed-in viewer", () => {
    const viewer = consoleViewer.output.parse(maya);
    expect(viewer.gate).toBe("ok");
  });

  it("parses the factor step, which names only the email and the methods", () => {
    const viewer = consoleViewer.output.parse({
      gate: "factor_step",
      email: "maya@example.com",
      methods: ["passkey", "authenticator"],
    });
    expect(viewer).toEqual({
      gate: "factor_step",
      email: "maya@example.com",
      methods: ["passkey", "authenticator"],
    });
  });

  it("refuses an unknown gate or a missing field", () => {
    expect(consoleViewer.output.safeParse({ ...maya, gate: "maybe" }).success).toBe(false);
    const { permissions: _dropped, ...withoutPermissions } = maya;
    expect(consoleViewer.output.safeParse(withoutPermissions).success).toBe(false);
  });
});

describe("the staff viewer (spec 02 §14.4)", () => {
  it("parses every state", () => {
    const states = [
      { state: "signed_out", accessEmail: "nadia@example.org" },
      { state: "signed_out", accessEmail: null },
      { state: "signed_out", accessEmail: "nadia@example.org", google: true },
      { state: "pending", email: "nadia@example.org" },
      { state: "factor_step", email: "nadia@example.org", methods: ["passkey"] },
      {
        state: "ok",
        staff: { id: "stf_1", email: "nadia@example.org", roleKey: "admin", roleLabel: "Admin" },
        permissions: ["staff.read"],
        environment: "staging",
      },
    ];
    for (const state of states) expect(staffViewer.output.safeParse(state).success).toBe(true);
  });

  it("refuses an unknown state", () => {
    expect(staffViewer.output.safeParse({ state: "ok" }).success).toBe(false);
    expect(staffViewer.output.safeParse({ state: "elsewhere" }).success).toBe(false);
    const google = { state: "signed_out", accessEmail: null, google: "yes" };
    expect(staffViewer.output.safeParse(google).success).toBe(false);
  });
});

describe("problems", () => {
  it("keeps unknown extensions and reads step_up_required", () => {
    const body = {
      type: "https://docs.example.com/errors/step_up_required",
      title: "Confirm it’s you",
      status: 403,
      code: "step_up_required",
      request_id: "req_1",
      step_up_kind: "intent",
      intent_id: "sti_1",
      methods: ["passkey"],
      reason_key: "team.invite",
      somethingNew: true,
    };
    const problem = problemSchema.parse(body);
    expect(problem.somethingNew).toBe(true);
    expect(stepUpRequiredSchema.parse(body).intent_id).toBe("sti_1");
  });

  it("refuses a body that is not Fin's problem", () => {
    expect(problemSchema.safeParse({ message: "Bad gateway" }).success).toBe(false);
    expect(problemSchema.safeParse({ type: "x", title: "y", status: 200, code: "c" }).success).toBe(
      false,
    );
  });

  it("health answers only ok", () => {
    expect(health.output.safeParse({ status: "ok" }).success).toBe(true);
    expect(health.output.safeParse({ status: "degraded" }).success).toBe(false);
  });
});
