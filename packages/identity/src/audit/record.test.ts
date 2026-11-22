// recordAudit's failure line as Better Stack receives it: `audit.write_failed` names the event it
// could not write in `auditEvent`, beside the `sqlstate`, through the process telemetry. A field
// named `event` would share the envelope's name and be dropped, leaving the alert's runbook a
// line that says nothing of which action failed.
import { TEST_RELEASE } from "@fin/server/testing";
import { describe, expect, it } from "vitest";
import { shippedSink } from "../../test/telemetry.ts";
import { ManualClock } from "../ports/clock.ts";
import type { QueryResultLike, UnitTx } from "../ports/db.ts";
import { ID_PREFIXES, newId } from "../ports/ids.ts";
import { type AuditInput, AuditInputError, createRecordAudit } from "./record.ts";

const clock = new ManualClock("2026-11-22T09:00:00Z");

/** A unit of work whose every statement fails with `refusal`, as a refusing database's would. */
function refusingUnit(refusal: Error): UnitTx & { poisons: string[]; statements: string[] } {
  const poisons: string[] = [];
  const statements: string[] = [];
  return {
    unitId: "unit-1",
    clock,
    requestId: null,
    release: "rel-1",
    poisons,
    statements,
    get poisonedBy() {
      return poisons[0] ?? null;
    },
    poison(reason: string) {
      poisons.push(reason);
    },
    async query<R>(text: string): Promise<QueryResultLike<R>> {
      statements.push(text);
      throw refusal;
    },
  };
}

/** A database error as node-postgres raises it: the SQLSTATE in `code`. */
function databaseError(code: string): Error {
  return Object.assign(new Error("refused by audit.record"), { code });
}

function revoked(): AuditInput {
  const userId = newId(ID_PREFIXES.user, clock);
  return {
    event: "session.revoked",
    actor: { kind: "user", id: userId, via: "console" },
    target: newId(ID_PREFIXES.session, clock),
    subjectUserId: userId,
    metadata: {},
  };
}

describe("audit.write_failed through the process telemetry", () => {
  it("ships the failed event as auditEvent, with the database's sqlstate", async () => {
    const sink = shippedSink();
    const record = createRecordAudit({ clock, lines: sink.lines });
    const refusal = databaseError("FA004");
    const tx = refusingUnit(refusal);

    await expect(sink.unit(() => record(tx, revoked()))).rejects.toBe(refusal);
    expect(tx.statements).toEqual(["SELECT audit.record($1::jsonb) AS id"]);
    expect(tx.poisons).toEqual(["audit_write"]);

    const failed = (await sink.shipped()).filter((line) => line.event === "audit.write_failed");
    expect(failed).toEqual([
      {
        dt: "2026-11-21T08:00:00.000Z",
        message: "audit.write_failed",
        event: "audit.write_failed",
        level: "error",
        service: "console",
        environment: "ci",
        release: TEST_RELEASE,
        replica: "test",
        requestId: sink.requestId,
        auditEvent: "session.revoked",
        sqlstate: "FA004",
      },
    ]);
  });

  it("ships the event the payload refused before any SQL, with sqlstate input", async () => {
    const sink = shippedSink();
    const record = createRecordAudit({ clock, lines: sink.lines });
    const tx = refusingUnit(databaseError("FA004"));
    // A person-scope event a staff member cannot record: refused while the payload is built.
    const input: AuditInput = {
      ...revoked(),
      actor: { kind: "staff", id: newId(ID_PREFIXES.staffMember, clock), via: "admin" },
    };

    await expect(sink.unit(() => record(tx, input))).rejects.toBeInstanceOf(AuditInputError);
    expect(tx.statements).toEqual([]);
    expect(tx.poisons).toEqual(["audit_input"]);

    const [failed, ...more] = (await sink.shipped()).filter(
      (line) => line.event === "audit.write_failed",
    );
    expect(more).toEqual([]);
    expect(failed).toMatchObject({
      event: "audit.write_failed",
      level: "error",
      requestId: sink.requestId,
      auditEvent: "session.revoked",
      sqlstate: "input",
    });
  });
});
