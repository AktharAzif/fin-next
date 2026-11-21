// `migrate` end to end against Postgres 18 (spec 01 §6.6 steps 3 to 6, AC-P0-29's local half): the
// bootstrap from an empty database, the migration run with fin_owner's per-run password (cleared after),
// the registry sync, the privileged-login record naming the run, and the operator tasks.
import { AUDIT_EVENTS } from "@fin/audit";
import type { PgClient } from "@fin/db";
import {
  createTestDatabase,
  type TestDatabase,
  testSuperuserUrl,
  testVerifiersJson,
} from "@fin/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_CONFIG, EXIT_FAILED, EXIT_OK, runMigrateCli } from "./main.ts";

let db: TestDatabase;
let su: PgClient;
const clock = { now: () => Date.now() };
const RUN_ID = "run_01jdtest0000000000000000";

beforeAll(async () => {
  db = await createTestDatabase({ prefix: "p0e", bootstrap: false });
  su = await db.superuser();
});

afterAll(async () => {
  await su?.end();
  await db?.drop();
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    FIN_ENVIRONMENT: "ci",
    FIN_RELEASE: "release-under-test",
    FIN_RUN_ID: RUN_ID,
    FIN_BOOTSTRAP_DATABASE_URL: testSuperuserUrl(db),
    ...extra,
  };
}

/** Runs the CLI under the cluster lock (it changes cluster-wide roles), returning its lines. */
async function cli(
  argv: string[],
  extra: Record<string, string> = {},
): Promise<{ code: number; lines: Record<string, unknown>[]; raw: string }> {
  let raw = "";
  const code = await db.withLock(() =>
    runMigrateCli(argv, env(extra), {
      stdout: (t) => {
        raw += t;
      },
      clock,
    }),
  );
  const lines = raw
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { code, lines, raw };
}

describe("migrate --bootstrap", () => {
  it("creates the roles, schemas and the privileged-login guard from an empty database", async () => {
    const { code, lines, raw } = await cli(["--bootstrap"], {
      FIN_ROLE_VERIFIERS: testVerifiersJson(),
    });
    expect(code).toBe(EXIT_OK);
    expect(lines.map((l) => l.event)).toEqual(["migrate.started", "migrate.done"]);
    expect(lines[1]).toMatchObject({ mode: "bootstrap", verifiersSet: 14, runId: RUN_ID });
    expect(raw).not.toMatch(/SCRAM-SHA-256\$/);
    const triggers = await su.query<{ evtname: string }>(
      "SELECT evtname FROM pg_event_trigger ORDER BY evtname",
    );
    expect(triggers.rows.map((r) => r.evtname)).toEqual([
      "fin_privileged_login",
      "fin_privileged_login_guard_alter",
      "fin_privileged_login_guard_drop",
    ]);
  });
});

describe("migrate --migrate", () => {
  it("applies every migration as fin_owner with a password for the run only, and syncs the registry", async () => {
    const { code, lines } = await cli(["--migrate"]);
    expect(code).toBe(EXIT_OK);
    expect(lines[1]).toMatchObject({
      event: "migrate.done",
      mode: "migrate",
      applied: 5,
      newest: expect.stringMatching(/_events_shell\.sql$/),
    });
    const types = await su.query<{ n: number }>("SELECT count(*)::int AS n FROM audit.event_type");
    expect(types.rows[0]?.n).toBe(Object.keys(AUDIT_EVENTS).length);
    // AC-P0-29: fin_owner has no valid password once the run ends.
    const owner = await su.query(
      "SELECT rolpassword IS NULL AS none FROM pg_authid WHERE rolname = 'fin_owner'",
    );
    expect(owner.rows).toEqual([{ none: true }]);
    // The privileged-login record names the run, so the worker can match it.
    const logins = await su.query<{ login_role: string }>(
      "SELECT DISTINCT login_role, application_name FROM ops.privileged_login WHERE application_name = $1 ORDER BY 1",
      [`fin-migrate:${RUN_ID}`],
    );
    expect(logins.rows.map((r) => r.login_role)).toContain("fin_owner");
  });

  it("applies nothing on a second run", async () => {
    const { code, lines } = await cli(["--migrate"]);
    expect(code).toBe(EXIT_OK);
    expect(lines[1]).toMatchObject({ applied: 0 });
  });

  it("fails with migrate.failed and a non-zero exit when a migration fails", async () => {
    const { code, lines } = await cli(["--migrate"], {
      FIN_DB_ASSETS_DIR: "/nonexistent-fin-assets",
    });
    expect(code).toBe(EXIT_FAILED);
    expect(lines.at(-1)).toMatchObject({ event: "migrate.failed", mode: "migrate" });
  });
});

describe("migrate --task", () => {
  it("records an operator event with audit-note, as the operator of the run", async () => {
    const params = JSON.stringify({
      event: "operator.credential_rotated",
      family: "seal-key",
      version: 2,
      services: ["api", "worker"],
      overlapEnds: "2026-12-01",
    });
    const { code, lines } = await cli(["--task", "audit-note"], { FIN_TASK_PARAMS: params });
    expect(code).toBe(EXIT_OK);
    expect(lines.at(-1)).toMatchObject({ event: "task.done", task: "audit-note", rowsChanged: 1 });
    const row = await su.query(
      "SELECT event, actor_kind, actor_id, actor_via, db_login, target_id FROM audit.event WHERE id = $1",
      [lines.at(-1)?.auditEventId],
    );
    expect(row.rows).toEqual([
      {
        event: "operator.credential_rotated",
        actor_kind: "operator",
        actor_id: RUN_ID,
        actor_via: "operator",
        db_login: "fin_owner",
        target_id: "seal-key",
      },
    ]);
  });

  it("starts an audit epoch and records operator.task_completed with it", async () => {
    const params = JSON.stringify({
      reason: "reset",
      previousHeadHash: "ab".repeat(32),
      markerKey: "ops/reset/20261121T130000Z.json",
    });
    const { code, lines } = await cli(["--task", "audit-start-epoch"], { FIN_TASK_PARAMS: params });
    expect(code).toBe(EXIT_OK);
    expect(lines.at(-1)).toMatchObject({ event: "task.done", task: "audit-start-epoch", epoch: 2 });
    const events = await su.query<{ event: string }>(
      "SELECT event FROM audit.event WHERE epoch = 2 ORDER BY recorded_at, id",
    );
    expect(events.rows.map((r) => r.event)).toEqual([
      "audit.epoch_started",
      "operator.task_completed",
    ]);
  });

  it("refuses unknown parameters and an unknown task, changing nothing", async () => {
    const before = await su.query("SELECT count(*)::int AS n FROM audit.event");
    const bad = await cli(["--task", "audit-note"], {
      FIN_TASK_PARAMS: JSON.stringify({
        event: "operator.escrow_opened",
        family: "seal-key",
        version: 1,
        incidentRef: "i",
        extra: 1,
      }),
    });
    expect(bad.code).toBe(EXIT_CONFIG);
    expect(bad.lines.at(-1)).toMatchObject({ event: "task.failed", code: "task_params" });
    const unknown = await cli(["--task", "drop-everything"]);
    expect(unknown.code).toBe(EXIT_CONFIG);
    expect(unknown.lines.at(-1)).toMatchObject({ event: "task.failed", code: "task_unknown" });
    const after = await su.query("SELECT count(*)::int AS n FROM audit.event");
    expect(after.rows).toEqual(before.rows);
  });
});

describe("migrate --print-db-cert", () => {
  it("fails cleanly against a server without TLS", async () => {
    const { code, lines } = await cli(["--print-db-cert"], {
      FIN_DB_HOST: db.target.host,
      FIN_DB_PORT: String(db.target.port),
      FIN_DB_NAME: db.name,
    });
    expect(code).toBe(EXIT_FAILED);
    expect(lines.at(-1)).toMatchObject({ event: "migrate.failed", mode: "print-db-cert" });
  });
});
