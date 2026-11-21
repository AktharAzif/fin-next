// The audit schema's SQL (spec 08 §3.3, §3.5 to §3.10): audit.record()'s refusals and stamps (T08-03),
// immutability for every login including fin_owner and the superuser, by DML and by DDL (T08-05,
// AC-P0-11), the sequencer's gapless chaining with no writer waiting on another (T08-10), epochs and
// the environment's refusals (T08-15, §3.9), and the journal and anchor functions. recordAudit, the
// registry and the TypeScript hash are @fin/audit's.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgClient } from "./pg.ts";
import { sqlState } from "./pg.ts";
import {
  createTestDatabase,
  registerEventTypes,
  type TestDatabase,
  testContext,
  testId,
} from "./testing/index.ts";

let db: TestDatabase;
let su: PgClient;

beforeAll(async () => {
  db = await createTestDatabase({ prefix: "p0e" });
  su = await db.superuser();
  const owner = await db.connect("fin_owner");
  try {
    await registerEventTypes(owner, [
      {
        name: "test.org_thing",
        roles: ["fin_api", "fin_console"],
        scope: "organisation",
        category: "organisation",
        journalKind: "member_removed",
      },
      { name: "test.person_thing", roles: ["fin_console"], scope: "person", category: "security" },
      {
        name: "test.staff_thing",
        roles: ["fin_admin", "fin_worker", "fin_owner"],
        scope: "staff",
        category: "staff",
      },
      {
        name: "test.staff_removed",
        roles: ["fin_admin", "fin_worker"],
        scope: "staff",
        category: "staff",
        journalKind: "staff_removed",
      },
      { name: "test.retired_thing", roles: ["fin_api"], scope: "staff", retired: true },
      { name: "audit.epoch_started", roles: ["fin_owner"], scope: "staff", category: "system" },
    ]);
  } finally {
    await owner.end();
  }
});

afterAll(async () => {
  await su?.end();
  await db?.drop();
});

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: testId("aud"),
    event: "test.staff_thing",
    actor_kind: "staff",
    actor_id: testId("stf"),
    actor_via: "admin",
    target_id: "target-1",
    release: "test-release",
    ...overrides,
  };
}

async function record(client: PgClient, value: Record<string, unknown>): Promise<string> {
  try {
    const result = await client.query<{ id: string }>("SELECT audit.record($1::jsonb) AS id", [
      JSON.stringify(value),
    ]);
    return result.rows[0]?.id ?? "none";
  } catch (error) {
    return sqlState(error) ?? String(error);
  }
}

async function withClient<T>(
  login: string,
  fn: (client: PgClient) => Promise<T>,
  applicationName?: string,
): Promise<T> {
  const client = await db.connect(login, applicationName);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function codeOf(client: PgClient, sql: string, values?: unknown[]): Promise<string> {
  try {
    await client.query(sql, values);
    return "ok";
  } catch (error) {
    return sqlState(error) ?? String(error);
  }
}

describe("audit.record() refusals (T08-03)", () => {
  it("refuses an unknown or retired event (FA001)", async () => {
    await withClient("fin_api_a", async (api) => {
      expect(await record(api, input({ event: "test.no_such" }))).toBe("FA001");
      expect(await record(api, input({ event: "test.retired_thing" }))).toBe("FA001");
    });
  });

  it("refuses an event whose roles do not include the login's group (FA002)", async () => {
    await withClient("fin_payments_a", async (payments) => {
      expect(await record(payments, input())).toBe("FA002");
    });
    await withClient("fin_console_a", async (console) => {
      expect(await record(console, input())).toBe("FA002");
    });
  });

  it("refuses an organisation event without organization_id and a person event without subject_user_id (FA003)", async () => {
    await withClient("fin_console_a", async (console) => {
      expect(await record(console, input({ event: "test.org_thing" }))).toBe("FA003");
      expect(await record(console, input({ event: "test.person_thing" }))).toBe("FA003");
      expect(
        await record(console, input({ event: "test.org_thing", organization_id: testId("org") })),
      ).toMatch(/^aud_/);
    });
  });

  it("refuses metadata that is not a flat object of short values (FA004)", async () => {
    await withClient("fin_admin_a", async (admin) => {
      for (const metadata of [
        [],
        { nested: { a: 1 } },
        { list: [{ a: 1 }] },
        { long: "x".repeat(201) },
        { many: Array.from({ length: 51 }, () => 1) },
        { "Bad-Key": 1 },
        { big: Array.from({ length: 50 }, () => "y".repeat(100)) },
      ]) {
        expect(
          await record(admin, input({ metadata })),
          JSON.stringify(metadata).slice(0, 40),
        ).toBe("FA004");
      }
      expect(
        await record(admin, input({ metadata: { a: "x", b: 1, c: true, d: null, e: ["p", 2] } })),
      ).toMatch(/^aud_/);
    });
  });

  it("refuses more than 32 refs, a ref that is not an ID string, and a malformed ID (FA005)", async () => {
    await withClient("fin_admin_a", async (admin) => {
      expect(
        await record(admin, input({ ref_ids: Array.from({ length: 33 }, (_, i) => `r${i}`) })),
      ).toBe("FA005");
      expect(await record(admin, input({ ref_ids: [1] }))).toBe("FA005");
      expect(await record(admin, input({ ref_ids: "r1" }))).toBe("FA005");
      expect(await record(admin, input({ id: "aud_short" }))).toBe("FA005");
      expect(await record(admin, input({ id: testId("evt") }))).toBe("FA005");
    });
  });

  it("refuses any other key, a missing field or a value outside its list (FA006)", async () => {
    await withClient("fin_admin_a", async (admin) => {
      for (const bad of [
        input({ db_login: "fin_owner" }),
        input({ recorded_at: "2020-01-01" }),
        input({ target_id: undefined }),
        input({ release: undefined }),
        input({ actor_kind: "root" }),
        input({ actor_via: "shell" }),
        input({ mode: "prod" }),
        input({ step_up_kind: "intent" }),
        input({ actor_id: 7 }),
        input({ context: { client_ip: "not an ip" } }),
        input({ context: { client_ip: "192.0.2.1", referrer: "x" } }),
      ]) {
        expect(await record(admin, bad), JSON.stringify(bad).slice(0, 60)).toBe("FA006");
      }
    });
  });
});

describe("what audit.record() stamps", () => {
  it("stamps the login, application name, backend PID, transaction ID and time, and the registry's scope", async () => {
    const id = testId("aud");
    const facts = await withClient(
      "fin_admin_a",
      async (admin) => {
        await admin.query("BEGIN");
        const tx = await admin.query<{ pid: number; xid: string }>(
          "SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid",
        );
        await record(admin, input({ id, event: "test.staff_thing" }));
        await admin.query("COMMIT");
        return tx.rows[0];
      },
      "fin-admin",
    );
    const row = await su.query(
      "SELECT db_login, app_name, backend_pid, xid::text AS xid, scope, category, epoch, seq FROM audit.event WHERE id = $1",
      [id],
    );
    expect(row.rows).toEqual([
      {
        db_login: "fin_admin_a",
        app_name: "fin-admin",
        backend_pid: facts?.pid,
        xid: facts?.xid,
        scope: "staff",
        category: "staff",
        epoch: 1,
        seq: null,
      },
    ]);
  });

  it("keeps a context row for console and Fin Admin actors only", async () => {
    const adminId = testId("aud");
    const jobId = testId("aud");
    await withClient("fin_admin_a", (admin) =>
      record(
        admin,
        input({ id: adminId, context: { client_ip: "192.0.2.10", user_agent: "Browser/1.0" } }),
      ),
    );
    await withClient("fin_worker_a", (worker) =>
      record(
        worker,
        input({
          id: jobId,
          actor_kind: "system",
          actor_id: null,
          actor_via: "job",
          context: { client_ip: "192.0.2.10" },
        }),
      ),
    );
    const rows = await su.query(
      "SELECT event_id, host(client_ip) AS ip, user_agent FROM audit.event_context WHERE event_id = ANY ($1) ORDER BY event_id",
      [[adminId, jobId]],
    );
    expect(rows.rows).toEqual([{ event_id: adminId, ip: "192.0.2.10", user_agent: "Browser/1.0" }]);
  });

  it("sends NOTIFY audit_written for the sequencer", async () => {
    const listener = await db.connect("fin_worker_a");
    try {
      await listener.query("LISTEN audit_written");
      const notified = new Promise<string>((resolve) =>
        listener.on("notification", (m) => resolve(m.channel)),
      );
      await withClient("fin_admin_a", (admin) => record(admin, input()));
      expect(await notified).toBe("audit_written");
    } finally {
      await listener.end();
    }
  });
});

describe("immutability (T08-05, AC-P0-11: no role can update or delete audit rows)", () => {
  let chained: string;
  let unchained: string;

  beforeAll(async () => {
    chained = await withClient("fin_admin_a", (admin) => record(admin, input()));
    await withClient("fin_worker_a", (worker) => worker.query("SELECT audit.sequence(50000)"));
    unchained = await withClient("fin_admin_a", (admin) => record(admin, input()));
  });

  it("refuses every service login any write on any audit table (42501)", async () => {
    for (const login of [
      "fin_api_a",
      "fin_worker_a",
      "fin_payments_a",
      "fin_console_a",
      "fin_admin_a",
      "fin_edge_a",
    ]) {
      await withClient(login, async (client) => {
        for (const sql of [
          "UPDATE audit.event SET target_id = 'x' WHERE id = $1",
          "DELETE FROM audit.event WHERE id = $1",
          "UPDATE audit.head SET seq = 0 WHERE $1::text IS NOT NULL",
          "DELETE FROM audit.event_context WHERE event_id = $1",
        ]) {
          expect(await codeOf(client, sql, [chained]), `${login}: ${sql}`).toBe("42501");
        }
        expect(await codeOf(client, "TRUNCATE audit.event"), login).toBe("42501");
      });
    }
  });

  it("refuses fin_owner and the superuser an update of a chained row, any delete and any truncate", async () => {
    const owner = await db.connect("fin_owner");
    try {
      for (const client of [owner, su]) {
        expect(
          await codeOf(client, "UPDATE audit.event SET target_id = 'x' WHERE id = $1", [chained]),
        ).toBe("42501");
        expect(
          await codeOf(client, "UPDATE audit.event SET seq = seq + 100 WHERE id = $1", [chained]),
        ).toBe("42501");
        expect(
          await codeOf(client, "UPDATE audit.event SET hash = sha256('x') WHERE id = $1", [
            chained,
          ]),
        ).toBe("42501");
        expect(await codeOf(client, "DELETE FROM audit.event WHERE id = $1", [unchained])).toBe(
          "42501",
        );
        expect(await codeOf(client, "TRUNCATE audit.event CASCADE")).toBe("42501");
        expect(
          await codeOf(client, "UPDATE audit.event SET target_id = 'x' WHERE id = $1", [unchained]),
        ).toBe("42501");
        expect(
          await codeOf(client, "DELETE FROM audit.event_type WHERE name = 'test.staff_thing'"),
        ).toBe("42501");
        expect(await codeOf(client, "UPDATE audit.head SET seq = 0 WHERE current")).toBe("42501");
        expect(await codeOf(client, "DELETE FROM audit.head")).toBe("42501");
      }
    } finally {
      await owner.end();
    }
  });

  it("refuses the superuser setting the chain fields itself (only fin_owner's sequencer may)", async () => {
    expect(
      await codeOf(
        su,
        "UPDATE audit.event SET seq = 999999, prev_hash = sha256('a'), hash = sha256('b') WHERE id = $1",
        [unchained],
      ),
    ).toBe("42501");
  });

  it("refuses fin_owner the DDL that would switch a protection off, so no row can be changed that way", async () => {
    const guard = await su.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger WHERE tgrelid = 'ops.kill_switch'::regclass AND tgname LIKE 'audit_guard_%' ORDER BY tgname LIMIT 1",
    );
    const guardTrigger = guard.rows[0]?.tgname ?? "missing";
    const owner = await db.connect("fin_owner");
    try {
      for (const sql of [
        "ALTER TABLE audit.event DISABLE TRIGGER event_append_only",
        "ALTER TABLE audit.event DISABLE TRIGGER USER",
        "ALTER TABLE audit.event ENABLE REPLICA TRIGGER event_append_only",
        "DROP TRIGGER event_append_only ON audit.event",
        "CREATE OR REPLACE TRIGGER event_append_only BEFORE INSERT ON audit.event FOR EACH ROW EXECUTE FUNCTION audit.append_only()",
        "ALTER TRIGGER event_append_only ON audit.event RENAME TO event_moved",
        "CREATE OR REPLACE FUNCTION audit.append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN coalesce(NEW, OLD); END $$",
        "ALTER FUNCTION audit.append_only() SET search_path = audit, pg_temp",
        "DROP FUNCTION audit.append_only() CASCADE",
        "CREATE OR REPLACE FUNCTION audit.require_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$",
        "ALTER TABLE audit.event ALTER COLUMN target_id TYPE text USING 'rewritten'",
        "ALTER TABLE audit.anchor_conflict SET UNLOGGED",
        "ALTER TABLE audit.event DROP COLUMN request_id",
        "DROP TABLE audit.event_context",
        "DROP SCHEMA audit CASCADE",
        "ALTER TABLE ops.kill_switch DISABLE TRIGGER USER",
        `DROP TRIGGER "${guardTrigger}" ON ops.kill_switch`,
        "DROP TABLE ops.kill_switch",
      ]) {
        expect(await codeOf(owner, sql), sql).toBe("42501");
      }
      // With every protection in place, the rows are as they were and still cannot be changed.
      expect(
        await codeOf(owner, "UPDATE audit.event SET target_id = 'x' WHERE id = $1", [chained]),
      ).toBe("42501");
    } finally {
      await owner.end();
    }
    expect(
      (
        await su.query("SELECT target_id FROM audit.event WHERE id = ANY ($1)", [
          [chained, unchained],
        ])
      ).rows,
    ).toEqual([{ target_id: "target-1" }, { target_id: "target-1" }]);
    const triggers = await su.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger t
       WHERE t.tgfoid IN ('audit.append_only()'::regprocedure, 'audit.require_event()'::regprocedure)
         AND t.tgenabled <> 'O'`,
    );
    expect(triggers.rows).toEqual([{ n: 0 }]);
  });

  it("lets fin_owner add to the audit trail: a table, an index, a column, and the same guard again", async () => {
    const owner = await db.connect("fin_owner");
    try {
      for (const sql of [
        "CREATE TABLE audit.ddl_scratch (id int)",
        "DROP TABLE audit.ddl_scratch",
        "CREATE INDEX event_release_scratch ON audit.event (release)",
        "DROP INDEX audit.event_release_scratch",
        "ALTER TABLE audit.anchor_conflict ADD COLUMN scratch_note text",
        "COMMENT ON FUNCTION audit.append_only() IS 'append-only'",
        "SELECT audit.install_guard('ops.kill_switch'::regclass, ARRAY['INSERT', 'UPDATE OF state'], 'name', ARRAY['switch.set', 'switch.cleared', 'switch.tripped'])",
      ]) {
        expect(await codeOf(owner, sql), sql).toBe("ok");
      }
      // Adding is allowed; taking the column away again is a drop from an append-only table.
      expect(
        await codeOf(owner, "ALTER TABLE audit.anchor_conflict DROP COLUMN scratch_note"),
      ).toBe("42501");
    } finally {
      await owner.end();
    }
    const guards = await su.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'ops.kill_switch'::regclass AND tgname LIKE 'audit_guard_%'",
    );
    expect(guards.rows).toEqual([{ n: 2 }]);
  });

  it("lets the superuser change a protection on purpose, which becomes the record fin_owner is held to", async () => {
    await su.query("ALTER TABLE audit.anchor_conflict DROP COLUMN scratch_note");
    await su.query("ALTER TABLE audit.anchor DISABLE TRIGGER anchor_append_only");
    const owner = await db.connect("fin_owner");
    try {
      expect(await codeOf(owner, "CREATE TABLE audit.ddl_scratch (id int)")).toBe("ok");
      expect(
        await codeOf(owner, "ALTER TABLE audit.anchor ENABLE TRIGGER anchor_append_only"),
      ).toBe("42501");
      await su.query("ALTER TABLE audit.anchor ENABLE TRIGGER anchor_append_only");
      expect(await codeOf(owner, "DROP TABLE audit.ddl_scratch")).toBe("ok");
      expect(
        await codeOf(owner, "ALTER TABLE audit.anchor DISABLE TRIGGER anchor_append_only"),
      ).toBe("42501");
    } finally {
      await owner.end();
    }
  });
});

describe("the sequencer (T08-10, §3.6)", () => {
  it("chains committed rows gaplessly and links each to the one before", async () => {
    await withClient("fin_admin_a", async (admin) => {
      for (let i = 0; i < 5; i++) await record(admin, input({ metadata: { i } }));
    });
    await withClient("fin_worker_a", (worker) => worker.query("SELECT audit.sequence(50000)"));
    const rows = await su.query<{ seq: string; prev_hash: Buffer; hash: Buffer }>(
      "SELECT seq, prev_hash, hash FROM audit.event WHERE epoch = 1 ORDER BY seq",
    );
    expect(rows.rows.length).toBeGreaterThan(5);
    let previous: Buffer = Buffer.alloc(32);
    for (const [i, row] of rows.rows.entries()) {
      expect(Number(row.seq)).toBe(i + 1);
      expect(row.prev_hash.equals(previous)).toBe(true);
      previous = row.hash;
    }
    const head = await su.query<{ seq: string; hash: Buffer }>(
      "SELECT seq, hash FROM audit.head WHERE current",
    );
    expect(Number(head.rows[0]?.seq)).toBe(rows.rows.length);
    expect(head.rows[0]?.hash.equals(previous)).toBe(true);
    const recomputed = await su.query<{ ok: boolean }>(
      "SELECT bool_and(audit.row_hash(e, e.prev_hash) = e.hash) AS ok FROM audit.event e WHERE seq IS NOT NULL",
    );
    expect(recomputed.rows[0]?.ok).toBe(true);
  });

  it("lets two hundred audited transactions commit without waiting on each other, then chains them all", async () => {
    const holder = await db.connect("fin_admin_a");
    try {
      // A transaction held open with an audit row must not block anyone else's audited commit.
      await holder.query("BEGIN");
      const heldId = await record(holder, input());
      const admin = db.database("fin_admin");
      const started = Date.now();
      await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          admin.unit(testContext(), (tx) =>
            tx.query("SELECT audit.record($1::jsonb)", [
              JSON.stringify(input({ id: tx.ids.newId("aud"), metadata: { i } })),
            ]),
          ),
        ),
      );
      expect(Date.now() - started).toBeLessThan(15_000);
      const worker = await db.connect("fin_worker_a");
      try {
        const first = await worker.query<{ n: number }>("SELECT audit.sequence(50000) AS n");
        expect(first.rows[0]?.n).toBe(200);
        await holder.query("COMMIT");
        const second = await worker.query<{ n: number }>("SELECT audit.sequence(50000) AS n");
        expect(second.rows[0]?.n).toBe(1);
        const held = await su.query<{ seq: string }>("SELECT seq FROM audit.event WHERE id = $1", [
          heldId,
        ]);
        expect(held.rows[0]?.seq).not.toBeNull();
      } finally {
        await worker.end();
      }
      const gaps = await su.query<{ n: number; max: string }>(
        "SELECT count(*)::int AS n, max(seq)::text AS max FROM audit.event WHERE epoch = 1 AND seq IS NOT NULL",
      );
      expect(String(gaps.rows[0]?.n)).toBe(gaps.rows[0]?.max);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  });

  it("reports the age of the oldest unchained row to the probe, 0 when none", async () => {
    await withClient("fin_worker_a", (worker) => worker.query("SELECT audit.sequence(50000)"));
    await withClient("fin_probe", async (probe) => {
      expect((await probe.query("SELECT audit.unsequenced_age() AS age")).rows).toEqual([
        { age: 0 },
      ]);
    });
    await withClient("fin_owner", (owner) =>
      owner.query(
        "INSERT INTO audit.event (id, epoch, event, category, scope, actor_kind, actor_via, target_id, release, db_login, app_name, backend_pid, xid, recorded_at) VALUES ($1, 1, 'test.staff_thing', 'staff', 'staff', 'system', 'job', 't', 'r', 'fin_owner', '', 1, pg_current_xact_id(), now() - interval '90 seconds')",
        [testId("aud")],
      ),
    );
    await withClient("fin_probe", async (probe) => {
      const age =
        (await probe.query<{ age: number }>("SELECT audit.unsequenced_age() AS age")).rows[0]
          ?.age ?? 0;
      expect(age).toBeGreaterThanOrEqual(90);
      expect(await codeOf(probe, "SELECT audit.sequence(1)")).toBe("42501");
    });
    await withClient("fin_worker_a", (worker) => worker.query("SELECT audit.sequence(50000)"));
  });
});

describe("epochs (T08-15, §3.9)", () => {
  const START = "SELECT audit.start_epoch($1, $2, $3, $4, 'run_test', 'test-release', $5) AS epoch";

  async function unchainedCount(): Promise<number> {
    const result = await su.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit.event WHERE seq IS NULL",
    );
    return result.rows[0]?.n ?? -1;
  }

  it("chains the old epoch's remaining rows into it, then starts the new one with audit.epoch_started first", async () => {
    // A committed row the sequencer has not reached yet, as a restored database always holds a few.
    const leftover = await withClient("fin_admin_a", (admin) => record(admin, input()));
    const prev = Buffer.alloc(32, 7);
    const eventId = testId("aud");
    await withClient("fin_owner", async (owner) => {
      const result = await owner.query<{ epoch: number }>(START, [
        "reset",
        prev,
        "ops/reset/20261121T120000Z.json",
        eventId,
        "ci",
      ]);
      expect(result.rows[0]?.epoch).toBe(2);
    });
    const left = await su.query<{ epoch: number; seq: string | null }>(
      "SELECT epoch, seq FROM audit.event WHERE id = $1",
      [leftover],
    );
    expect(left.rows[0]?.epoch).toBe(1);
    expect(left.rows[0]?.seq).not.toBeNull();
    const heads = await su.query("SELECT epoch, seq, current FROM audit.head ORDER BY epoch");
    expect(heads.rows).toEqual([
      { epoch: 1, seq: left.rows[0]?.seq, current: false },
      { epoch: 2, seq: "1", current: true },
    ]);
    // Nothing is left outside the chain, so the probe's age has nothing to report.
    expect(await unchainedCount()).toBe(0);
    await withClient("fin_probe", async (probe) => {
      expect((await probe.query("SELECT audit.unsequenced_age() AS age")).rows).toEqual([
        { age: 0 },
      ]);
    });
    const first = await su.query<{
      id: string;
      seq: string;
      prev_hash: Buffer;
      metadata: unknown;
    }>("SELECT id, seq, prev_hash, metadata FROM audit.event WHERE epoch = 2 ORDER BY seq LIMIT 1");
    expect(first.rows[0]?.id).toBe(eventId);
    expect(first.rows[0]?.seq).toBe("1");
    expect(first.rows[0]?.prev_hash.equals(prev)).toBe(true);
    expect(first.rows[0]?.metadata).toEqual({
      reason: "reset",
      previousEpoch: 1,
      previousSeq: Number(left.rows[0]?.seq),
      markerKey: "ops/reset/20261121T120000Z.json",
    });
  });

  it("waits for a transaction that recorded a row in the old epoch, and chains that row there", async () => {
    const holder = await db.connect("fin_admin_a");
    let heldId = "";
    try {
      await holder.query("BEGIN");
      heldId = await record(holder, input());
      const starting = withClient("fin_owner", (owner) =>
        owner.query<{ epoch: number }>(START, [
          "reset",
          Buffer.alloc(32, 8),
          "ops/reset/20261121T130000Z.json",
          testId("aud"),
          "ci",
        ]),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Still epoch 2: the start waits for the open transaction rather than leaving its row behind.
      expect((await su.query("SELECT epoch FROM audit.head WHERE current")).rows).toEqual([
        { epoch: 2 },
      ]);
      await holder.query("COMMIT");
      expect((await starting).rows[0]?.epoch).toBe(3);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
    const held = await su.query<{ epoch: number; seq: string | null }>(
      "SELECT epoch, seq FROM audit.event WHERE id = $1",
      [heldId],
    );
    expect(held.rows[0]?.epoch).toBe(2);
    expect(held.rows[0]?.seq).not.toBeNull();
    // A row recorded once the new epoch has started carries it, and the sequencer chains it.
    const later = await withClient("fin_admin_a", (admin) => record(admin, input()));
    expect((await su.query("SELECT epoch FROM audit.event WHERE id = $1", [later])).rows).toEqual([
      { epoch: 3 },
    ]);
    await withClient("fin_worker_a", (worker) => worker.query("SELECT audit.sequence(50000)"));
    expect(await unchainedCount()).toBe(0);
  });

  it("refuses a reset in production, and any start whose environment is not the database's (FA012)", async () => {
    await withClient("fin_owner", async (owner) => {
      for (const environment of ["production", "staging", null]) {
        expect(
          await codeOf(owner, START, [
            "restore",
            Buffer.alloc(32),
            "ops/restore/x.json",
            testId("aud"),
            environment,
          ]),
          String(environment),
        ).toBe("FA012");
      }
    });
    // A production database: the row is the bootstrap's, so the test changes it as the superuser.
    await su.query("ALTER TABLE ops.environment DISABLE TRIGGER environment_unchanged");
    try {
      await su.query("UPDATE ops.environment SET name = 'production'");
      await withClient("fin_owner", async (owner) => {
        expect(
          await codeOf(owner, START, [
            "reset",
            Buffer.alloc(32),
            "ops/reset/x.json",
            testId("aud"),
            "production",
          ]),
        ).toBe("FA012");
      });
      await su.query("DELETE FROM ops.environment");
      await withClient("fin_owner", async (owner) => {
        expect(
          await codeOf(owner, START, [
            "restore",
            Buffer.alloc(32),
            "ops/restore/x.json",
            testId("aud"),
            "ci",
          ]),
        ).toBe("FA012");
      });
    } finally {
      await su.query(
        "INSERT INTO ops.environment (only_row, name, recorded_at) VALUES (true, 'ci', now()) ON CONFLICT (only_row) DO UPDATE SET name = 'ci'",
      );
      await su.query("ALTER TABLE ops.environment ENABLE TRIGGER environment_unchanged");
    }
    expect((await su.query("SELECT epoch FROM audit.head WHERE current")).rows).toEqual([
      { epoch: 3 },
    ]);
  });

  it("refuses a start for any role but fin_owner, a bad reason, a short hash or a bad marker", async () => {
    await withClient("fin_worker_a", async (worker) => {
      expect(
        await codeOf(worker, START, [
          "reset",
          Buffer.alloc(32),
          "ops/reset/x.json",
          testId("aud"),
          "ci",
        ]),
      ).toBe("42501");
    });
    await withClient("fin_owner", async (owner) => {
      for (const [reason, hash, marker] of [
        ["created", Buffer.alloc(32), "ops/reset/x.json"],
        ["reset", Buffer.alloc(31), "ops/reset/x.json"],
        ["reset", Buffer.alloc(32), "../x.json"],
      ] as const) {
        expect(await codeOf(owner, START, [reason, hash, marker, testId("aud"), "ci"])).toBe(
          "22023",
        );
      }
    });
  });
});

describe("the journal and the anchors (§3.7, §3.10)", () => {
  async function journalOutcome(
    login: string,
    event: Record<string, unknown>,
    entries: (eventId: string) => Record<string, unknown>[],
  ): Promise<string[]> {
    return withClient(login, async (client) => {
      const outcomes: string[] = [];
      await client.query("BEGIN");
      try {
        const eventId = await record(client, event);
        for (const entry of entries(eventId)) {
          await client.query("SAVEPOINT entry");
          outcomes.push(
            await codeOf(client, "SELECT audit.record_journal($1::jsonb)", [JSON.stringify(entry)]),
          );
          await client.query(
            outcomes.at(-1) === "ok" ? "RELEASE SAVEPOINT entry" : "ROLLBACK TO SAVEPOINT entry",
          );
        }
      } finally {
        await client.query("ROLLBACK");
      }
      return outcomes;
    });
  }

  it("writes a journal entry only for an event of the same transaction and login (FA007)", async () => {
    await withClient("fin_admin_a", async (admin) => {
      const earlier = await record(
        admin,
        input({ event: "test.staff_removed", target_id: "stf_x" }),
      );
      expect(
        await codeOf(admin, "SELECT audit.record_journal($1::jsonb)", [
          JSON.stringify({ id: testId("jrn"), audit_event_id: earlier }),
        ]),
      ).toBe("FA007");
      await admin.query("BEGIN");
      const now = await record(
        admin,
        input({ event: "test.staff_removed", target_id: "stf_x", ref_ids: ["ses_1", "ses_2"] }),
      );
      const journalId = testId("jrn");
      await admin.query("SELECT audit.record_journal($1::jsonb)", [
        JSON.stringify({ id: journalId, audit_event_id: now }),
      ]);
      await admin.query("COMMIT");
      const row = await su.query(
        "SELECT kind, organization_id, subject_ids, audit_event_id FROM audit.journal_entry WHERE id = $1",
        [journalId],
      );
      expect(row.rows).toEqual([
        {
          kind: "staff_removed",
          organization_id: null,
          subject_ids: ["stf_x", "ses_1", "ses_2"],
          audit_event_id: now,
        },
      ]);
      expect(await codeOf(admin, "INSERT INTO audit.journal_entry (id) VALUES ('x')")).toBe(
        "42501",
      );
    });
  });

  it("takes what an entry says from its event: never a caller's kind, organisation or subjects", async () => {
    const worker = { actor_kind: "system", actor_id: null, actor_via: "job" };
    const outcomes = await journalOutcome(
      "fin_worker_a",
      input({ ...worker, event: "test.staff_removed", target_id: "stf_y" }),
      (eventId) => [
        { id: testId("jrn"), audit_event_id: eventId, kind: "customer_erased" },
        { id: testId("jrn"), audit_event_id: eventId, organization_id: "org_victim" },
        { id: testId("jrn"), audit_event_id: eventId, subject_ids: ["cus_victim1"] },
        { id: "jrn_short", audit_event_id: eventId },
        { id: testId("jrn"), audit_event_id: eventId },
        // One entry per event.
        { id: testId("jrn"), audit_event_id: eventId },
      ],
    );
    expect(outcomes).toEqual(["FA006", "FA006", "FA006", "FA005", "ok", "FA009"]);
    // An event that declares no journal kind has no entry to write.
    expect(
      await journalOutcome(
        "fin_worker_a",
        input({ ...worker, event: "test.staff_thing" }),
        (id) => [{ id: testId("jrn"), audit_event_id: id }],
      ),
    ).toEqual(["FA009"]);
  });

  it("names the event's own organisation and subjects in an organisation event's entry", async () => {
    const org = testId("org");
    const journalId = testId("jrn");
    await withClient("fin_console_a", async (console) => {
      await console.query("BEGIN");
      const eventId = await record(
        console,
        input({ event: "test.org_thing", organization_id: org, target_id: "mem_1" }),
      );
      await console.query("SELECT audit.record_journal($1::jsonb)", [
        JSON.stringify({ id: journalId, audit_event_id: eventId }),
      ]);
      await console.query("COMMIT");
    });
    expect(
      (
        await su.query(
          "SELECT kind, organization_id, subject_ids FROM audit.journal_entry WHERE id = $1",
          [journalId],
        )
      ).rows,
    ).toEqual([{ kind: "member_removed", organization_id: org, subject_ids: ["mem_1"] }]);
  });

  it("records an anchor, or a conflict, only for a head the chain reached, under the key that names it", async () => {
    await withClient("fin_worker_a", async (worker) => {
      await worker.query("SELECT audit.sequence(50000)");
      const head = await worker.query<{ epoch: number; seq: string; hash: Buffer }>(
        "SELECT e.epoch, e.seq, e.hash FROM audit.event e WHERE e.seq IS NOT NULL ORDER BY e.epoch DESC, e.seq DESC LIMIT 1",
      );
      const h = head.rows[0];
      if (h === undefined) throw new Error("no chained row");
      const key = `audit/head/e${h.epoch}/${h.seq.padStart(12, "0")}-${h.hash.toString("hex").slice(0, 16)}.json`;
      await worker.query("SELECT audit.record_anchor('audit', $1, $2, $3, $4)", [
        h.epoch,
        h.seq,
        h.hash,
        key,
      ]);
      expect(
        await codeOf(worker, "SELECT audit.record_anchor('audit', $1, $2, $3, $4)", [
          h.epoch,
          h.seq,
          Buffer.alloc(32, 1),
          key,
        ]),
      ).toBe("22023");
      const forged = `audit/head/e${h.epoch}/${h.seq.padStart(12, "0")}-${"01".repeat(8)}.json`;
      expect(
        await codeOf(worker, "SELECT audit.record_anchor('audit', $1, $2, $3, $4)", [
          h.epoch,
          h.seq,
          Buffer.alloc(32, 1),
          forged,
        ]),
      ).toBe("FA008");
      await worker.query("SELECT audit.record_anchor_conflict('audit', $1, $2, $3, $4, NULL)", [
        h.epoch,
        h.seq,
        key,
        h.hash,
      ]);
      expect(
        await codeOf(worker, "SELECT audit.record_anchor_conflict('audit', $1, $2, $3, $4, NULL)", [
          h.epoch,
          h.seq,
          forged,
          h.hash,
        ]),
      ).toBe("22023");
      expect(
        await codeOf(worker, "SELECT audit.record_anchor_conflict('audit', $1, $2, $3, $4, NULL)", [
          h.epoch,
          h.seq,
          forged,
          Buffer.alloc(32, 1),
        ]),
      ).toBe("FA008");
      expect((await worker.query("SELECT count(*)::int AS n FROM audit.anchor")).rows).toEqual([
        { n: 1 },
      ]);
      expect(
        (await worker.query("SELECT count(*)::int AS n FROM audit.anchor_conflict")).rows,
      ).toEqual([{ n: 1 }]);
    });
  });
});
