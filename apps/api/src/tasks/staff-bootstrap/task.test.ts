// staff-bootstrap's parameters and its call (spec 02 §10.6): only an address and a code's hash
// cross into the run, never the code; the database's refusals become the task's own codes.
import { createIdSource, type UnitTx } from "@fin/db";
import { describe, expect, it } from "vitest";
import { TaskError } from "../run.ts";
import { BOOTSTRAP_REFUSALS, staffBootstrap } from "./task.ts";

const hash = "ab".repeat(32);
const context = { runId: "run_bootstrap_1", release: "r", environment: "staging" as const };

function fakeTx(answer: unknown | Error) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const tx = {
    ids: createIdSource({ now: () => Date.now() }),
    async query(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values });
      if (answer instanceof Error) throw answer;
      return { rows: [{ answer }], rowCount: 1, command: "SELECT", fields: [] };
    },
  } as unknown as UnitTx;
  return { tx, calls };
}

describe("staff-bootstrap's parameters", () => {
  it("take an address, the code's SHA-256 and a reason code, and nothing else", () => {
    expect(
      staffBootstrap.params.safeParse({
        address: "first.admin@example.com",
        codeHash: hash,
        reasonCode: "first_admin",
      }).success,
    ).toBe(true);
    for (const bad of [
      { address: "first.admin@example.com", codeHash: hash },
      { address: "first.admin@example.com", codeHash: hash, reasonCode: "First admin" },
      { address: "not-an-address", codeHash: hash, reasonCode: "first_admin" },
      { address: "first.admin@example.com", codeHash: "AB".repeat(32), reasonCode: "first_admin" },
      // The code itself is never a parameter.
      {
        address: "first.admin@example.com",
        codeHash: hash,
        reasonCode: "first_admin",
        code: "ABCD-EFGH-JKMN-PQRS",
      },
    ]) {
      expect(staffBootstrap.params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(
      staffBootstrap.params.parse({
        address: "first.admin@example.com",
        codeHash: hash,
        reasonCode: "first_admin",
      }).reset,
    ).toBe(false);
  });
});

describe("staff-bootstrap's run", () => {
  it("calls staff.bootstrap_admin with the address lower-cased, the hash as bytes and fresh IDs", async () => {
    const { tx, calls } = fakeTx({
      staff_id: "stf_01jd0000000000000000000000",
      enrolment_code_id: "enc_01jd0000000000000000000000",
      reactivated: false,
    });
    const result = await staffBootstrap.run(
      tx,
      staffBootstrap.params.parse({
        address: "First.Admin@Example.com",
        codeHash: hash,
        reasonCode: "first_admin",
      }),
      context,
    );
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.text).toContain("staff.bootstrap_admin(");
    expect(call?.values[0]).toBe("first.admin@example.com");
    expect(Buffer.isBuffer(call?.values[1])).toBe(true);
    expect(Buffer.from(call?.values[1] as Buffer).toString("hex")).toBe(hash);
    expect(call?.values[2]).toBe(false);
    expect(call?.values[4]).toBe(context.runId);
    const ids = JSON.parse(String(call?.values[6])) as Record<string, string>;
    expect(ids.member_id).toMatch(/^stf_/);
    expect(ids.code_id).toMatch(/^enc_/);
    expect(ids.journal_id).toMatch(/^jrn_/);
    expect(new Set([ids.member_event_id, ids.code_event_id, ids.bootstrap_event_id]).size).toBe(3);
    // IDs only, never the address.
    expect(result).toEqual({
      rowsChanged: 2,
      ids: {
        staffId: "stf_01jd0000000000000000000000",
        enrolmentCodeId: "enc_01jd0000000000000000000000",
        reset: 0,
        reactivated: 0,
      },
    });
    expect(JSON.stringify(result)).not.toContain("example.com");
  });

  it("turns the database's refusals into the task's codes", async () => {
    const refused = Object.assign(new Error("refused"), { code: "FB001" });
    const { tx } = fakeTx(refused);
    const run = staffBootstrap.run(
      tx,
      staffBootstrap.params.parse({
        address: "first.admin@example.com",
        codeHash: hash,
        reasonCode: "first_admin",
      }),
      context,
    );
    // migrate's task.failed line names a TaskError's code (and an unknown error only by its name).
    await expect(run).rejects.toBeInstanceOf(TaskError);
    await expect(run).rejects.toMatchObject({ code: "active_admin_exists" });
    for (const [state, code] of Object.entries(BOOTSTRAP_REFUSALS)) {
      await expect(
        staffBootstrap.run(
          fakeTx(Object.assign(new Error("refused"), { code: state })).tx,
          staffBootstrap.params.parse({
            address: "first.admin@example.com",
            codeHash: hash,
            reasonCode: "first_admin",
          }),
          context,
        ),
      ).rejects.toEqual(expect.objectContaining({ name: "TaskError", code }));
    }
    const other = Object.assign(new Error("boom"), { code: "57014" });
    await expect(
      staffBootstrap.run(
        fakeTx(other).tx,
        staffBootstrap.params.parse({
          address: "first.admin@example.com",
          codeHash: hash,
          reasonCode: "first_admin",
        }),
        context,
      ),
    ).rejects.toBe(other);
  });
});
