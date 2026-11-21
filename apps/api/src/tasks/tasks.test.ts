import { createIdSource, type UnitTx } from "@fin/db";
import { describe, expect, it } from "vitest";
import { auditNote } from "./audit-note.ts";
import { TASKS } from "./registry.ts";
import { parseTaskParams, TaskError } from "./run.ts";
import { StartEpochRefused, startEpoch } from "./start-epoch.ts";

function fakeTx(): { tx: UnitTx; queries: string[]; values: (readonly unknown[])[] } {
  const queries: string[] = [];
  const values: (readonly unknown[])[] = [];
  const tx = {
    context: { clock: { now: () => Date.now() }, release: "r", log: { write: () => {} } },
    ids: createIdSource({ now: () => Date.now() }),
    async query(text: string, params?: readonly unknown[]) {
      queries.push(text);
      values.push(params ?? []);
      return { rows: [{ epoch: 2 }], rowCount: 1, command: "SELECT", fields: [] };
    },
  } as unknown as UnitTx;
  return { tx, queries, values };
}

const context = { runId: "run_1", release: "r", environment: "staging" as const };

describe("the task registry", () => {
  it("knows Phase 0's tasks by name", () => {
    expect(Object.keys(TASKS).sort()).toEqual(["audit-note", "audit-start-epoch"]);
  });

  it("reads FIN_TASK_PARAMS as JSON, an empty value as no parameters", () => {
    expect(parseTaskParams(undefined)).toEqual({});
    expect(parseTaskParams('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseTaskParams("{")).toThrow(TaskError);
  });
});

describe("audit-note's parameters", () => {
  it("accept the three operator events and nothing else", () => {
    expect(
      auditNote.params.safeParse({
        event: "operator.escrow_opened",
        family: "seal-key",
        version: 1,
        incidentRef: "inc-1",
      }).success,
    ).toBe(true);
    expect(
      auditNote.params.safeParse({ event: "operator.task_completed", task: "x-y", rowsChanged: 0 })
        .success,
    ).toBe(true);
    for (const bad of [
      { event: "switch.set" },
      {
        event: "operator.escrow_opened",
        family: "seal-key",
        version: 1,
        incidentRef: "inc-1",
        note: "free text",
      },
      { event: "operator.escrow_opened", family: "Seal Key", version: 1, incidentRef: "inc-1" },
      {
        event: "operator.credential_rotated",
        family: "seal-key",
        version: 0,
        services: [],
        overlapEnds: null,
      },
    ]) {
      expect(auditNote.params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("audit-start-epoch", () => {
  const params = {
    reason: "reset" as const,
    previousHeadHash: "ab".repeat(32),
    markerKey: "ops/reset/x.json",
  };

  it("refuses a reset in production before asking the database", async () => {
    const { tx, queries } = fakeTx();
    await expect(
      startEpoch.run(tx, params, { ...context, environment: "production" }),
    ).rejects.toBeInstanceOf(StartEpochRefused);
    expect(queries).toEqual([]);
  });

  it("refuses a marker under another reason's prefix", async () => {
    const { tx, queries } = fakeTx();
    await expect(
      startEpoch.run(tx, { ...params, markerKey: "ops/restore/x.json" }, context),
    ).rejects.toBeInstanceOf(StartEpochRefused);
    expect(queries).toEqual([]);
  });

  it("calls audit.start_epoch with the run's ID, release and environment, and returns the new epoch", async () => {
    const { tx, queries, values } = fakeTx();
    const result = await startEpoch.run(tx, params, context);
    expect(queries).toEqual(["SELECT audit.start_epoch($1, $2, $3, $4, $5, $6, $7) AS epoch"]);
    // The database checks the environment against the row its bootstrap wrote (spec 08 §3.9).
    expect(values[0]?.slice(4)).toEqual(["run_1", "r", "staging"]);
    expect(result.ids).toMatchObject({ epoch: 2 });
  });

  it("refuses a malformed hash or marker", () => {
    expect(
      startEpoch.params.safeParse({ ...params, previousHeadHash: "AB".repeat(32) }).success,
    ).toBe(false);
    expect(
      startEpoch.params.safeParse({ ...params, markerKey: "ops/reset/../x.json" }).success,
    ).toBe(false);
  });
});
