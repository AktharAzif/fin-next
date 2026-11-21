// AC-P0-11 and AC-P0-39 (T-SAT-20's pattern): each login is refused with SQLSTATE 42501 on every
// statement its grant fragments do not allow, and is not refused with 42501 on the ones they do. The
// cases are generated from the live catalogue (every table, column, sequence and function in Fin's
// schemas) and the expected answer from the fragments, so a new object without a grant is covered the
// moment its migration lands. And the roles themselves: memberships (the boot check and the drift
// check), attributes, and the backup login's reach past row-level security (DA-15).
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { expandMatrix, grantDrift, liveMemberships, loadFragments } from "./grants.ts";
import { assertServiceLogin } from "./login-check.ts";
import { GRANTS_DIR } from "./migrations.ts";
import { enqueueJob, recordDutyRun } from "./ops.ts";
import type { PgClient } from "./pg.ts";
import { sqlState } from "./pg.ts";
import { connectionLimit, SERVICE_GROUPS, SERVICE_LOGINS } from "./roles.ts";
import {
  createTestDatabase,
  TEST_REPLICAS,
  type TestDatabase,
  testContext,
  testLoginPassword,
} from "./testing/index.ts";

// The integration timeouts, which the root Vitest configuration leaves to each file: a file's
// database is made under the cluster-wide lock that other files' bootstraps may hold.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let db: TestDatabase;
let su: PgClient;

interface Relation {
  name: string;
  kind: "table" | "sequence";
  columns: string[];
}
interface Fn {
  name: string;
  args: string[];
}
let relations: Relation[] = [];
let functions: Fn[] = [];

const SCHEMAS = ["identity", "staff", "keys", "kyc", "money", "events", "email", "audit", "ops"];

beforeAll(async () => {
  // Phase 0's objects: packages/db's files alone (assets.db.test.ts applies every package's).
  db = await createTestDatabase({ prefix: "p0e", packages: ["db"] });
  su = await db.superuser();
  const rel = await su.query<{ name: string; kind: string; columns: string[] }>(
    `SELECT n.nspname || '.' || c.relname AS name, c.relkind::text AS kind,
            coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE a.attnum > 0 AND NOT a.attisdropped), '{}') AS columns
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = ANY ($1) AND c.relkind IN ('r', 'p', 'S')
     GROUP BY 1, 2 ORDER BY 1`,
    [SCHEMAS],
  );
  relations = rel.rows.map((r) => ({
    name: r.name,
    kind: r.kind === "S" ? "sequence" : "table",
    columns: r.kind === "S" ? [] : r.columns,
  }));
  const fns = await su.query<{ name: string; args: string }>(
    `SELECT n.nspname || '.' || p.proname AS name, oidvectortypes(p.proargtypes) AS args
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY ($1) AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
     ORDER BY 1`,
    [SCHEMAS],
  );
  functions = fns.rows.map((f) => ({
    name: f.name,
    args: f.args === "" ? [] : f.args.split(", "),
  }));
});

afterAll(async () => {
  await su?.end();
  await db?.drop();
});

const matrix = expandMatrix(loadFragments(GRANTS_DIR));

function granted(role: string, kind: string, object: string, privilege: string): boolean {
  return matrix.some(
    (p) => p.role === role && p.kind === kind && p.object === object && p.privilege === privilege,
  );
}

/** What the fragments allow a login, through its group (or, for the backup login, pg_read_all_data). */
function allows(login: string, statement: Statement): boolean {
  if (login === "fin_backup") return statement.privilege === "SELECT";
  const role = login.replace(/_[ab]$/, "");
  const schema = statement.object.split(".")[0] ?? "";
  if (!granted(role, "schema", schema, "USAGE")) return false;
  if (statement.kind === "function") {
    return granted(role, "function", statement.object, "EXECUTE");
  }
  if (statement.privilege === "UPDATE" && statement.column !== undefined) {
    return (
      granted(role, "table", statement.object, "UPDATE") ||
      granted(role, "table", `${statement.object}(${statement.column})`, "UPDATE")
    );
  }
  return granted(role, "table", statement.object, statement.privilege);
}

interface Statement {
  kind: "table" | "function";
  object: string;
  privilege: string;
  column?: string;
  sql: string;
}

function quote(name: string): string {
  return name
    .split(".")
    .map((part) => `"${part}"`)
    .join(".");
}

function statements(): Statement[] {
  const out: Statement[] = [];
  for (const rel of relations) {
    const t = quote(rel.name);
    out.push({
      kind: "table",
      object: rel.name,
      privilege: "SELECT",
      sql: `SELECT 1 FROM ${t} LIMIT 0`,
    });
    if (rel.kind === "sequence") {
      out.push({
        kind: "table",
        object: rel.name,
        privilege: "USAGE",
        sql: `SELECT nextval('${rel.name}')`,
      });
      continue;
    }
    out.push({
      kind: "table",
      object: rel.name,
      privilege: "INSERT",
      sql: `INSERT INTO ${t} SELECT WHERE false`,
    });
    out.push({
      kind: "table",
      object: rel.name,
      privilege: "DELETE",
      sql: `DELETE FROM ${t} WHERE false`,
    });
    out.push({ kind: "table", object: rel.name, privilege: "TRUNCATE", sql: `TRUNCATE ${t}` });
    for (const column of rel.columns) {
      out.push({
        kind: "table",
        object: rel.name,
        privilege: "UPDATE",
        column,
        sql: `UPDATE ${t} SET "${column}" = DEFAULT WHERE false`,
      });
    }
  }
  for (const fn of functions) {
    const args = fn.args.map((type) => `NULL::${type}`).join(", ");
    out.push({
      kind: "function",
      object: `${fn.name}(${fn.args.map((a) => a.replace("timestamp with time zone", "timestamptz")).join(", ")})`,
      privilege: "EXECUTE",
      sql: `SELECT ${quote(fn.name)}(${args})`,
    });
  }
  for (const schema of SCHEMAS) {
    out.push({
      kind: "table",
      object: `${schema}.created_by_a_service`,
      privilege: "CREATE",
      sql: `CREATE TABLE "${schema}".created_by_a_service (id int)`,
    });
  }
  return out;
}

async function outcome(client: PgClient, sql: string): Promise<string> {
  await client.query("SAVEPOINT probe");
  try {
    await client.query(sql);
    return "ok";
  } catch (error) {
    return sqlState(error) ?? "error";
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT probe");
  }
}

const LOGINS = [...SERVICE_LOGINS, "fin_probe", "fin_backup"];

describe("AC-P0-11: every login is refused (42501) outside its grants, and only there", () => {
  it("covers every Phase 0 table, column, sequence and function, with both answers expected", () => {
    expect(relations.length).toBeGreaterThanOrEqual(19);
    expect(functions.map((f) => f.name)).toContain("audit.record");
    const all = statements();
    expect(all.length).toBeGreaterThan(150);
    const allowedForWorker = all.filter((s) => allows("fin_worker_a", s)).map((s) => s.sql);
    expect(allowedForWorker).toContain('SELECT "audit"."sequence"(NULL::integer)');
    expect(allowedForWorker).toContain(
      'UPDATE "ops"."scheduler_lease" SET "holder" = DEFAULT WHERE false',
    );
    expect(allowedForWorker).not.toContain(
      'UPDATE "ops"."scheduler_lease" SET "name" = DEFAULT WHERE false',
    );
    expect(all.filter((s) => allows("fin_edge_a", s)).map((s) => s.sql)).not.toContain(
      'SELECT "audit"."record"(NULL::jsonb)',
    );
  });

  it("spot checks: the refusals are the database's, with SQLSTATE 42501", async () => {
    const api = await db.connect("fin_api_a");
    const worker = await db.connect("fin_worker_a");
    try {
      expect(sqlState(await api.query("SELECT audit.sequence(1)").catch((e: unknown) => e))).toBe(
        "42501",
      );
      expect(sqlState(await api.query("DELETE FROM audit.event").catch((e: unknown) => e))).toBe(
        "42501",
      );
      expect(
        sqlState(await worker.query("UPDATE audit.event SET seq = 1").catch((e: unknown) => e)),
      ).toBe("42501");
      expect(
        sqlState(
          await worker.query("UPDATE ops.kill_switch SET state = 'on'").catch((e: unknown) => e),
        ),
      ).toBe("42501");
      expect(
        sqlState(
          await worker
            .query("UPDATE ops.scheduler_lease SET name = 'worker'")
            .catch((e: unknown) => e),
        ),
      ).toBe("42501");
      await expect(worker.query("SELECT audit.sequence(10)")).resolves.toBeDefined();
    } finally {
      await api.end();
      await worker.end();
    }
  });

  for (const login of LOGINS) {
    it(`${login}`, async () => {
      const client = await db.connect(login);
      const mismatches: string[] = [];
      try {
        await client.query("BEGIN");
        for (const statement of statements()) {
          const result = await outcome(client, statement.sql);
          const refused = result === "42501";
          if (refused === allows(login, statement)) {
            mismatches.push(
              `${allows(login, statement) ? "refused" : "allowed"}: ${statement.sql} (${result})`,
            );
          }
        }
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
      expect(mismatches).toEqual([]);
    });
  }

  it("refuses fin_readonly everything in Fin's schemas (it is granted no Phase 0 table)", async () => {
    // fin_readonly has no password (the operator sets one per run); the superuser takes its role.
    const su2 = await db.superuser();
    try {
      await su2.query("SET ROLE fin_readonly");
      await su2.query("BEGIN");
      for (const statement of statements()) {
        const result = await outcome(su2, statement.sql);
        expect(result, statement.sql).toBe("42501");
      }
      await su2.query("ROLLBACK");
    } finally {
      await su2.query("RESET ROLE").catch(() => {});
      await su2.end();
    }
  });
});

describe("the roles themselves (spec 01 §6.6 step 4, P-20, AU-08)", () => {
  it("makes each service login a member of exactly its group, and the groups members of nothing", async () => {
    const result = await su.query<{ member: string; granted: string }>(
      `SELECT m.rolname AS member, g.rolname AS granted
       FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member JOIN pg_roles g ON g.oid = am.roleid
       WHERE m.rolname LIKE 'fin\\_%' ORDER BY 1, 2`,
    );
    const expected = [
      ...SERVICE_LOGINS.map((login) => ({ member: login, granted: login.replace(/_[ab]$/, "") })),
      { member: "fin_backup", granted: "pg_read_all_data" },
      { member: "fin_probe", granted: "pg_monitor" },
    ].sort((a, b) => `${a.member} ${a.granted}`.localeCompare(`${b.member} ${b.granted}`));
    expect(
      result.rows.sort((a, b) =>
        `${a.member} ${a.granted}`.localeCompare(`${b.member} ${b.granted}`),
      ),
    ).toEqual(expected);
  });

  it("gives fin_owner no superuser, no attribute beyond LOGIN, and statement logging", async () => {
    const result = await su.query<{
      rolname: string;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolconnlimit: number;
      config: string[] | null;
    }>(
      `SELECT r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolcanlogin, r.rolconnlimit,
              (SELECT setconfig FROM pg_db_role_setting s WHERE s.setrole = r.oid AND s.setdatabase = 0) AS config
       FROM pg_roles r WHERE r.rolname IN ('fin_owner', 'fin_readonly', 'fin_api', 'fin_api_a', 'fin_probe')
       ORDER BY 1`,
    );
    const byName = Object.fromEntries(result.rows.map((r) => [r.rolname, r]));
    for (const row of result.rows) {
      expect(
        row.rolsuper || row.rolcreaterole || row.rolcreatedb || row.rolbypassrls,
        row.rolname,
      ).toBe(false);
    }
    expect(byName.fin_api?.rolcanlogin).toBe(false);
    expect(byName.fin_api_a?.rolcanlogin).toBe(true);
    // (pool max + LISTEN) × replicas × 2 + 2, for the replicas the test bootstrap was given.
    expect(byName.fin_api_a?.rolconnlimit).toBe(connectionLimit("api", TEST_REPLICAS));
    expect(byName.fin_owner?.config).toContain("log_statement=all");
    expect(byName.fin_readonly?.config).toContain("log_statement=all");
    expect(byName.fin_api_a?.config).toEqual(
      expect.arrayContaining([
        "statement_timeout=15s",
        "lock_timeout=5s",
        "idle_in_transaction_session_timeout=30s",
      ]),
    );
  });

  it("passes the boot check for each service's own login, and fails it for any other", async () => {
    for (const group of SERVICE_GROUPS) {
      const client = await db.connect(`${group}_a`);
      try {
        await expect(
          assertServiceLogin(client, { login: `${group}_a`, group }),
        ).resolves.toBeUndefined();
        const other = group === "fin_api" ? "fin_edge" : "fin_api";
        await expect(
          assertServiceLogin(client, { login: `${other}_a`, group: other }),
        ).rejects.toThrow();
      } finally {
        await client.end();
      }
    }
    const owner = await db.connect("fin_owner");
    try {
      await expect(
        assertServiceLogin(owner, { login: "fin_api_a", group: "fin_api" }),
      ).rejects.toThrow();
    } finally {
      await owner.end();
    }
  });

  it("fails the boot check for a login that can SET ROLE to another group", async () => {
    await db.withLock(async () => {
      await su.query("GRANT fin_worker TO fin_api_b");
      const client = await db.connect("fin_api_b");
      try {
        await expect(
          assertServiceLogin(client, { login: "fin_api_b", group: "fin_api" }),
        ).rejects.toThrow(/member of something other than its own group/);
      } finally {
        await client.end();
        await su.query("REVOKE fin_worker FROM fin_api_b");
      }
    });
  });

  it("finds no drift, in grants or memberships, on a freshly migrated database", async () => {
    const owner = await db.connect("fin_owner");
    try {
      expect(await grantDrift(owner, loadFragments(GRANTS_DIR))).toEqual([]);
    } finally {
      await owner.end();
    }
  });

  it("fails the boot check, and the drift check reports it, for a membership that inherits without SET", async () => {
    // pg_write_all_data hands over INSERT, UPDATE and DELETE everywhere without SET ROLE to it.
    await db.withLock(async () => {
      await su.query("GRANT pg_write_all_data TO fin_api_b WITH INHERIT TRUE, SET FALSE");
      const client = await db.connect("fin_api_b");
      try {
        // The inherited role really does hand over the writes (a table the matrix gives it nothing on).
        await expect(
          client.query(
            "INSERT INTO ops.job_kind (kind, enqueue_roles, runner) VALUES ('test.inherited', ARRAY['fin_api'], 'worker')",
          ),
        ).resolves.toBeDefined();
        await expect(
          assertServiceLogin(client, { login: "fin_api_b", group: "fin_api" }),
        ).rejects.toThrow(/member of something other than its own group/);
        expect(await grantDrift(su, loadFragments(GRANTS_DIR))).toEqual([
          { role: "fin_api_b", missing: 0, extra: 1 },
        ]);
        expect((await liveMemberships(su)).filter((m) => m.member === "fin_api_b")).toEqual([
          { member: "fin_api_b", role: "fin_api", admin: false, inherit: true, set: true },
          {
            member: "fin_api_b",
            role: "pg_write_all_data",
            admin: false,
            inherit: true,
            set: false,
          },
        ]);
      } finally {
        await client.end();
        await su.query("REVOKE pg_write_all_data FROM fin_api_b");
        await su.query("DELETE FROM ops.job_kind WHERE kind = 'test.inherited'");
      }
    });
  });

  it("lets the backup login read every row of the tables under row-level security, as pg_dump does", async () => {
    const worker = db.database("fin_worker");
    await worker.unit(testContext(), (tx) => enqueueJob(tx, { kind: "ops.noop" }));
    await worker.unit(testContext(), (tx) =>
      recordDutyRun(tx, { scheduler: "worker", duty: "backup-probe", result: "ok" }),
    );
    const attributes = await su.query(
      "SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'fin_backup'",
    );
    expect(attributes.rows).toEqual([
      {
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: true,
      },
    ]);
    const backup = await db.connect("fin_backup");
    try {
      // pg_dump's default: row_security off, so a table whose rows a policy would filter is an error.
      await backup.query("SET row_security = off");
      for (const table of ["ops.job", "ops.duty_state", "ops.scheduler_lease"]) {
        const seen = await backup.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        const all = await su.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        expect(seen.rows[0]?.n, table).toBe(all.rows[0]?.n);
        expect(all.rows[0]?.n, table).toBeGreaterThan(0);
      }
    } finally {
      await backup.end();
    }
  });

  // pg_dump itself, as the nightly backup runs it, when the Postgres binaries are at hand
  // (FIN_TEST_PG_BINDIR, as for the TLS test).
  it.skipIf((process.env.FIN_TEST_PG_BINDIR ?? "") === "")(
    "dumps every row of the jobs table as the backup login with pg_dump's defaults",
    () => {
      const out = execFileSync(
        join(process.env.FIN_TEST_PG_BINDIR ?? "", "pg_dump"),
        [
          "--host",
          db.target.host,
          "--port",
          String(db.target.port),
          "--username",
          "fin_backup",
          "--dbname",
          db.name,
          "--data-only",
          "--table",
          "ops.job",
        ],
        { env: { ...process.env, PGPASSWORD: testLoginPassword("fin_backup") }, encoding: "utf8" },
      );
      expect(out).toMatch(/\njob_[0-9a-hjkmnp-tv-z]{26}\tops\.noop\t/);
    },
  );
});
