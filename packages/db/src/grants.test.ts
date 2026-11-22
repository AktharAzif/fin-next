import { describe, expect, it } from "vitest";
import { MigrationError } from "./errors.ts";
import { expandMatrix, loadFragments, normaliseSignature, parseFragment } from "./grants.ts";
import { GRANTS_DIR } from "./migrations.ts";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof MigrationError) return error.code;
    throw error;
  }
  return "none";
}

describe("grant fragments", () => {
  it("loads Phase 0's fragments, one per area named after its file", () => {
    expect(loadFragments(GRANTS_DIR).map((f) => f.area)).toEqual([
      "audit",
      "email",
      "events",
      "ops",
    ]);
  });

  it("never grants a write on an audit table, or on the kill switches, to any role", () => {
    const matrix = expandMatrix(loadFragments(GRANTS_DIR));
    const writes = matrix.filter(
      (p) =>
        p.kind === "table" &&
        p.privilege !== "SELECT" &&
        (p.object.startsWith("audit.") || p.object.startsWith("ops.kill_switch")),
    );
    expect(writes).toEqual([]);
  });

  it("grants audit.record and email.enqueue to the five recording roles and nothing else", () => {
    const matrix = expandMatrix(loadFragments(GRANTS_DIR));
    const holders = (object: string) =>
      matrix
        .filter((p) => p.object === object)
        .map((p) => p.role)
        .sort();
    const five = ["fin_admin", "fin_api", "fin_console", "fin_payments", "fin_worker"];
    expect(holders("audit.record(jsonb)")).toEqual(five);
    expect(holders("email.enqueue(jsonb)")).toEqual(five);
    expect(holders("audit.sequence(integer)")).toEqual(["fin_worker"]);
    expect(holders("audit.unsequenced_age()")).toEqual(["fin_probe"]);
    expect(holders("ops.set_switch(text, text, text, jsonb)")).toEqual(["fin_admin"]);
  });

  it("expands column grants to one privilege per column", () => {
    const matrix = expandMatrix(loadFragments(GRANTS_DIR));
    expect(
      matrix
        .filter((p) => p.object.startsWith("ops.scheduler_lease(") && p.role === "fin_worker")
        .map((p) => p.object),
    ).toEqual([
      "ops.scheduler_lease(holder)",
      "ops.scheduler_lease(renewed_at)",
      "ops.scheduler_lease(until)",
    ]);
  });

  it("refuses a fragment with an unknown role, privilege, key or object outside Fin's schemas", () => {
    const base = { area: "ops", grants: [] as unknown[] };
    const bad = [
      {
        ...base,
        grants: [{ on: "table", name: "ops.x", privileges: ["SELECT"], to: ["postgres"] }],
      },
      {
        ...base,
        grants: [{ on: "table", name: "ops.x", privileges: ["TRUNCATE"], to: ["fin_api"] }],
      },
      { ...base, grants: [{ on: "table", name: "ops.x", privileges: ["SELECT"], to: [] }] },
      {
        ...base,
        grants: [{ on: "table", name: "public.x", privileges: ["SELECT"], to: ["fin_api"] }],
      },
      {
        ...base,
        grants: [{ on: "schema", name: "public", privileges: ["USAGE"], to: ["fin_api"] }],
      },
      {
        ...base,
        grants: [{ on: "function", name: "ops.f; DROP", privileges: ["EXECUTE"], to: ["fin_api"] }],
      },
      {
        ...base,
        grants: [
          { on: "table", name: "ops.x", privileges: ["DELETE"], columns: ["a"], to: ["fin_api"] },
        ],
      },
      { ...base, extra: true },
      {
        ...base,
        grants: [{ on: "table", name: "ops.x", privileges: ["SELECT"], to: ["fin_api_a"] }],
      },
    ];
    for (const fragment of bad) {
      expect(codeOf(() => parseFragment("ops.json", JSON.stringify(fragment)))).toBe(
        "grants_invalid",
      );
    }
    expect(codeOf(() => parseFragment("ops.json", "{"))).toBe("grants_invalid");
  });

  it("normalises regprocedure text to the fragments' signature form", () => {
    expect(normaliseSignature("ops.enqueue_job(text,text,jsonb,timestamp with time zone)")).toBe(
      "ops.enqueue_job(text, text, jsonb, timestamptz)",
    );
    expect(normaliseSignature("audit.unsequenced_age()")).toBe("audit.unsequenced_age()");
  });
});
