// AC-P0-39: from an empty Postgres 18, the bootstrap and the Phase 0 migrations of spec 01 §6.10 apply
// in order and create exactly its tables and functions with exactly its grants; the kill switches hold
// their six seeds `off`. And the runner's own contract: checksums, the lock, idempotence.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expandMatrix, livePrivileges, loadFragments, privilegeKey } from "./grants.ts";
import { GRANTS_DIR, MIGRATIONS_DIR, parseMigration, readMigrations } from "./migrations.ts";
import type { PgClient } from "./pg.ts";
import { sqlState } from "./pg.ts";
import { createTestDatabase, type TestDatabase } from "./testing/index.ts";

let db: TestDatabase;
let su: PgClient;

beforeAll(async () => {
  db = await createTestDatabase({ prefix: "p0e" });
  su = await db.superuser();
});

afterAll(async () => {
  await su?.end();
  await db?.drop();
});

const EXPECTED_RELATIONS = [
  "audit.anchor table fin_owner",
  "audit.anchor_conflict table fin_owner",
  "audit.event table fin_owner",
  "audit.event_context table fin_owner",
  "audit.event_type table fin_owner",
  "audit.head table fin_owner",
  "audit.journal_entry table fin_owner",
  "audit.journal_shipped table fin_owner",
  "email.outbox table fin_owner",
  "email.template_grant table fin_owner",
  "ops.duty_state table fin_owner",
  "ops.job table fin_owner",
  "ops.job_kind table fin_owner",
  "ops.kill_switch table fin_owner",
  "ops.privileged_login table postgres",
  "ops.privileged_login_check table fin_owner",
  "ops.rate_window table fin_owner",
  "ops.schema_migrations table fin_owner",
  "ops.scheduler_lease table fin_owner",
];

const EXPECTED_FUNCTIONS = [
  "audit.append_only() fin_owner invoker",
  "audit.install_guard(regclass, text[], name, text[]) fin_owner definer",
  "audit.mark_journal_shipped(text, text) fin_owner definer",
  "audit.record(jsonb) fin_owner definer",
  "audit.record_anchor(text, integer, bigint, bytea, text) fin_owner definer",
  "audit.record_anchor_conflict(text, integer, bigint, text, bytea, bytea) fin_owner definer",
  "audit.record_journal(jsonb) fin_owner definer",
  "audit.require_event() fin_owner definer",
  "audit.row_hash(audit.event, bytea) fin_owner definer",
  "audit.sequence(integer) fin_owner definer",
  "audit.start_epoch(text, bytea, text, text, text, text) fin_owner definer",
  "audit.unsequenced_age() fin_owner definer",
  "email.enqueue(jsonb) fin_owner definer",
  "events.emit(jsonb) fin_owner definer",
  "ops.enqueue_job(text, text, jsonb, timestamp with time zone) fin_owner definer",
  "ops.set_switch(text, text, text, jsonb) fin_owner definer",
  "ops.sweep_rate_windows(interval) fin_owner definer",
  "ops.trip_switch(text, text, text, text, text, text, text) fin_owner definer",
  "ops_guard.record_privileged_login() postgres definer",
  "ops_guard.refuse_privileged_login_change() postgres invoker",
  "ops_guard.refuse_privileged_login_ddl() postgres definer",
];

describe("AC-P0-39: exactly spec 01 §6.10's objects", () => {
  it("creates exactly the tables, each owned as the spec says", async () => {
    const result = await su.query<{ row: string }>(
      `SELECT n.nspname || '.' || c.relname || ' table ' || pg_get_userbyid(c.relowner) AS row
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('identity','staff','keys','kyc','money','events','email','audit','ops','ops_guard')
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       ORDER BY 1`,
    );
    const owner = (await su.query<{ u: string }>("SELECT current_user AS u")).rows[0]?.u ?? "";
    expect(result.rows.map((r) => r.row.replace(` ${owner}`, " postgres")).sort()).toEqual(
      [...EXPECTED_RELATIONS].sort(),
    );
  });

  it("creates exactly the functions, SECURITY DEFINER with search_path pinned", async () => {
    const result = await su.query<{ row: string; config: string[] | null }>(
      `SELECT p.oid::regprocedure::text || ' ' || pg_get_userbyid(p.proowner) || ' ' ||
              CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END AS row, p.proconfig AS config
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('identity','staff','keys','kyc','money','events','email','audit','ops','ops_guard')
       ORDER BY 1`,
    );
    const owner = (await su.query<{ u: string }>("SELECT current_user AS u")).rows[0]?.u ?? "";
    expect(
      result.rows.map((r) => r.row.replace(` ${owner} `, " postgres ").replace(/,(?! )/g, ", ")),
    ).toEqual(EXPECTED_FUNCTIONS);
    for (const row of result.rows) {
      expect(
        row.config?.some((c) => c.startsWith("search_path=")),
        row.row,
      ).toBe(true);
    }
  });

  it("revokes EXECUTE on every function from PUBLIC", async () => {
    const result = await su.query<{ name: string }>(
      `SELECT p.oid::regprocedure::text AS name
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
            LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       WHERE n.nspname IN ('events','email','audit','ops','ops_guard') AND a.grantee = 0`,
    );
    expect(result.rows).toEqual([]);
  });

  it("grants exactly the fragments' matrix, and nothing to PUBLIC or to a login directly", async () => {
    const owner = await db.connect("fin_owner");
    try {
      const live = (await livePrivileges(owner)).map(
        (p) => `${p.kind} ${p.object} ${p.privilege} ${p.role}`,
      );
      const expected = expandMatrix(loadFragments(GRANTS_DIR)).map(privilegeKey);
      expect(live).toEqual(expected);
    } finally {
      await owner.end();
    }
  });

  it("creates the nine schemas owned by fin_owner with nothing for PUBLIC, and ops_guard for the superuser", async () => {
    const result = await su.query<{ name: string; owner: string; public_acl: number }>(
      `SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
              (SELECT count(*)::int FROM aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a WHERE a.grantee = 0) AS public_acl
       FROM pg_namespace n
       WHERE n.nspname IN ('identity','staff','keys','kyc','money','events','email','audit','ops','ops_guard')
       ORDER BY 1`,
    );
    expect(result.rows.map((r) => r.name)).toEqual([
      "audit",
      "email",
      "events",
      "identity",
      "keys",
      "kyc",
      "money",
      "ops",
      "ops_guard",
      "staff",
    ]);
    for (const row of result.rows) {
      expect(row.public_acl, row.name).toBe(0);
      if (row.name !== "ops_guard") expect(row.owner, row.name).toBe("fin_owner");
      else expect(row.owner).not.toBe("fin_owner");
    }
  });

  it("seeds the six kill switches off, with no whole-API switch", async () => {
    const result = await su.query<{ name: string; state: string }>(
      "SELECT name, state FROM ops.kill_switch ORDER BY name",
    );
    expect(result.rows).toEqual([
      { name: "hosted_verify", state: "off" },
      { name: "live_keys", state: "off" },
      { name: "live_money", state: "off" },
      { name: "outbound_webhooks", state: "off" },
      { name: "signups", state: "off" },
      { name: "sumsub_writes", state: "off" },
    ]);
  });

  it("seeds both scheduler leases, epoch 1's head, ops.noop and the delivery-check grant", async () => {
    expect((await su.query("SELECT name FROM ops.scheduler_lease ORDER BY name")).rows).toEqual([
      { name: "payments" },
      { name: "worker" },
    ]);
    const head = await su.query<{ epoch: number; seq: string; current: boolean; zero: boolean }>(
      "SELECT epoch, seq, current, hash = decode(repeat('00', 32), 'hex') AS zero FROM audit.head",
    );
    expect(head.rows).toEqual([{ epoch: 1, seq: "0", current: true, zero: true }]);
    expect((await su.query("SELECT kind, enqueue_roles, runner FROM ops.job_kind")).rows).toEqual([
      { kind: "ops.noop", enqueue_roles: ["fin_worker"], runner: "worker" },
    ]);
    expect(
      (await su.query("SELECT template, role, category FROM email.template_grant")).rows,
    ).toEqual([{ template: "ops/delivery-check", role: "fin_worker", category: "ops" }]);
  });

  it("records every applied file with its checksum and release", async () => {
    const files = readMigrations(MIGRATIONS_DIR);
    const result = await su.query<{ name: string; checksum: Buffer; release: string }>(
      "SELECT name, checksum, release FROM ops.schema_migrations ORDER BY name",
    );
    expect(result.rows.map((r) => r.name)).toEqual(files.map((f) => f.name));
    for (const [i, row] of result.rows.entries()) {
      expect(row.checksum.equals(files[i]?.checksum ?? Buffer.alloc(0))).toBe(true);
      expect(row.release).toBe("test-release");
    }
  });
});

describe("the runner", () => {
  it("applies nothing on a second run and leaves the grants exactly as they were", async () => {
    const before = await su.query("SELECT count(*)::int AS n FROM ops.schema_migrations");
    await db.migrate();
    const after = await su.query("SELECT count(*)::int AS n FROM ops.schema_migrations");
    expect(after.rows).toEqual(before.rows);
    const owner = await db.connect("fin_owner");
    try {
      const live = (await livePrivileges(owner)).map(
        (p) => `${p.kind} ${p.object} ${p.privilege} ${p.role}`,
      );
      expect(live).toEqual(expandMatrix(loadFragments(GRANTS_DIR)).map(privilegeKey));
    } finally {
      await owner.end();
    }
  });

  it("refuses an applied file whose content changed, and changes nothing", async () => {
    const files = readMigrations(MIGRATIONS_DIR);
    const first = files[0];
    if (first === undefined) throw new Error("no migrations");
    const changed = parseMigration(first.name, Buffer.from(`${first.sql}\n-- edited`));
    await expect(db.migrate({ files: [changed, ...files.slice(1)] })).rejects.toThrow(
      /changed after it was applied/,
    );
  });

  it("ignores an applied file it does not know (an older image on a newer schema)", async () => {
    const owner = await db.connect("fin_owner");
    try {
      await owner.query(
        "INSERT INTO ops.schema_migrations (name, checksum, release, applied_at) VALUES ($1, $2, 'newer', now())",
        ["20991231235959_ops_future.sql", Buffer.alloc(32)],
      );
    } finally {
      await owner.end();
    }
    await expect(db.migrate()).resolves.toBeUndefined();
  });

  it("rolls back every file of a run that fails, and the grants with them", async () => {
    const files = readMigrations(MIGRATIONS_DIR);
    const good = parseMigration(
      "20991231000000_ops_probe.sql",
      Buffer.from(
        "SET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '60s';\nCREATE TABLE ops.probe_table (id int);\n",
      ),
    );
    const bad = parseMigration(
      "20991231000001_ops_broken.sql",
      Buffer.from(
        "SET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '60s';\nSELECT no_such_function();\n",
      ),
    );
    await expect(db.migrate({ files: [...files, good, bad] })).rejects.toThrow();
    const exists = await su.query("SELECT to_regclass('ops.probe_table') IS NOT NULL AS found");
    expect(exists.rows).toEqual([{ found: false }]);
    const recorded = await su.query(
      "SELECT count(*)::int AS n FROM ops.schema_migrations WHERE name LIKE '2099123100000%'",
    );
    expect(recorded.rows).toEqual([{ n: 0 }]);
  });

  it("refuses a grant fragment that names an object no migration created", async () => {
    const fragments = loadFragments(GRANTS_DIR);
    const extra = {
      file: "ops.json",
      area: "ops",
      grants: [
        {
          on: "table" as const,
          name: "ops.nothing",
          privileges: ["SELECT" as const],
          to: ["fin_api" as const],
        },
      ],
    };
    await expect(db.migrate({ fragments: [...fragments, extra] })).rejects.toThrow(
      /no table ops.nothing/,
    );
  });

  it("holds the exclusive migration lock for the run, so a second runner waits", async () => {
    const owner = await db.connect("fin_owner");
    const other = await db.connect("fin_worker_a");
    try {
      await owner.query("BEGIN");
      await owner.query("LOCK TABLE ops.schema_migrations IN EXCLUSIVE MODE");
      await other.query("SET lock_timeout = '200ms'");
      // A reader is not blocked by EXCLUSIVE; a writer (another runner's insert) is.
      await expect(
        other.query("SELECT count(*) FROM ops.schema_migrations"),
      ).resolves.toBeDefined();
      const second = await db.connect("fin_owner");
      try {
        await second.query("SET lock_timeout = '200ms'");
        await second.query("BEGIN");
        const error = await second
          .query("LOCK TABLE ops.schema_migrations IN EXCLUSIVE MODE")
          .catch((e: unknown) => e);
        expect(sqlState(error)).toBe("55P03");
        await second.query("ROLLBACK");
      } finally {
        await second.end();
      }
      await owner.query("ROLLBACK");
    } finally {
      await owner.end();
      await other.end();
    }
  });
});
