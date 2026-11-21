// AC-P0-11 (a failing login trigger never blocks a superuser's or a service's login), AC-P0-29 (no
// fin_owner login goes unrecorded), AC-P0-39 (fin_owner cannot drop, alter, update, delete or truncate
// ops.privileged_login) and the record itself (ARCHITECTURE §6.3, DECISIONS P-19); and the bootstrap
// adopting only the superuser's tables it made itself (the record and ops.environment).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrap, type Environment } from "./bootstrap.ts";
import { loadFragments } from "./grants.ts";
import { BOOTSTRAP_DIR, GRANTS_DIR } from "./migrations.ts";
import type { PgClient } from "./pg.ts";
import { sqlState } from "./pg.ts";
import {
  createTestDatabase,
  type TestDatabase,
  testReplicas,
  testVerifiers,
} from "./testing/index.ts";

// The integration timeouts, which the root Vitest configuration leaves to each file: a file's
// database is made under the cluster-wide lock that other files' bootstraps may hold.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

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

async function codeOf(client: PgClient, sql: string): Promise<string> {
  try {
    await client.query(sql);
    return "ok";
  } catch (error) {
    return sqlState(error) ?? "error";
  }
}

/** Connects, runs one query and disconnects; resolves "ok" or the refusal's SQLSTATE. */
async function loginOutcome(connect: () => Promise<PgClient>): Promise<string> {
  let client: PgClient | undefined;
  try {
    client = await connect();
    await client.query("SELECT 1");
    return "ok";
  } catch (error) {
    return sqlState(error) ?? (error instanceof Error ? error.message : "error");
  } finally {
    await client?.end().catch(() => {});
  }
}

async function rowsFor(role: string, applicationName: string): Promise<number> {
  const result = await su.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM ops.privileged_login WHERE login_role = $1 AND application_name = $2",
    [role, applicationName],
  );
  return result.rows[0]?.n ?? -1;
}

async function superuserRows(): Promise<number> {
  const result = await su.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM ops.privileged_login WHERE login_role = current_user",
  );
  return result.rows[0]?.n ?? -1;
}

describe("the privileged-login record", () => {
  it("records a fin_owner login with its application name and backend PID", async () => {
    const owner = await db.connect("fin_owner", "fin-test-owner");
    try {
      const pid = (await owner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      const row = await su.query<{ backend_pid: number }>(
        "SELECT backend_pid FROM ops.privileged_login WHERE login_role = 'fin_owner' ORDER BY id DESC LIMIT 1",
      );
      expect(row.rows[0]?.backend_pid).toBe(pid);
    } finally {
      await owner.end();
    }
    expect(await rowsFor("fin_owner", "fin-test-owner")).toBeGreaterThanOrEqual(1);
  });

  it("records a superuser login", async () => {
    const before = await superuserRows();
    const another = await db.superuser();
    await another.end();
    expect((await superuserRows()) - before).toBe(1);
  });

  it("records nothing for a service login", async () => {
    const api = await db.connect("fin_api_a", "fin-test-service");
    await api.end();
    expect(await rowsFor("fin_api_a", "fin-test-service")).toBe(0);
  });

  it("lets fin_worker read it and match it, and nobody insert into it directly", async () => {
    const worker = await db.connect("fin_worker_a");
    try {
      const latest = await worker.query<{ id: string }>(
        "SELECT id FROM ops.privileged_login ORDER BY id DESC LIMIT 1",
      );
      expect(latest.rows.length).toBe(1);
      await worker.query(
        "INSERT INTO ops.privileged_login_check (login_id, result, run_id, checked_at) VALUES ($1, 'unmatched', NULL, now())",
        [latest.rows[0]?.id],
      );
      expect(
        await codeOf(
          worker,
          "INSERT INTO ops.privileged_login (login_role, backend_pid, logged_in_at) VALUES ('x', 1, now())",
        ),
      ).toBe("42501");
    } finally {
      await worker.end();
    }
  });
});

describe("no fin_owner login goes unrecorded, whatever session settings the client chooses", () => {
  it("refuses a fin_owner login that starts read-only, so it cannot record and then write", async () => {
    const outcome = await loginOutcome(() =>
      db.connect("fin_owner", "fin-test-read-only", "-c default_transaction_read_only=on"),
    );
    expect(outcome).toBe("42501");
    expect(await rowsFor("fin_owner", "fin-test-read-only")).toBe(0);
  });

  it("still lets the superuser in when it starts read-only (P-19), and fin_owner in a normal start", async () => {
    expect(await loginOutcome(() => db.superuser("-c default_transaction_read_only=on"))).toBe(
      "ok",
    );
    expect(await loginOutcome(() => db.connect("fin_owner", "fin-test-normal"))).toBe("ok");
    expect(await rowsFor("fin_owner", "fin-test-normal")).toBe(1);
  });

  it("bounds the wait on a lock held on the record: the superuser gets in, fin_owner is refused", async () => {
    // fin_owner holds REFERENCES on the record's ID (for ops.privileged_login_check), so it can lock
    // the table by creating a foreign key to it and keeping its transaction open.
    const holder = await db.connect("fin_owner", "fin-test-lock-holder");
    try {
      await holder.query("BEGIN");
      await holder.query(
        "CREATE TABLE ops.lock_probe (id bigint REFERENCES ops.privileged_login (id))",
      );
      const started = Date.now();
      expect(await loginOutcome(() => db.superuser())).toBe("ok");
      expect(Date.now() - started).toBeLessThan(5_000);
      const owner = await loginOutcome(() =>
        db.connect("fin_owner", "fin-test-locked-out", "-c lock_timeout=1ms"),
      );
      expect(owner).toBe("42501");
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
    expect(await rowsFor("fin_owner", "fin-test-locked-out")).toBe(0);
  });
});

describe("a failing login trigger never blocks the superuser or a service (P-19)", () => {
  it("lets the superuser and a service in while the insert fails, and refuses fin_owner", async () => {
    await su.query(
      "ALTER TABLE ops.privileged_login ADD CONSTRAINT always_fails CHECK (false) NOT VALID",
    );
    try {
      expect(await loginOutcome(() => db.superuser())).toBe("ok");
      expect(await loginOutcome(() => db.connect("fin_api_a", "fin-test-broken-trigger"))).toBe(
        "ok",
      );
      expect(await loginOutcome(() => db.connect("fin_owner", "fin-test-broken-trigger"))).toBe(
        "42501",
      );
      expect(await rowsFor("fin_owner", "fin-test-broken-trigger")).toBe(0);
    } finally {
      await su.query("ALTER TABLE ops.privileged_login DROP CONSTRAINT always_fails");
    }
  });

  it("lets a login in even when the record's table is gone (only the superuser can move it)", async () => {
    await su.query("BEGIN");
    try {
      await su.query("ALTER TABLE ops.privileged_login RENAME TO privileged_login_moved");
      await su.query("COMMIT");
      expect(await loginOutcome(() => db.connect("fin_owner", "fin-test-moved"))).toBe("ok");
      expect(await loginOutcome(() => db.superuser())).toBe("ok");
    } finally {
      await su.query("ROLLBACK").catch(() => {});
      await su
        .query("ALTER TABLE ops.privileged_login_moved RENAME TO privileged_login")
        .catch(() => {});
    }
    expect(
      (await su.query("SELECT to_regclass('ops.privileged_login') IS NOT NULL AS ok")).rows,
    ).toEqual([{ ok: true }]);
  });
});

describe("AC-P0-39: fin_owner cannot remove or change the record", () => {
  it("refuses fin_owner's DROP, ALTER, UPDATE, DELETE and TRUNCATE", async () => {
    const owner = await db.connect("fin_owner");
    try {
      expect(await codeOf(owner, "DROP TABLE ops.privileged_login CASCADE")).toBe("42501");
      expect(await codeOf(owner, "ALTER TABLE ops.privileged_login DISABLE TRIGGER ALL")).toBe(
        "42501",
      );
      expect(await codeOf(owner, "ALTER TABLE ops.privileged_login RENAME TO gone")).toBe("42501");
      expect(await codeOf(owner, "UPDATE ops.privileged_login SET login_role = 'x'")).toBe("42501");
      expect(await codeOf(owner, "DELETE FROM ops.privileged_login")).toBe("42501");
      expect(await codeOf(owner, "TRUNCATE ops.privileged_login")).toBe("42501");
    } finally {
      await owner.end();
    }
  });

  it("refuses fin_owner's drop or rename of the ops schema, and any reach into ops_guard", async () => {
    const owner = await db.connect("fin_owner");
    try {
      expect(await codeOf(owner, "DROP SCHEMA ops CASCADE")).toBe("42501");
      expect(await codeOf(owner, "ALTER SCHEMA ops RENAME TO ops_moved")).toBe("42501");
      expect(await codeOf(owner, "DROP FUNCTION ops_guard.record_privileged_login() CASCADE")).toBe(
        "42501",
      );
      expect(await codeOf(owner, "DROP EVENT TRIGGER fin_privileged_login")).toBe("42501");
      expect(await codeOf(owner, "ALTER EVENT TRIGGER fin_privileged_login DISABLE")).toBe("42501");
      // Ordinary DDL by the owner still works (the guard must not block migrations).
      expect(
        await codeOf(
          owner,
          "CREATE TABLE ops.owner_scratch (id int); DROP TABLE ops.owner_scratch",
        ),
      ).toBe("ok");
    } finally {
      await owner.end();
    }
    expect((await su.query("SELECT to_regnamespace('ops') IS NOT NULL AS ok")).rows).toEqual([
      { ok: true },
    ]);
  });

  it("refuses fin_owner any change to ops.environment, and the superuser's UPDATE by trigger", async () => {
    const owner = await db.connect("fin_owner");
    try {
      expect((await owner.query("SELECT name FROM ops.environment")).rows).toEqual([
        { name: "ci" },
      ]);
      expect(await codeOf(owner, "UPDATE ops.environment SET name = 'production'")).toBe("42501");
      expect(await codeOf(owner, "DROP TABLE ops.environment")).toBe("42501");
      expect(await codeOf(owner, "ALTER TABLE ops.environment RENAME TO gone")).toBe("42501");
    } finally {
      await owner.end();
    }
    expect(await codeOf(su, "UPDATE ops.environment SET name = 'production'")).toBe("42501");
    expect(await codeOf(su, "DELETE FROM ops.environment")).toBe("42501");
  });

  it("refuses even the superuser's UPDATE, DELETE and TRUNCATE by trigger", async () => {
    expect(await codeOf(su, "UPDATE ops.privileged_login SET login_role = 'x'")).toBe("42501");
    expect(await codeOf(su, "DELETE FROM ops.privileged_login")).toBe("42501");
    expect(await codeOf(su, "TRUNCATE ops.privileged_login CASCADE")).toBe("42501");
  });
});

/** Runs the bootstrap again on a test database; resolves "ok" or the refusal's message. */
async function bootstrapAgain(target: TestDatabase, environment: Environment): Promise<string> {
  return target.withLock(async () => {
    const again = await target.superuser();
    try {
      await bootstrap(again, {
        verifiers: testVerifiers(),
        replicas: testReplicas(),
        environment,
        bootstrapDir: BOOTSTRAP_DIR,
        fragments: loadFragments(GRANTS_DIR),
      });
      return "ok";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      await again.end();
    }
  });
}

async function ownerOf(client: PgClient, table: string): Promise<string | undefined> {
  const result = await client.query<{ owner: string }>(
    "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = to_regclass($1)",
    [table],
  );
  return result.rows[0]?.owner;
}

describe("the bootstrap adopts only the superuser's tables it made itself", () => {
  // fin_owner owns `ops`: when the superuser's table is missing (a database bootstrapped before the
  // file that makes it, or the table dropped by hand), fin_owner can create one of that name first,
  // shaped to hide or swallow rows, and an ownership change would keep every part of it.
  let scratch: TestDatabase | undefined;
  let scratchSu: PgClient | undefined;

  afterAll(async () => {
    await scratchSu?.end();
    await scratch?.drop();
  });

  it("runs again on its own tables, and refuses an ops.environment fin_owner created", async () => {
    scratch = await createTestDatabase({ prefix: "p0e", migrate: false });
    scratchSu = await scratch.superuser();
    expect(await bootstrapAgain(scratch, "ci")).toBe("ok");
    await scratchSu.query("DROP TABLE ops.environment");
    const owner = await scratch.connect("fin_owner");
    try {
      for (const sql of [
        "CREATE TABLE ops.environment (only_row boolean PRIMARY KEY DEFAULT true, name text NOT NULL, recorded_at timestamptz NOT NULL)",
        "CREATE TABLE ops.environment_shadow () INHERITS (ops.environment)",
        "INSERT INTO ops.environment_shadow VALUES (false, 'staging', now())",
        "ALTER TABLE ops.environment ENABLE ROW LEVEL SECURITY",
        "CREATE POLICY only_fake ON ops.environment FOR SELECT USING (name <> 'production')",
      ]) {
        expect(await codeOf(owner, sql), sql).toBe("ok");
      }
    } finally {
      await owner.end();
    }
    expect(await bootstrapAgain(scratch, "production")).toMatch(
      /ops\.environment exists but is not the bootstrap's own table/,
    );
    // Nothing was adopted: the table is still fin_owner's, and no row says production.
    expect(await ownerOf(scratchSu, "ops.environment")).toBe("fin_owner");
    expect(
      (
        await scratchSu.query(
          "SELECT count(*)::int AS n FROM ops.environment WHERE name = 'production'",
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  });

  it("refuses an ops.privileged_login fin_owner created, so no rule of its own can swallow the records", async () => {
    const target = await createTestDatabase({ prefix: "p0e", migrate: false });
    const targetSu = await target.superuser();
    try {
      await targetSu.query("DROP TABLE ops.privileged_login");
      const owner = await target.connect("fin_owner");
      try {
        for (const sql of [
          "CREATE TABLE ops.privileged_login (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, login_role text NOT NULL, application_name text, client_addr inet, backend_pid integer NOT NULL, logged_in_at timestamptz NOT NULL)",
          "CREATE RULE swallow AS ON INSERT TO ops.privileged_login DO INSTEAD NOTHING",
        ]) {
          expect(await codeOf(owner, sql), sql).toBe("ok");
        }
      } finally {
        await owner.end();
      }
      expect(await bootstrapAgain(target, "ci")).toMatch(
        /ops\.privileged_login exists but is not the bootstrap's own table/,
      );
      expect(await ownerOf(targetSu, "ops.privileged_login")).toBe("fin_owner");
    } finally {
      await targetSu.end();
      await target.drop();
    }
  });
});
