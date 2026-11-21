// The staff area's events (spec 02 §16.4; spec 08 §3.3, §3.4, §3.10; T-SAT-16's staff half): every
// metadata schema is a strict object of flat fields that refuses a planted address, name, code or
// token; the payload carries the actor, its step-up and the request's address and device, and the
// revocation-journal entry where the event declares one.
import { describe, expect, it } from "vitest";
import type * as z from "zod";
import { RECORDED_EVENTS, STAFF_EVENTS, staffEventTypeRows } from "./events.ts";
import { StaffAuditError, staffAuditPayload } from "./record.ts";

const stf = "stf_01jd0000000000000000000000";
const sti = "sti_01jd0000000000000000000000";
const aud = "aud_01jd0000000000000000000000";

function isFlat(schema: z.ZodObject): boolean {
  const def = schema._zod.def as { catchall?: { _zod: { def: { type: string } } } };
  if (def.catchall?._zod.def.type !== "never") return false;
  return Object.values(schema.shape).every((field) => {
    const type = (field as z.ZodType)._zod.def.type;
    return ["string", "number", "boolean", "enum", "literal", "int"].includes(type);
  });
}

describe("the staff events", () => {
  it("are spec 08 §3.4's staff.ts names, staff scope, recorded by fin_admin or fin_owner", () => {
    expect(Object.keys(STAFF_EVENTS).sort()).toEqual([
      "staff.bootstrapped",
      "staff.factors_reset",
      "staff.member_added",
      "staff.member_removed",
      "staff.role_changed",
      "switch.cleared",
      "switch.set",
    ]);
    for (const [name, spec] of Object.entries(STAFF_EVENTS)) {
      expect(spec.scope, name).toBe("staff");
      for (const role of spec.roles) expect(["fin_admin", "fin_owner"]).toContain(role);
      expect(isFlat(spec.metadata), name).toBe(true);
    }
    expect(STAFF_EVENTS["staff.bootstrapped"].roles).toEqual(["fin_owner"]);
  });

  it("declare the revocation journal's staff kinds (spec 08 §3.10)", () => {
    const rows = Object.fromEntries(staffEventTypeRows().map((r) => [r.name, r.journal_kind]));
    expect(rows).toEqual({
      "staff.bootstrapped": null,
      "staff.factors_reset": "staff_factors_reset",
      "staff.member_added": null,
      "staff.member_removed": "staff_removed",
      "staff.role_changed": "staff_role_lowered",
      "switch.cleared": "switch_cleared",
      "switch.set": "switch_set",
    });
  });

  it("refuse planted personal values and anything the schema does not list", () => {
    const planted = [
      { roleKey: "admin", reactivated: false, email: "someone@example.com" },
      { roleKey: "someone@example.com", reactivated: false },
      { roleKey: "admin", reactivated: "no" },
    ];
    for (const metadata of planted) {
      expect(STAFF_EVENTS["staff.member_added"].metadata.safeParse(metadata).success).toBe(false);
    }
    expect(
      STAFF_EVENTS["switch.set"].metadata.safeParse({ reasonCode: "Typed text here" }).success,
    ).toBe(false);
    expect(
      STAFF_EVENTS["staff.bootstrapped"].metadata.safeParse({
        reset: false,
        reasonCode: "ABCD-EFGH-JKMN-PQRS",
      }).success,
    ).toBe(false);
  });
});

describe("staffAuditPayload", () => {
  const request = {
    requestId: "req_01jd0000000000000000000000",
    clientIp: "2001:db8::1",
    userAgent: "x".repeat(500),
  };

  it("carries the actor, its intent, the request's address and device, and the journal flag", () => {
    const { payload, journal } = staffAuditPayload(
      {
        event: "staff.member_removed",
        actor: { kind: "staff", id: stf, stepUp: { kind: "intent", method: "passkey", ref: sti } },
        target: "stf_01jd0000000000000000000001",
        refs: ["stf_01jd0000000000000000000001", stf],
        metadata: { sessionsEnded: 2, factorsRemoved: 1 },
        request,
      },
      aud,
      "test-release",
      null,
    );
    expect(journal).toBe(true);
    expect(payload).toMatchObject({
      id: aud,
      event: "staff.member_removed",
      actor_kind: "staff",
      actor_id: stf,
      actor_via: "admin",
      step_up_kind: "intent",
      step_up_method: "passkey",
      step_up_ref: sti,
      target_id: "stf_01jd0000000000000000000001",
      ref_ids: [stf],
      request_id: request.requestId,
      release: "test-release",
    });
    const context = payload.context as { client_ip: string; user_agent: string };
    expect(context.client_ip).toBe("2001:db8::1");
    expect(context.user_agent).toHaveLength(400);
  });

  it("writes a role change's journal entry only when the role was lowered", () => {
    const base = {
      event: "staff.role_changed" as const,
      actor: { kind: "staff" as const, id: stf },
      target: stf,
      request,
    };
    const lowered = staffAuditPayload(
      {
        ...base,
        metadata: { fromRole: "admin", toRole: "viewer", reason: "changed", lowered: true },
      },
      aud,
      "r",
      null,
    );
    const raised = staffAuditPayload(
      {
        ...base,
        metadata: { fromRole: "viewer", toRole: "admin", reason: "changed", lowered: false },
      },
      aud,
      "r",
      null,
    );
    expect(lowered.journal).toBe(true);
    expect(raised.journal).toBe(false);
  });

  it("refuses the wrong actor, the wrong target, an unknown event and bad metadata", () => {
    const ok = {
      event: "staff.member_added" as const,
      actor: { kind: "staff" as const, id: stf },
      target: stf,
      metadata: { roleKey: "viewer", reactivated: false },
    };
    expect(() => staffAuditPayload(ok, aud, "r", null)).not.toThrow();
    expect(() =>
      staffAuditPayload(
        { ...ok, event: "staff.bootstrapped", metadata: { reset: false, reasonCode: "x" } },
        aud,
        "r",
        null,
      ),
    ).toThrow(StaffAuditError);
    expect(() =>
      staffAuditPayload({ ...ok, target: "enc_01jd0000000000000000000000" }, aud, "r", null),
    ).toThrow(StaffAuditError);
    expect(() =>
      staffAuditPayload({ ...ok, event: "staff.not_an_event" as never }, aud, "r", null),
    ).toThrow(StaffAuditError);
    expect(() =>
      staffAuditPayload(
        { ...ok, metadata: { roleKey: "viewer", reactivated: false, note: "x" } },
        aud,
        "r",
        null,
      ),
    ).toThrow(StaffAuditError);
    // The operator records through its own via, with no client context.
    const { payload } = staffAuditPayload(
      {
        event: "staff.enrolment_code_issued",
        actor: { kind: "operator", id: "run_1" },
        target: "enc_01jd0000000000000000000000",
        refs: [stf],
        metadata: { reason: "bootstrap" },
        request,
      },
      aud,
      "r",
      null,
    );
    expect(payload.actor_via).toBe("operator");
    expect(payload).not.toHaveProperty("context");
  });

  it("records identity's enrolment-code event under identity's own schema", () => {
    expect(
      RECORDED_EVENTS["staff.enrolment_code_issued"].metadata.safeParse({ reason: "added" })
        .success,
    ).toBe(true);
  });
});
