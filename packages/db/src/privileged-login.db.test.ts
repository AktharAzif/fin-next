// AC-P0-11 (a failing login trigger never blocks a login), AC-P0-39 (fin_owner cannot drop, alter,
// update, delete or truncate ops.privileged_login) and the record itself (ARCHITECTURE §6.3, P-19).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

async function codeOf(client: PgClient, sql: string): Promise<string> {
  try {
    await client.query(sql);
    return "ok";
  } catch (error) {
    return sqlState(error) ?? "error";
  }
}

async function rowsFor(role: string, applicationName: string): Promise<number> {
  const result = await su.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM ops.privileged_login WHERE login_role = $1 AND application_name = $2",
    [role, applicationName],
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
    const before = await su.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ops.privileged_login WHERE login_role = current_user",
    );
    const another = await db.superuser();
    await another.end();
    const after = await su.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ops.privileged_login WHERE login_role = current_user",
    );
    expect((after.rows[0]?.n ?? 0) - (before.rows[0]?.n ?? 0)).toBe(1);
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

describe("a failing login trigger never blocks a login (P-19)", () => {
  it("lets fin_owner and the superuser in while the insert fails, and records nothing", async () => {
    await su.query(
      "ALTER TABLE ops.privileged_login ADD CONSTRAINT always_fails CHECK (false) NOT VALID",
    );
    try {
      const owner = await db.connect("fin_owner", "fin-test-broken-trigger");
      try {
        expect((await owner.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
      } finally {
        await owner.end();
      }
      const another = await db.superuser();
      expect((await another.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
      await another.end();
      expect(await rowsFor("fin_owner", "fin-test-broken-trigger")).toBe(0);
    } finally {
      await su.query("ALTER TABLE ops.privileged_login DROP CONSTRAINT always_fails");
    }
  });

  it("lets a login in even when the record's table is gone", async () => {
    await su.query("BEGIN");
    try {
      await su.query("ALTER TABLE ops.privileged_login RENAME TO privileged_login_moved");
      await su.query("COMMIT");
      const owner = await db.connect("fin_owner", "fin-test-moved");
      await owner.end();
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

  it("refuses even the superuser's UPDATE, DELETE and TRUNCATE by trigger", async () => {
    expect(await codeOf(su, "UPDATE ops.privileged_login SET login_role = 'x'")).toBe("42501");
    expect(await codeOf(su, "DELETE FROM ops.privileged_login")).toBe("42501");
    expect(await codeOf(su, "TRUNCATE ops.privileged_login CASCADE")).toBe("42501");
  });
});
