// The ops, email and events shells (spec 01 §6.10; AC-P0-11, AC-P0-39): the kill-switch guard, the
// checked functions and their refusals, and row-level security on the leases, duty state and jobs.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditGuardError } from "./errors.ts";
import type { GuardRegistration } from "./guards/types.ts";
import {
  acquireLease,
  enqueueJob,
  isSwitchOn,
  readDutyStates,
  recordDutyRun,
  releaseLease,
} from "./ops.ts";
import type { PgClient } from "./pg.ts";
import { sqlState } from "./pg.ts";
import {
  collectLines,
  createTestDatabase,
  registerEventTypes,
  type TestDatabase,
  testContext,
  testId,
} from "./testing/index.ts";

// The integration timeouts, which the root Vitest configuration leaves to each file: a file's
// database is made under the cluster-wide lock that other files' bootstraps may hold.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let db: TestDatabase;
let su: PgClient;

beforeAll(async () => {
  // Phase 0's objects: packages/db's files alone (assets.db.test.ts applies every package's).
  db = await createTestDatabase({ prefix: "p0e", packages: ["db"] });
  su = await db.superuser();
});

afterAll(async () => {
  await su?.end();
  await db?.drop();
});

async function codeOf(client: PgClient, sql: string, values?: unknown[]): Promise<string> {
  try {
    await client.query(sql, values);
    return "ok";
  } catch (error) {
    return sqlState(error) ?? String(error);
  }
}

async function withClient<T>(login: string, fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = await db.connect(login);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function recordSql(
  event: string,
  target: string,
  extra: Record<string, unknown> = {},
): [string, unknown[]] {
  return [
    "SELECT audit.record($1::jsonb)",
    [
      JSON.stringify({
        id: testId("aud"),
        event,
        actor_kind: "operator",
        actor_id: "run_test",
        actor_via: "operator",
        target_id: target,
        release: "test-release",
        ...extra,
      }),
    ],
  ];
}

describe("the kill-switch guard (spec 08 §3.5, T08-06)", () => {
  it("matches every guard registration with an installed constraint trigger", async () => {
    const dir = join(import.meta.dirname, "guards");
    const files = readdirSync(dir).filter(
      (f) => f.endsWith(".ts") && f !== "types.ts" && !f.endsWith(".test.ts"),
    );
    const registrations: GuardRegistration[] = [];
    for (const file of files) {
      const module = (await import(join(dir, file))) as { guards: readonly GuardRegistration[] };
      registrations.push(...module.guards);
    }
    expect(registrations.length).toBeGreaterThan(0);
    const installed = await su.query<{
      tbl: string;
      args: string;
      events: number;
      deferred: boolean;
      columns: string[];
    }>(
      `SELECT c.oid::regclass::text AS tbl,
              encode(t.tgargs, 'escape') AS args, t.tgtype::int AS events, t.tginitdeferred AS deferred,
              coalesce((SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                        WHERE a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr)), '{}') AS columns
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgfoid = 'audit.require_event'::regproc`,
    );
    const live = installed.rows.map((row) => {
      const [key, events] = row.args.split("\\000");
      const op =
        row.events & 4 ? "INSERT" : row.events & 8 ? "DELETE" : row.events & 16 ? "UPDATE" : "?";
      const full =
        op === "UPDATE" && row.columns.length > 0 ? `UPDATE OF ${row.columns.join(", ")}` : op;
      expect(row.deferred).toBe(true);
      return `${row.tbl} ${full} ${key} ${events}`;
    });
    const expected = registrations.flatMap((r) =>
      r.ops.map((op) => {
        const normal = op.startsWith("UPDATE OF ")
          ? `UPDATE OF ${op.slice(10).split(", ").sort().join(", ")}`
          : op;
        return `${r.table} ${normal} ${r.keyColumn} ${r.events.join(",")}`;
      }),
    );
    expect(live.sort()).toEqual(expected.sort());
  });

  it("refuses at commit an insert into ops.kill_switch that carries no audit event (FA010)", async () => {
    await withClient("fin_owner", async (owner) => {
      await registerEventTypes(owner, [{ name: "switch.set", roles: ["fin_admin", "fin_owner"] }]);
      await owner.query("BEGIN");
      await owner.query(
        "INSERT INTO ops.kill_switch (name, state, changed_by_kind, changed_at) VALUES ('provider_instance:test-a', 'off', 'operator', now())",
      );
      const commit = await codeOf(owner, "COMMIT");
      expect(commit).toBe("FA010");
      expect(await isSwitchOn(owner, "provider_instance:test-a")).toBe(true); // absent fails closed
    });
  });

  it("commits the same insert when the transaction records an accepted event naming the switch", async () => {
    await withClient("fin_owner", async (owner) => {
      await owner.query("BEGIN");
      await owner.query(
        "INSERT INTO ops.kill_switch (name, state, changed_by_kind, changed_at) VALUES ('provider_instance:test-b', 'off', 'operator', now())",
      );
      await owner.query(...recordSql("switch.set", "provider_instance:test-b"));
      expect(await codeOf(owner, "COMMIT")).toBe("ok");
      expect(await isSwitchOn(owner, "provider_instance:test-b")).toBe(false);
    });
  });

  it("accepts the key in ref_ids, and refuses an event of another kind or for another key", async () => {
    await withClient("fin_owner", async (owner) => {
      await registerEventTypes(owner, [{ name: "test.unrelated", roles: ["fin_owner"] }]);
      await owner.query("BEGIN");
      await owner.query("UPDATE ops.kill_switch SET state = 'off' WHERE name = 'signups'");
      await owner.query(...recordSql("switch.set", "something-else", { ref_ids: ["signups"] }));
      expect(await codeOf(owner, "COMMIT")).toBe("ok");

      await owner.query("BEGIN");
      await owner.query("UPDATE ops.kill_switch SET state = 'off' WHERE name = 'signups'");
      await owner.query(...recordSql("test.unrelated", "signups"));
      expect(await codeOf(owner, "COMMIT")).toBe("FA010");

      await owner.query("BEGIN");
      await owner.query("UPDATE ops.kill_switch SET state = 'off' WHERE name = 'signups'");
      await owner.query(...recordSql("switch.set", "live_keys"));
      expect(await codeOf(owner, "COMMIT")).toBe("FA010");

      // A change that does not touch `state` is not guarded.
      await owner.query("BEGIN");
      await owner.query("UPDATE ops.kill_switch SET reason_code = 'drill' WHERE name = 'signups'");
      expect(await codeOf(owner, "COMMIT")).toBe("ok");
    });
  });

  it("makes the unit of work write database.audit_guard with the table only, and throw", async () => {
    const lines = collectLines();
    const admin = db.database("fin_admin");
    const staffId = testId("stf");
    await expect(
      admin.unit(testContext({ log: lines }), async (tx) => {
        await tx.query("SELECT ops.set_switch('live_keys', 'on', 'drill', $1::jsonb)", [
          JSON.stringify({ kind: "staff", id: staffId }),
        ]);
      }),
    ).rejects.toBeInstanceOf(AuditGuardError);
    expect(lines.lines).toEqual([
      { event: "database.audit_guard", fields: { table: "ops.kill_switch" } },
    ]);
    await withClient("fin_owner", async (owner) =>
      expect(await isSwitchOn(owner, "live_keys")).toBe(false),
    );
  });
});

describe("ops.set_switch and ops.trip_switch", () => {
  it("fails closed (FA001) until switch.cleared is registered", async () => {
    await withClient("fin_admin_a", async (admin) => {
      expect(
        await codeOf(admin, "SELECT ops.set_switch('live_keys', 'off', NULL, $1::jsonb)", [
          JSON.stringify({ kind: "staff", id: testId("stf") }),
        ]),
      ).toBe("FA001");
    });
  });

  it("lets Fin Admin set a switch as a staff member, with its event in the same transaction", async () => {
    await withClient("fin_owner", (owner) =>
      registerEventTypes(owner, [
        { name: "switch.set", roles: ["fin_admin", "fin_owner"] },
        { name: "switch.cleared", roles: ["fin_admin", "fin_owner"] },
      ]),
    );
    const admin = db.database("fin_admin");
    const staffId = testId("stf");
    await admin.unit(testContext(), async (tx) => {
      await tx.query("SELECT ops.set_switch('live_keys', 'on', 'drill', $1::jsonb)", [
        JSON.stringify({ kind: "staff", id: staffId }),
      ]);
      await tx.query("SELECT audit.record($1::jsonb)", [
        JSON.stringify({
          id: tx.ids.newId("aud"),
          event: "switch.set",
          actor_kind: "staff",
          actor_id: staffId,
          actor_via: "admin",
          target_id: "live_keys",
          release: "test-release",
        }),
      ]);
    });
    const row = await su.query(
      "SELECT state, reason_code, changed_by_kind, changed_by_id FROM ops.kill_switch WHERE name = 'live_keys'",
    );
    expect(row.rows).toEqual([
      { state: "on", reason_code: "drill", changed_by_kind: "staff", changed_by_id: staffId },
    ]);
  });

  it("refuses the wrong actor for the login, an unknown switch and a bad state", async () => {
    await withClient("fin_admin_a", async (admin) => {
      expect(
        await codeOf(admin, "SELECT ops.set_switch('live_keys', 'off', NULL, $1::jsonb)", [
          JSON.stringify({ kind: "operator", id: "run_x" }),
        ]),
      ).toBe("FS001");
      expect(
        await codeOf(admin, "SELECT ops.set_switch('no_such', 'off', NULL, $1::jsonb)", [
          JSON.stringify({ kind: "staff", id: testId("stf") }),
        ]),
      ).toBe("FS001");
      expect(
        await codeOf(admin, "SELECT ops.set_switch('live_keys', 'maybe', NULL, $1::jsonb)", [
          JSON.stringify({ kind: "staff", id: testId("stf") }),
        ]),
      ).toBe("22023");
    });
    await withClient("fin_owner", async (owner) => {
      expect(
        await codeOf(owner, "SELECT ops.set_switch('live_keys', 'off', NULL, $1::jsonb)", [
          JSON.stringify({ kind: "staff", id: testId("stf") }),
        ]),
      ).toBe("FS001");
    });
  });

  it("trips a money switch for payments and the worker, recording switch.tripped itself", async () => {
    await withClient("fin_payments_a", async (payments) => {
      expect(
        await codeOf(
          payments,
          "SELECT ops.trip_switch('live_money', 'sent_after_end', NULL, 'job', $1, 'rel')",
          [testId("aud")],
        ),
      ).toBe("FA001");
    });
    await withClient("fin_owner", (owner) =>
      registerEventTypes(owner, [
        { name: "switch.tripped", roles: ["fin_payments", "fin_worker"] },
      ]),
    );
    const eventId = testId("aud");
    const ref = testId("trf");
    await withClient("fin_payments_a", async (payments) => {
      await payments.query(
        "SELECT ops.trip_switch('live_money', 'sent_after_end', $1, 'reconciliation', $2, 'rel')",
        [ref, eventId],
      );
    });
    const row = await su.query(
      "SELECT e.event, e.target_id, e.actor_kind, e.actor_via, e.db_login, e.metadata, k.state FROM audit.event e, ops.kill_switch k WHERE e.id = $1 AND k.name = 'live_money'",
      [eventId],
    );
    expect(row.rows).toEqual([
      {
        event: "switch.tripped",
        target_id: "live_money",
        actor_kind: "system",
        actor_via: "reconciliation",
        db_login: "fin_payments_a",
        metadata: { reasonCode: "sent_after_end", ref },
        state: "on",
      },
    ]);
  });

  it("refuses a trip of a switch that is not money's, a bad reason and any caller but payments or the worker", async () => {
    await withClient("fin_worker_a", async (worker) => {
      expect(
        await codeOf(
          worker,
          "SELECT ops.trip_switch('signups', 'sent_after_end', NULL, 'job', $1, 'rel')",
          [testId("aud")],
        ),
      ).toBe("FS001");
      expect(
        await codeOf(
          worker,
          "SELECT ops.trip_switch('live_money', 'because', NULL, 'job', $1, 'rel')",
          [testId("aud")],
        ),
      ).toBe("22023");
    });
    await withClient("fin_api_a", async (api) => {
      expect(
        await codeOf(
          api,
          "SELECT ops.trip_switch('live_money', 'sent_after_end', NULL, 'job', $1, 'rel')",
          [testId("aud")],
        ),
      ).toBe("42501");
    });
  });
});

describe("ops.enqueue_job (AC-P0-39) and job row-level security", () => {
  it("enqueues a kind whose enqueue_roles name the caller's group", async () => {
    const worker = db.database("fin_worker");
    const id = await worker.unit(testContext(), (tx) =>
      enqueueJob(tx, { kind: "ops.noop", payload: { n: 1 } }),
    );
    expect(id).toMatch(/^job_[0-9a-hjkmnp-tv-z]{26}$/);
    const row = await su.query("SELECT kind, payload, state, attempts FROM ops.job WHERE id = $1", [
      id,
    ]);
    expect(row.rows).toEqual([
      { kind: "ops.noop", payload: { n: 1 }, state: "pending", attempts: 0 },
    ]);
  });

  it("refuses a kind the caller may not enqueue, an unknown kind and a bad payload", async () => {
    for (const login of ["fin_api_a", "fin_payments_a"]) {
      await withClient(login, async (client) => {
        expect(
          await codeOf(client, "SELECT ops.enqueue_job($1, 'ops.noop', '{}'::jsonb, NULL)", [
            testId("job"),
          ]),
        ).toBe("FJ001");
      });
    }
    await withClient("fin_worker_a", async (worker) => {
      expect(
        await codeOf(worker, "SELECT ops.enqueue_job($1, 'ops.nothing', '{}'::jsonb, NULL)", [
          testId("job"),
        ]),
      ).toBe("FJ001");
      expect(
        await codeOf(worker, "SELECT ops.enqueue_job($1, 'ops.noop', '[1]'::jsonb, NULL)", [
          testId("job"),
        ]),
      ).toBe("FJ002");
      expect(
        await codeOf(worker, "SELECT ops.enqueue_job('job_bad', 'ops.noop', '{}'::jsonb, NULL)"),
      ).toBe("FJ002");
      expect(
        await codeOf(
          worker,
          "INSERT INTO ops.job (id, kind, due_at, created_at, updated_at) VALUES ($1, 'ops.noop', now(), now(), now())",
          [testId("job")],
        ),
      ).toBe("42501");
    });
    await withClient("fin_console_a", async (console) => {
      expect(
        await codeOf(console, "SELECT ops.enqueue_job($1, 'ops.noop', '{}'::jsonb, NULL)", [
          testId("job"),
        ]),
      ).toBe("42501");
    });
  });

  it("lets only the kind's runner see and claim its jobs", async () => {
    await withClient("fin_owner", async (owner) => {
      await owner.query(
        "INSERT INTO ops.job_kind (kind, enqueue_roles, runner) VALUES ('test.money_noop', ARRAY['fin_payments'], 'payments') ON CONFLICT DO NOTHING",
      );
    });
    const paymentsJob = testId("job");
    await withClient("fin_payments_a", (p) =>
      p.query("SELECT ops.enqueue_job($1, 'test.money_noop', '{}'::jsonb, NULL)", [paymentsJob]),
    );
    await withClient("fin_worker_a", async (worker) => {
      const seen = await worker.query<{ kind: string }>("SELECT DISTINCT kind FROM ops.job");
      expect(seen.rows.map((r) => r.kind)).toEqual(["ops.noop"]);
      const claimed = await worker.query(
        "UPDATE ops.job SET lease_until = now() + interval '2 minutes', leased_by = 'w' WHERE id = $1",
        [paymentsJob],
      );
      expect(claimed.rowCount).toBe(0);
    });
    await withClient("fin_payments_a", async (payments) => {
      const seen = await payments.query<{ kind: string }>("SELECT DISTINCT kind FROM ops.job");
      expect(seen.rows.map((r) => r.kind)).toEqual(["test.money_noop"]);
      const claimed = await payments.query(
        "UPDATE ops.job SET lease_until = now() + interval '2 minutes', leased_by = 'p' WHERE id = $1",
        [paymentsJob],
      );
      expect(claimed.rowCount).toBe(1);
      expect(
        await codeOf(payments, "UPDATE ops.job SET kind = 'ops.noop' WHERE id = $1", [paymentsJob]),
      ).toBe("42501");
    });
  });
});

describe("scheduler leases and duty state (row-level security, ARCHITECTURE §4.6)", () => {
  it("shows and lets update each scheduler only its own lease row", async () => {
    await withClient("fin_worker_a", async (worker) => {
      expect((await worker.query("SELECT name FROM ops.scheduler_lease")).rows).toEqual([
        { name: "worker" },
      ]);
      const other = await worker.query(
        "UPDATE ops.scheduler_lease SET holder = 'w' WHERE name = 'payments'",
      );
      expect(other.rowCount).toBe(0);
      expect(await acquireLease(worker, "payments", "w-1")).toBeNull();
    });
    await withClient("fin_payments_a", async (payments) => {
      expect((await payments.query("SELECT name FROM ops.scheduler_lease")).rows).toEqual([
        { name: "payments" },
      ]);
    });
    await withClient("fin_probe", async (probe) => {
      expect(
        (await probe.query('SELECT name FROM ops.scheduler_lease ORDER BY name COLLATE "C"')).rows,
      ).toEqual([{ name: "payments" }, { name: "worker" }]);
      expect(await codeOf(probe, "UPDATE ops.scheduler_lease SET holder = 'x'")).toBe("42501");
    });
  });

  it("gives the lease to one holder until it lapses or is released", async () => {
    await withClient("fin_worker_a", async (worker) => {
      expect(await acquireLease(worker, "worker", "replica-a", 30)).toBeInstanceOf(Date);
      expect(await acquireLease(worker, "worker", "replica-b", 30)).toBeNull();
      expect(await acquireLease(worker, "worker", "replica-a", 30)).toBeInstanceOf(Date);
      expect(await releaseLease(worker, "worker", "replica-b")).toBe(false);
      expect(await releaseLease(worker, "worker", "replica-a")).toBe(true);
      expect(await acquireLease(worker, "worker", "replica-b", 30)).toBeInstanceOf(Date);
    });
    await withClient("fin_owner", (owner) =>
      owner.query(
        "UPDATE ops.scheduler_lease SET until = now() - interval '1 second' WHERE name = 'worker'",
      ),
    );
    await withClient("fin_worker_a", async (worker) => {
      expect(await acquireLease(worker, "worker", "replica-a", 30)).toBeInstanceOf(Date);
    });
  });

  it("keeps duty state per scheduler, refusing a row of the other scheduler (42501)", async () => {
    await withClient("fin_worker_a", async (worker) => {
      await recordDutyRun(worker, { scheduler: "worker", duty: "db-probe", result: "failed" });
      await recordDutyRun(worker, { scheduler: "worker", duty: "db-probe", result: "failed" });
      let states = await readDutyStates(worker, "worker");
      expect(states).toMatchObject([
        { duty: "db-probe", lastResult: "failed", consecutiveFailures: 2, lastSuccessAt: null },
      ]);
      await recordDutyRun(worker, { scheduler: "worker", duty: "db-probe", result: "ok" });
      states = await readDutyStates(worker, "worker");
      expect(states[0]?.consecutiveFailures).toBe(0);
      expect(states[0]?.lastSuccessAt).toBeInstanceOf(Date);
      expect(
        await codeOf(
          worker,
          "INSERT INTO ops.duty_state (scheduler, duty) VALUES ('payments', 'reconcile-daily')",
        ),
      ).toBe("42501");
      expect(await readDutyStates(worker, "payments")).toEqual([]);
    });
  });
});

describe("ops.rate_window and its sweep", () => {
  it("lets the request services count windows and the worker sweep only old ones", async () => {
    await withClient("fin_edge_a", async (edge) => {
      await edge.query(
        "INSERT INTO ops.rate_window (key, window_start, count) VALUES ('k1', now() - interval '2 days', 1), ('k2', now(), 1)",
      );
      await edge.query("UPDATE ops.rate_window SET count = count + 1 WHERE key = 'k2'");
      expect(await codeOf(edge, "DELETE FROM ops.rate_window")).toBe("42501");
    });
    await withClient("fin_worker_a", async (worker) => {
      expect(
        await codeOf(
          worker,
          "INSERT INTO ops.rate_window (key, window_start, count) VALUES ('w', now(), 1)",
        ),
      ).toBe("42501");
      expect(await codeOf(worker, "SELECT ops.sweep_rate_windows(interval '1 minute')")).toBe(
        "22023",
      );
      const swept = await worker.query<{ n: number }>("SELECT ops.sweep_rate_windows() AS n");
      expect(swept.rows[0]?.n).toBe(1);
    });
  });
});

describe("email.enqueue (AC-P0-39, T08-22's Phase 0 part)", () => {
  it("queues a template granted to the caller's role, stamping who queued it", async () => {
    const id = testId("eml");
    await withClient("fin_worker_a", (worker) =>
      worker.query("SELECT email.enqueue($1::jsonb)", [
        JSON.stringify({
          id,
          template: "ops/delivery-check",
          recipient_kind: "address",
          recipient: "seed@example.com",
          params: {},
        }),
      ]),
    );
    const row = await su.query(
      "SELECT template, category, priority, carries_code, enqueued_by FROM email_private.outbox WHERE id = $1",
      [id],
    );
    expect(row.rows).toEqual([
      {
        template: "ops/delivery-check",
        category: "ops",
        priority: 4,
        carries_code: false,
        enqueued_by: "fin_worker_a",
      },
    ]);
  });

  it("refuses the template to every other role that may call it (FE001), and bad input (FE002)", async () => {
    const payload = (id: string) =>
      JSON.stringify({
        id,
        template: "ops/delivery-check",
        recipient_kind: "address",
        recipient: "seed@example.com",
      });
    for (const login of ["fin_api_a", "fin_payments_a", "fin_console_a", "fin_admin_a"]) {
      await withClient(login, async (client) => {
        expect(
          await codeOf(client, "SELECT email.enqueue($1::jsonb)", [payload(testId("eml"))]),
          login,
        ).toBe("FE001");
      });
    }
    await withClient("fin_edge_a", async (edge) => {
      expect(await codeOf(edge, "SELECT email.enqueue($1::jsonb)", [payload(testId("eml"))])).toBe(
        "42501",
      );
    });
    await withClient("fin_worker_a", async (worker) => {
      const bad = [
        {
          id: testId("eml"),
          template: "identity/sign-in-code",
          recipient_kind: "address",
          recipient: "a@example.com",
        },
        {
          id: testId("eml"),
          template: "ops/delivery-check",
          recipient_kind: "address",
          recipient: "not-an-address",
        },
        {
          id: testId("eml"),
          template: "ops/delivery-check",
          recipient_kind: "customer",
          recipient: "a@example.com",
        },
        {
          id: "eml_bad",
          template: "ops/delivery-check",
          recipient_kind: "address",
          recipient: "a@example.com",
        },
        {
          id: testId("eml"),
          template: "ops/delivery-check",
          recipient_kind: "address",
          recipient: "a@example.com",
          subject: "x",
        },
      ];
      const codes = [];
      for (const input of bad)
        codes.push(
          await codeOf(worker, "SELECT email.enqueue($1::jsonb)", [JSON.stringify(input)]),
        );
      expect(codes).toEqual(["FE001", "FE002", "FE002", "FE002", "FE002"]);
      expect(
        await codeOf(worker, "INSERT INTO email_private.outbox (id) VALUES ($1)", [testId("eml")]),
      ).toBe("42501");
    });
  });
});

describe("email_private: the worker's tables, out of every other login's reach", () => {
  // Postgres takes a statement's table lock before it checks the statement's privileges (a PREPARE
  // when it is parsed; CREATE RULE and CREATE TRIGGER queue theirs before the ownership check), so a
  // login that can name a table can hold it up. One with no USAGE on the schema cannot name it.
  const OTHERS = [
    "fin_edge_a",
    "fin_api_a",
    "fin_payments_a",
    "fin_console_a",
    "fin_admin_a",
    "fin_probe",
  ];

  it("gives USAGE to the worker and enqueue's owner only, CREATE to its owner only, nothing to PUBLIC", async () => {
    const result = await su.query<{ role: string; usage: boolean; create: boolean }>(
      `SELECT r.rolname AS role, has_schema_privilege(r.oid, 'email_private', 'USAGE') AS usage,
              has_schema_privilege(r.oid, 'email_private', 'CREATE') AS create
       FROM pg_roles r WHERE r.rolname LIKE 'fin\\_%' ORDER BY 1`,
    );
    // fin_backup reads every schema through pg_read_all_data, by design (DA-15); it holds no grant.
    expect(result.rows.filter((r) => r.usage).map((r) => r.role)).toEqual([
      "fin_backup",
      "fin_email_enqueue",
      "fin_owner",
      "fin_worker",
      "fin_worker_a",
      "fin_worker_b",
    ]);
    expect(result.rows.filter((r) => r.create).map((r) => r.role)).toEqual(["fin_owner"]);
    const acl = await su.query<{ grantee: string; privilege: string }>(
      `SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
              a.privilege_type AS privilege
       FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = 'email_private'
       ORDER BY 1, a.privilege_type COLLATE "C"`,
    );
    expect(acl.rows).toEqual([
      { grantee: "fin_email_enqueue", privilege: "USAGE" },
      { grantee: "fin_owner", privilege: "CREATE" },
      { grantee: "fin_owner", privilege: "USAGE" },
      { grantee: "fin_worker", privilege: "USAGE" },
    ]);
    const tables = await su.query<{ name: string; public: number }>(
      `SELECT c.relname AS name,
              (SELECT count(*)::int FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                WHERE a.grantee = 0) AS public
       FROM pg_class c WHERE c.relnamespace = 'email_private'::regnamespace AND c.relkind = 'r'`,
    );
    expect(tables.rows).toEqual([{ name: "outbox", public: 0 }]);
  });

  it("runs email.enqueue() as a role that cannot log in, holding only INSERT on the outbox and SELECT on the template grants", async () => {
    const fn = await su.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
              r.rolcanlogin AS can_login
       FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid = 'email.enqueue(jsonb)'::regprocedure`,
    );
    expect(fn.rows).toEqual([
      {
        owner: "fin_email_enqueue",
        definer: true,
        config: ["search_path=pg_catalog, pg_temp"],
        can_login: false,
      },
    ]);
    const schemas = ["identity", "staff", "keys", "kyc", "money", "events", "email"]
      .concat(["email_private", "audit", "ops", "ops_guard"])
      .map((s) => `'${s}'`)
      .join(", ");
    const tables = await su.query<{ name: string; privilege: string }>(
      `SELECT n.nspname || '.' || c.relname AS name, p.privilege
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
            unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(privilege)
       WHERE n.nspname IN (${schemas}) AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
         AND has_table_privilege('fin_email_enqueue', c.oid, p.privilege)
       ORDER BY 1, p.privilege COLLATE "C"`,
    );
    expect(tables.rows).toEqual([
      { name: "email.template_grant", privilege: "SELECT" },
      { name: "email_private.outbox", privilege: "INSERT" },
    ]);
    const held = await su.query<{ name: string; usage: boolean; create: boolean }>(
      `SELECT n.nspname AS name, has_schema_privilege('fin_email_enqueue', n.oid, 'USAGE') AS usage,
              has_schema_privilege('fin_email_enqueue', n.oid, 'CREATE') AS create
       FROM pg_namespace n WHERE n.nspname IN (${schemas}) ORDER BY 1`,
    );
    expect(held.rows.filter((r) => r.usage).map((r) => r.name)).toEqual(["email", "email_private"]);
    expect(held.rows.filter((r) => r.create)).toEqual([]);
    // EXECUTE on email.enqueue() for the five sending services only (its owner's own aside).
    const callers = await su.query<{ role: string }>(
      `SELECT r.rolname AS role FROM pg_roles r
       WHERE has_function_privilege(r.oid, 'email.enqueue(jsonb)', 'EXECUTE')
         AND r.rolname NOT IN ('fin_owner', 'fin_email_enqueue') AND NOT r.rolsuper
       ORDER BY 1`,
    );
    expect(callers.rows.map((r) => r.role)).toEqual(
      ["fin_admin", "fin_api", "fin_console", "fin_payments", "fin_worker"].flatMap((g) => [
        g,
        `${g}_a`,
        `${g}_b`,
      ]),
    );
  });

  it("refuses every other login any name in it before any lock: a SELECT, a PREPARE, a rule or a trigger", async () => {
    const relations = await su.query<{ name: string }>(
      `SELECT 'email_private.' || c.relname AS name FROM pg_class c
       WHERE c.relnamespace = 'email_private'::regnamespace AND c.relkind IN ('r', 'i') ORDER BY 1`,
    );
    expect(relations.rows.map((r) => r.name)).toEqual([
      "email_private.outbox",
      "email_private.outbox_due",
      "email_private.outbox_pkey",
    ]);
    // The superuser holds every table in the schema: a statement that locked before it checked would
    // wait, and end with the lock timeout (55P03), not with 42501.
    const holder = await db.superuser();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE email_private.outbox IN ACCESS EXCLUSIVE MODE");
      for (const login of OTHERS) {
        await withClient(login, async (client) => {
          await client.query("SET lock_timeout = '2s'");
          for (const { name } of relations.rows) {
            for (const sql of [
              `SELECT 1 FROM ${name}`,
              `PREPARE p AS SELECT 1 FROM ${name}`,
              `CREATE RULE r AS ON INSERT TO ${name} DO NOTHING`,
              `CREATE TRIGGER t BEFORE UPDATE ON ${name} FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`,
            ]) {
              await client.query("BEGIN");
              const error = await client.query(sql).then(
                () => undefined,
                (e: unknown) => e as { code?: string; message?: string },
              );
              expect({ login, sql, code: error?.code }).toEqual({ login, sql, code: "42501" });
              expect(error?.message).toBe("permission denied for schema email_private");
              await client.query("ROLLBACK");
            }
          }
          // Nor through the search path, which skips a schema the login may not use.
          await client.query("SET search_path = email_private");
          expect(await codeOf(client, "SELECT 1 FROM outbox")).toBe("42P01");
        });
      }
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });
});

describe("events.emit (the shell)", () => {
  it("refuses every type for the roles that hold it (FV001), and is not callable by others (42501)", async () => {
    for (const login of ["fin_api_a", "fin_worker_a", "fin_payments_a"]) {
      await withClient(login, async (client) => {
        expect(await codeOf(client, "SELECT events.emit('{}'::jsonb)"), login).toBe("FV001");
      });
    }
    for (const login of ["fin_console_a", "fin_admin_a", "fin_edge_a"]) {
      await withClient(login, async (client) => {
        expect(await codeOf(client, "SELECT events.emit('{}'::jsonb)"), login).toBe("42501");
      });
    }
  });
});
