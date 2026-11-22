// `audit.write_failed` as it ships (spec 08 §3.14's `audit-not-written` alert): recordOrgAudit's
// failure lines go through the console's own sink and the process's real Telemetry, as main()
// wires them, and the shipped line names the audit event as `auditEvent` beside its `sqlstate`.
// Telemetry drops every field that collides with an envelope key, so a field named `event` would
// leave the line with the `sqlstate` alone and the alert unable to say which event failed.
import { newId } from "@fin/core";
import type { UnitTx } from "@fin/identity";
import { createRecordOrgAudit, type OrgAuditInput, type OrgsEventName } from "@fin/orgs";
import { type Captured, capture, type Line, TEST_RELEASE, TEST_START } from "@fin/server/testing";
import { describe, expect, it } from "vitest";
import { dateClock, lineSink } from "./main.ts";

const REQUEST_ID = "req_0000000000000000000000000a";

/** A database refusal as node-postgres throws it: an Error carrying the SQLSTATE as `code`. */
function refusal(code: string): Error {
  return Object.assign(new Error("refused"), { code });
}

/** A unit of work whose queries answer, or throw on the statement `failOn` names. */
function fakeTx(
  captured: Captured,
  failOn?: { text: string; error: Error },
): UnitTx & { queries: string[]; poisons: string[] } {
  const queries: string[] = [];
  const poisons: string[] = [];
  return {
    unitId: "unit-1",
    clock: dateClock(captured.clock),
    requestId: REQUEST_ID,
    release: TEST_RELEASE,
    queries,
    poisons,
    get poisonedBy() {
      return poisons[0] ?? null;
    },
    poison(reason: string) {
      poisons.push(reason);
    },
    async query<R extends object>(text: string) {
      queries.push(text);
      if (failOn !== undefined && text.includes(failOn.text)) throw failOn.error;
      return { rows: [] as R[], rowCount: 1 };
    },
  };
}

/**
 * Runs one recordOrgAudit call in a unit of work of the captured telemetry, expecting it to throw,
 * and answers the lines Better Stack received once the unit's batch went.
 */
async function shippedFailure<E extends OrgsEventName>(
  captured: Captured,
  tx: UnitTx,
  input: OrgAuditInput<E>,
): Promise<{ shipped: Line[]; stdout: Line[] }> {
  const record = createRecordOrgAudit({
    clock: dateClock(captured.clock),
    lines: lineSink(captured.telemetry),
  });
  await captured.telemetry.withUnit({ requestId: REQUEST_ID }, async () => {
    await expect(record(tx, input)).rejects.toBeInstanceOf(Error);
  });
  await captured.telemetry.flush(5_000);
  const named = (lines: Line[]) => lines.filter((line) => line.event === "audit.write_failed");
  return { shipped: named(captured.shipped.flat()), stdout: named(captured.stdout) };
}

function ids(captured: Captured) {
  const clock = captured.clock;
  return {
    organizationId: newId("org", clock),
    memberId: newId("mem", clock),
    actorId: newId("usr", clock),
  };
}

/** The shipped line: the envelope's own `event`, and the audit event and SQLSTATE as fields. */
function expectNamed(lines: Line[], auditEvent: OrgsEventName, sqlstate: string): void {
  expect(lines).toHaveLength(1);
  expect(lines[0]).toEqual({
    dt: new Date(TEST_START).toISOString(),
    message: "audit.write_failed",
    event: "audit.write_failed",
    level: "error",
    service: "console",
    environment: "ci",
    release: TEST_RELEASE,
    replica: "test",
    requestId: REQUEST_ID,
    auditEvent,
    sqlstate,
  });
}

describe("recordOrgAudit's audit.write_failed, through the real telemetry", () => {
  it("names the event of an input refused before any SQL, with sqlstate input", async () => {
    const captured = capture({ ship: true });
    const tx = fakeTx(captured);
    const { organizationId, memberId, actorId } = ids(captured);
    const { shipped, stdout } = await shippedFailure(captured, tx, {
      event: "member.joined",
      actor: { kind: "user", id: actorId, via: "console" },
      target: memberId,
      organizationId,
      // A role key the event's strict schema refuses: nothing reaches the database.
      metadata: { roleKey: "planted@example.com" } as never,
    });
    expect(tx.queries).toEqual([]);
    expect(tx.poisons).toEqual(["audit_input"]);
    expectNamed(shipped, "member.joined", "input");
    expectNamed(stdout, "member.joined", "input");
  });

  it("names the event audit.record() refused, with the database's SQLSTATE", async () => {
    const captured = capture({ ship: true });
    const tx = fakeTx(captured, { text: "audit.record(", error: refusal("FA002") });
    const { organizationId, memberId, actorId } = ids(captured);
    const { shipped, stdout } = await shippedFailure(captured, tx, {
      event: "member.joined",
      actor: { kind: "user", id: actorId, via: "console" },
      target: memberId,
      organizationId,
      metadata: { roleKey: "developer" },
    });
    expect(tx.poisons).toEqual(["audit_write"]);
    expectNamed(shipped, "member.joined", "FA002");
    expectNamed(stdout, "member.joined", "FA002");
  });

  it("names the event of a refusal that carries no SQLSTATE, with sqlstate unknown", async () => {
    const captured = capture({ ship: true });
    const tx = fakeTx(captured, { text: "audit.record(", error: new Error("connection lost") });
    const { organizationId, memberId, actorId } = ids(captured);
    const { shipped } = await shippedFailure(captured, tx, {
      event: "member.joined",
      actor: { kind: "user", id: actorId, via: "console" },
      target: memberId,
      organizationId,
      metadata: { roleKey: "developer" },
    });
    expectNamed(shipped, "member.joined", "unknown");
  });

  it("names the event whose journal entry audit.record_journal() refused", async () => {
    const captured = capture({ ship: true });
    const tx = fakeTx(captured, { text: "audit.record_journal(", error: refusal("FA007") });
    const { organizationId, memberId, actorId } = ids(captured);
    const { shipped, stdout } = await shippedFailure(captured, tx, {
      event: "member.removed",
      actor: { kind: "user", id: actorId, via: "console" },
      target: memberId,
      organizationId,
      metadata: { credentialsListed: 0, credentialsRolled: 0 },
    });
    // The event was written; its journal entry was not, so the unit rolls back with both.
    expect(tx.queries).toEqual([
      "SELECT audit.record($1::jsonb) AS id",
      "SELECT audit.record_journal($1::jsonb)",
    ]);
    expect(tx.poisons).toEqual(["audit_journal"]);
    expectNamed(shipped, "member.removed", "FA007");
    expectNamed(stdout, "member.removed", "FA007");
  });
});
