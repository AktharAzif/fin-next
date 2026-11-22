import { createIdSource, type FinDatabase, type UnitTx } from "@fin/db";
import { describe, expect, it, vi } from "vitest";
import { auditNote } from "./audit-note.ts";
import { TASKS } from "./registry.ts";
import { parseTaskParams, runTask, TaskError } from "./run.ts";
import { staffBootstrap } from "./staff-bootstrap/task.ts";
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

/** A database that must not be reached: a refused run opens no unit of work. */
function untouchedDb(): { db: FinDatabase; unit: ReturnType<typeof vi.fn> } {
  const unit = vi.fn(async () => {
    throw new Error("the run opened a unit of work");
  });
  return { db: { unit } as unknown as FinDatabase, unit };
}

const runContext = {
  ...context,
  unit: {} as Parameters<typeof runTask>[3]["unit"],
  log: { write: () => {} },
};

async function refusal(name: string, params: unknown): Promise<string | undefined> {
  const { db, unit } = untouchedDb();
  const error = await runTask(db, name, params, runContext).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, name).toBeInstanceOf(TaskError);
  expect(unit).not.toHaveBeenCalled();
  return (error as TaskError).code;
}

describe("the task registry", () => {
  it("knows Phase 0's tasks by name", () => {
    expect(Object.keys(TASKS).sort()).toEqual([
      "audit-note",
      "audit-start-epoch",
      "staff-bootstrap",
    ]);
    expect(TASKS["staff-bootstrap"]).toBe(staffBootstrap);
  });

  it("resolves staff-bootstrap, so its parameters are read rather than the name refused", async () => {
    expect(await refusal("staff-bootstrap", { address: "first.admin@example.com" })).toBe(
      "task_params",
    );
    // The enrolment code itself is never a parameter.
    expect(
      await refusal("staff-bootstrap", {
        address: "first.admin@example.com",
        codeHash: "ab".repeat(32),
        reasonCode: "first_admin",
        code: "ABCD-EFGH-JKMN-PQRS",
      }),
    ).toBe("task_params");
  });

  it("refuses a task it does not list, an inherited property's name included", async () => {
    for (const name of ["drop-everything", "staff-bootstraps", "constructor"]) {
      expect(await refusal(name, {})).toBe("task_unknown");
    }
  });

  it("loads a task's module on its own, before the registry or the runner", async () => {
    vi.resetModules();
    const task = await import("./staff-bootstrap/task.ts");
    const registry = await import("./registry.ts");
    expect(registry.TASKS["staff-bootstrap"]).toBe(task.staffBootstrap);
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
