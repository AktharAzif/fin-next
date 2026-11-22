// `migrate` end to end against Postgres 18 (spec 01 §6.6 steps 3 to 6, AC-P0-29's local half): the
// bootstrap from an empty database, the migration run with fin_owner's per-run password (cleared after),
// the registry sync, the privileged-login record naming the run, and the operator tasks.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_EVENTS } from "@fin/audit";
import { listMigrations, type PgClient, sourceRoot, stageDbAssets } from "@fin/db";
import {
  createTestDatabase,
  type TestDatabase,
  testReplicasJson,
  testSuperuserUrl,
  testVerifiersJson,
} from "@fin/db/testing";
import { grantRows } from "@fin/email";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EXIT_CONFIG, EXIT_FAILED, EXIT_OK, runMigrateCli } from "./main.ts";

// The integration timeouts, which the root Vitest configuration leaves to each file: a file's
// database is made under the cluster-wide lock that other files' bootstraps may hold.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

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
  // The connection limits are cluster-wide: the test bootstrap sizes them as every other test file's.
  const bootstrapEnv = {
    FIN_ROLE_VERIFIERS: testVerifiersJson(),
    FIN_DB_REPLICAS: testReplicasJson(),
  };

  it("creates the roles, schemas, the environment row and the guards from an empty database", async () => {
    const { code, lines, raw } = await cli(["--bootstrap"], bootstrapEnv);
    expect(code).toBe(EXIT_OK);
    expect(lines.map((l) => l.event)).toEqual(["migrate.started", "migrate.done"]);
    expect(lines[1]).toMatchObject({ mode: "bootstrap", verifiersSet: 14, runId: RUN_ID });
    expect(raw).not.toMatch(/SCRAM-SHA-256\$/);
    const triggers = await su.query<{ evtname: string }>(
      "SELECT evtname FROM pg_event_trigger ORDER BY evtname",
    );
    expect(triggers.rows.map((r) => r.evtname)).toEqual([
      "fin_audit_guard_change",
      "fin_audit_guard_drop",
      "fin_audit_guard_rewrite",
      "fin_privileged_login",
      "fin_privileged_login_guard_alter",
      "fin_privileged_login_guard_drop",
    ]);
    expect((await su.query("SELECT name FROM ops.environment")).rows).toEqual([{ name: "ci" }]);
  });

  it("refuses a second bootstrap for another environment (exit 78), changing nothing", async () => {
    const { code, lines } = await cli(["--bootstrap"], {
      ...bootstrapEnv,
      FIN_ENVIRONMENT: "development",
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(lines.at(-1)).toMatchObject({ event: "migrate.failed", code: "bootstrap_environment" });
    expect((await su.query("SELECT name FROM ops.environment")).rows).toEqual([{ name: "ci" }]);
  });
});

describe("migrate --migrate", () => {
  const signInCode = (id: string) =>
    JSON.stringify({
      id,
      template: "identity/sign-in-code",
      recipient_kind: "address",
      recipient: "person@example.com",
      params: { code: "12345678" },
    });

  it("applies every package's migrations as fin_owner with a password for the run only, and syncs the registry", async () => {
    const { code, lines } = await cli(["--migrate"]);
    expect(code).toBe(EXIT_OK);
    // The source tree's files (FIN_DB_ASSETS_DIR unset), every package's: the set the image ships.
    const migrations = listMigrations(sourceRoot() ?? "");
    expect(migrations.some((name) => /_identity_/.test(name))).toBe(true);
    expect(lines[1]).toMatchObject({
      event: "migrate.done",
      mode: "migrate",
      applied: migrations.length,
      newest: migrations.at(-1),
    });
    const recorded = await su.query<{ name: string }>(
      "SELECT name FROM ops.schema_migrations ORDER BY name",
    );
    expect(recorded.rows.map((r) => r.name)).toEqual(migrations);
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

  it("builds the email sender's schema and email.enqueue()'s allowlist from the template catalogue", async () => {
    // The sender's tables and the outbox's sender columns (packages/email's migration), all in
    // email_private beside the outbox; the template grants and email.enqueue() stay in email.
    const objects = await su.query<{ name: string; found: boolean }>(
      `SELECT name, pg_catalog.to_regclass(name) IS NOT NULL AS found
       FROM unnest($1::text[]) AS t(name) ORDER BY name`,
      [
        [
          "email_private.recipient_window",
          "email_private.daily_budget",
          "email_private.send_bucket",
          "email_private.delivery_check",
          "email_private.delivery_check_turn",
        ],
      ],
    );
    for (const row of objects.rows) expect(row.found, row.name).toBe(true);
    const columns = await su.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'email_private' AND table_name = 'outbox'
         AND column_name IN ('folded_into', 'first_due_at', 'counted')`,
    );
    expect(columns.rows[0]?.n).toBe(3);

    // Exactly the catalogue's rows, each with its class's priority and secret flag.
    const rows = await su.query<{
      template: string;
      role: string;
      category: string;
      priority: number;
      carries_secret: boolean;
    }>("SELECT template, role, category, priority, carries_secret FROM email.template_grant");
    const byKey = (a: { template: string; role: string }, b: { template: string; role: string }) =>
      `${a.template} ${a.role}` < `${b.template} ${b.role}` ? -1 : 1;
    const want = grantRows().map((g) => ({
      template: g.template,
      role: g.role,
      category: g.category,
      priority: g.priority,
      carries_secret: g.carriesSecret,
    }));
    expect(rows.rows.sort(byKey)).toEqual(want.sort(byKey));

    // Only the worker holds the sender's tables, and only the worker may use their schema.
    const privileges = await su.query<{
      worker: boolean;
      console: boolean;
      worker_schema: boolean;
      console_schema: boolean;
    }>(
      `SELECT has_table_privilege('fin_worker', 'email_private.send_bucket', 'UPDATE') AS worker,
              has_table_privilege('fin_console', 'email_private.send_bucket', 'SELECT') AS console,
              has_schema_privilege('fin_worker', 'email_private', 'USAGE') AS worker_schema,
              has_schema_privilege('fin_console', 'email_private', 'USAGE') AS console_schema`,
    );
    expect(privileges.rows).toEqual([
      { worker: true, console: false, worker_schema: true, console_schema: false },
    ]);

    // The console may queue a sign-in code; the api's login may not (FE001).
    const consoleLogin = await db.connect("fin_console_a");
    try {
      const queued = await consoleLogin.query<{ id: string }>(
        "SELECT email.enqueue($1::jsonb) AS id",
        [signInCode(`eml_${"0".repeat(26)}`)],
      );
      expect(queued.rows).toEqual([{ id: `eml_${"0".repeat(26)}` }]);
    } finally {
      await consoleLogin.end();
    }
    const apiLogin = await db.connect("fin_api_a");
    try {
      await expect(
        apiLogin.query("SELECT email.enqueue($1::jsonb)", [signInCode(`eml_${"1".repeat(26)}`)]),
      ).rejects.toMatchObject({ code: "FE001" });
    } finally {
      await apiLogin.end();
    }
    await su.query("DELETE FROM email_private.outbox");
  });

  it("takes a template from a role whose rule no longer gives it, and keeps a newer release's template", async () => {
    // Rows an earlier release's run could have left: the api's login holding the sign-in code (a
    // template this catalogue gives only the console), and a template only a newer release knows.
    await su.query(
      `INSERT INTO email.template_grant (template, role, category, priority, carries_secret)
       VALUES ('identity/sign-in-code', 'fin_api', 'code', 1, true),
              ('kyc/from-a-newer-release', 'fin_api', 'customer', 3, false)`,
    );
    const apiLogin = await db.connect("fin_api_a");
    try {
      const queued = await apiLogin.query<{ id: string }>("SELECT email.enqueue($1::jsonb) AS id", [
        signInCode(`eml_${"2".repeat(26)}`),
      ]);
      expect(queued.rows).toEqual([{ id: `eml_${"2".repeat(26)}` }]);

      const { code, lines } = await cli(["--migrate"]);
      expect(code).toBe(EXIT_OK);
      expect(lines[1]).toMatchObject({ applied: 0 });

      const rows = await su.query<{ template: string; role: string }>(
        "SELECT template, role FROM email.template_grant",
      );
      const byKey = (
        a: { template: string; role: string },
        b: { template: string; role: string },
      ) => (`${a.template} ${a.role}` < `${b.template} ${b.role}` ? -1 : 1);
      const want = [
        ...grantRows().map((g) => ({ template: g.template, role: g.role })),
        { template: "kyc/from-a-newer-release", role: "fin_api" },
      ];
      expect(rows.rows.sort(byKey)).toEqual(want.sort(byKey));
      await expect(
        apiLogin.query("SELECT email.enqueue($1::jsonb)", [signInCode(`eml_${"3".repeat(26)}`)]),
      ).rejects.toMatchObject({ code: "FE001" });
    } finally {
      await apiLogin.end();
      await su.query("DELETE FROM email.outbox");
      await su.query(
        "DELETE FROM email.template_grant WHERE template = 'kyc/from-a-newer-release'",
      );
    }
  });

  it("reads the image's layout at FIN_DB_ASSETS_DIR: the same files, so nothing is pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fin-migrate-assets-"));
    try {
      const out = join(dir, "db-assets");
      stageDbAssets(sourceRoot() ?? "", out);
      const { code, lines } = await cli(["--migrate"], { FIN_DB_ASSETS_DIR: out });
      expect(code).toBe(EXIT_OK);
      expect(lines[1]).toMatchObject({ applied: 0, unknown: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a relative FIN_DB_ASSETS_DIR as configuration (exit 78)", async () => {
    const { code, lines } = await cli(["--migrate"], { FIN_DB_ASSETS_DIR: "db-assets" });
    expect(code).toBe(EXIT_CONFIG);
    expect(lines.at(-1)).toMatchObject({ event: "migrate.failed", variable: "FIN_DB_ASSETS_DIR" });
  });

  it("fails with migrate.failed and a non-zero exit when the files are missing", async () => {
    const { code, lines } = await cli(["--migrate"], {
      FIN_DB_ASSETS_DIR: "/nonexistent-fin-assets",
    });
    expect(code).toBe(EXIT_FAILED);
    expect(lines.at(-1)).toMatchObject({
      event: "migrate.failed",
      mode: "migrate",
      code: "db_assets_missing",
    });
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
    // The old epoch's rows (the audit-note above) were chained into it before the switch.
    expect(
      (await su.query("SELECT count(*)::int AS n FROM audit.event WHERE epoch = 1 AND seq IS NULL"))
        .rows,
    ).toEqual([{ n: 0 }]);
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
