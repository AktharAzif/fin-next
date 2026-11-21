// The worker's email side on a real Postgres 18: the delivery check's once-per-release and daily
// rule (S0-09), and the whole path from `email.enqueue()` through NOTIFY, the loop and the sender to
// the transport and the heartbeat, as the worker's own login.
import { enqueue, newId, recipientHasher, Sender } from "@fin/email";
import { FakeTransport, LineRecorder } from "@fin/email/testing";
import { HAS_DATABASE, openTestDatabase, type TestDatabase } from "@fin/email/testing/db";
import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailWorkerConfig } from "./config.ts";
import { DAY_MS, runDeliveryCheck } from "./delivery-check.ts";
import { startEmailWorker } from "./index.ts";
import type { Scheduler } from "./loop.ts";

const RELEASE_A = "a1".repeat(20);
const RELEASE_B = "b2".repeat(20);

describe.skipIf(!HAS_DATABASE)("the worker's email side on Postgres 18", () => {
  let db: TestDatabase;
  // The worker's clock runs with real time, ahead of the database's, and tests move it forward.
  let offset = 0;
  const clock = { now: () => Date.now() + offset };

  beforeAll(async () => {
    db = await openTestDatabase("worker");
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.admin.query(
      "TRUNCATE email_private.outbox, email_private.recipient_window, email_private.daily_budget, email_private.delivery_check, ops.duty_state",
    );
    await db.admin.query(
      "UPDATE email_private.send_bucket SET tokens = 0, refilled_at = '-infinity'",
    );
    offset = 2_000;
  });

  async function dutyState() {
    const r = await db.admin.query<{
      scheduler: string;
      duty: string;
      last_success_at: Date | null;
      last_result: string | null;
      consecutive_failures: number;
    }>(
      "SELECT scheduler, duty, last_success_at, last_result, consecutive_failures FROM ops.duty_state",
    );
    return r.rows;
  }

  const check = (release: string, log = new LineRecorder()) =>
    runDeliveryCheck({ db: db.as.fin_worker, clock, release, seedInbox: "seed@example.net", log });

  it("queues the check once per release and once a day, as the worker", async () => {
    const log = new LineRecorder();
    expect(await check(RELEASE_A, log)).toMatchObject({ result: "queued", trigger: "release" });
    expect(await check(RELEASE_A, log)).toMatchObject({ result: "skipped" });
    offset += DAY_MS / 2;
    expect(await check(RELEASE_A, log)).toMatchObject({ result: "skipped" });
    offset += DAY_MS / 2;
    expect(await check(RELEASE_A, log)).toMatchObject({ result: "queued", trigger: "daily" });
    expect(await check(RELEASE_B, log)).toMatchObject({ result: "queued", trigger: "release" });

    const rows = await db.admin.query<{
      template: string;
      recipient: string;
      enqueued_by: string;
      priority: number;
    }>("SELECT template, recipient, enqueued_by, priority FROM email_private.outbox");
    expect(rows.rows).toHaveLength(3);
    for (const r of rows.rows) {
      expect(r).toEqual({
        template: "ops/delivery-check",
        recipient: "seed@example.net",
        enqueued_by: db.loginName("fin_worker"),
        priority: 4,
      });
    }
    expect(log.named("job.run").map((l) => l.fields.result)).toEqual([
      "ok",
      "skipped",
      "skipped",
      "ok",
      "ok",
    ]);
    expect(log.text()).not.toContain("seed@");
  });

  it("agrees across replicas running the check at once", async () => {
    const results = await Promise.all([check(RELEASE_A), check(RELEASE_A), check(RELEASE_A)]);
    expect(results.filter((r) => r.result === "queued")).toHaveLength(1);
  });

  it("puts back the turn's row after a restore emptied the table, and still agrees", async () => {
    await db.admin.query("TRUNCATE email_private.delivery_check_turn");
    const results = await Promise.all([check(RELEASE_A), check(RELEASE_A), check(RELEASE_A)]);
    expect(results.filter((r) => r.result === "queued")).toHaveLength(1);
    expect(results.filter((r) => r.result === "failed")).toEqual([]);
    const turn = await db.admin.query("SELECT name FROM email_private.delivery_check_turn");
    expect(turn.rows).toEqual([{ name: "delivery-check" }]);
  });

  it("cannot be held up by another login: no advisory lock, and only the worker may take the turn", async () => {
    const other = await db.as.fin_console.connect();
    try {
      // What any login could do to an advisory lock, and what it may not do to the worker's tables.
      await other.query("SELECT pg_advisory_lock(hashtext('fin:email-delivery-check'))");
      await other.query("BEGIN");
      await expect(
        other.query("LOCK TABLE email_private.delivery_check IN ACCESS SHARE MODE"),
      ).rejects.toMatchObject({ code: "42501" });
      await other.query("ROLLBACK");
      await other.query("BEGIN");
      await expect(
        other.query("SELECT 1 FROM email_private.delivery_check_turn FOR UPDATE"),
      ).rejects.toMatchObject({ code: "42501" });
      await other.query("ROLLBACK");
      const outcome = await Promise.race([
        check(RELEASE_A),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 3000)),
      ]);
      expect(outcome).toMatchObject({ result: "queued", trigger: "release" });
    } finally {
      await other.query("SELECT pg_advisory_unlock_all()");
      other.release();
    }
  });

  // Postgres takes a statement's table lock before it checks the statement's privileges: a PREPARE
  // locks its tables when it is parsed, and CREATE RULE or CREATE TRIGGER queues its lock (ACCESS
  // EXCLUSIVE, SHARE ROW EXCLUSIVE) before its ownership check fails. So a login that could name the
  // worker's tables could hold the check and the sender up with two sessions: one keeps a lock in an
  // open transaction, the other queues DDL behind it, and the worker's own locks queue behind the
  // DDL. No other login may use the schema the worker's tables are in, so it cannot name them.
  const OTHERS = ["fin_console", "fin_admin", "fin_api", "fin_payments"] as const;
  const PRIVATE = "email_private";
  const WORKER_TABLES = [
    "outbox",
    "delivery_check",
    "delivery_check_turn",
    "send_bucket",
    "daily_budget",
    "recipient_window",
  ].map((table) => `${PRIVATE}.${table}`);
  const DDL = {
    rule: (table: string) => `CREATE RULE r AS ON INSERT TO ${table} DO NOTHING`,
    trigger: (table: string) =>
      `CREATE TRIGGER t BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`,
  };
  /**
   * What session A prepares so session B's DDL queues behind it: any statement for CREATE RULE's
   * ACCESS EXCLUSIVE; for CREATE TRIGGER's SHARE ROW EXCLUSIVE, one that takes ROW EXCLUSIVE.
   */
  const HOLD = {
    rule: (table: string) => `PREPARE p AS SELECT 1 FROM ${table}`,
    trigger: (table: string) => `PREPARE p AS DELETE FROM ${table}`,
  };
  const DENIED = { code: "42501", message: `permission denied for schema ${PRIVATE}` };

  /** How a statement ended: "ok", or its SQLSTATE and message. */
  const outcomeOf = (query: Promise<unknown>) =>
    query.then(
      () => "ok" as const,
      (error: { code?: string; message?: string }) => ({
        code: error.code,
        message: error.message,
      }),
    );

  /** Waits until `done` has settled or the backend `pid` waits on a lock, whichever comes first. */
  async function settledOrWaiting(pid: number, done: Promise<unknown>): Promise<void> {
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    const until = Date.now() + 2000;
    while (!settled && Date.now() < until) {
      const waiting = await db.admin.query(
        "SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted",
        [pid],
      );
      if (waiting.rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const backendPid = async (client: PoolClient) =>
    (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;

  /** The sender as the worker runs it, over a fake transport. */
  const sender = () =>
    new Sender({
      db: db.as.fin_worker,
      port: new FakeTransport(),
      clock,
      log: new LineRecorder(),
      holder: "worker-a:1",
      environment: "staging",
      from: { auth: { address: "account-security@auth.example.com", name: "Fin" } },
      links: { console: "https://console.example.com" },
      hashRecipient: recipientHasher({ version: 1, secret: new Uint8Array(32).fill(5) }),
      random: () => 0.5,
      newEntityRef: () => "ref",
    });

  /** `work`'s result, or "blocked" when it has not finished within `ms`. */
  async function within<T>(work: Promise<T>, ms: number): Promise<T | "blocked"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<"blocked">((resolve) => {
          timer = setTimeout(() => resolve("blocked"), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  it("cannot be held up by another login's PREPARE and a CREATE RULE or CREATE TRIGGER queued behind it", async () => {
    let run = 0;
    for (const role of OTHERS) {
      const a = await db.as[role].connect();
      const b = await db.as[role].connect();
      try {
        const bPid = await backendPid(b);
        for (const table of WORKER_TABLES) {
          for (const kind of ["rule", "trigger"] as const) {
            let queued: ReturnType<typeof outcomeOf> | undefined;
            let sending: Promise<unknown> | undefined;
            try {
              // A sign-in code waits in the outbox too, so the sender also counts its recipient.
              await enqueue(db.as.fin_console, {
                id: newId("eml", clock),
                template: "identity/sign-in-code",
                recipientKind: "address",
                recipient: `person${run}@example.com`,
                params: { code: "24682468" },
              });
              // Session A keeps a lock in an open transaction; session B queues DDL behind it.
              await a.query("BEGIN");
              const prepared = await outcomeOf(a.query(HOLD[kind](table)));
              queued = outcomeOf(b.query(DDL[kind](table)));
              await settledOrWaiting(bPid, queued);
              // The delivery check queues its email, and the sender sends both (the outbox, the
              // token bucket, the daily budget, the recipient window), none of it waiting on
              // another login's lock.
              const release = (run++).toString(16).padStart(40, "c");
              const outcome = await check(release);
              sending = sender().runOnce();
              const sent = await within(sending, 3000);
              expect({ role, table, kind, check: outcome.result, sent }).toMatchObject({
                role,
                table,
                kind,
                check: "queued",
                sent: { sent: 2 },
              });
              expect(prepared).toEqual(DENIED);
              expect(await queued).toEqual(DENIED);
            } finally {
              await a.query("ROLLBACK").catch(() => undefined);
              await a.query("DEALLOCATE ALL").catch(() => undefined);
              await queued;
              await sending?.catch(() => undefined);
            }
          }
        }
      } finally {
        a.release(true);
        b.release(true);
      }
    }
  }, 120_000);

  it("is not held up by a caller that keeps its transaction open after email.enqueue()", async () => {
    const probe = "test/enqueue-probe";
    for (const role of OTHERS) {
      await db.admin.query(
        `INSERT INTO email.template_grant (template, role, category, priority, carries_secret)
         VALUES ($1, $2, 'notice', 3, false)`,
        [probe, db.roleName(role)],
      );
    }
    let run = 0;
    try {
      for (const role of OTHERS) {
        const caller = await db.as[role].connect();
        const other = await db.as[role].connect();
        try {
          await caller.query("BEGIN");
          const id = newId("eml", clock);
          await caller.query("SELECT email.enqueue($1::jsonb)", [
            JSON.stringify({ id, template: probe, recipient: "person@example.com", params: {} }),
          ]);
          // The caller holds ROW EXCLUSIVE on the outbox until its transaction ends.
          const held = await db.admin.query<{ mode: string }>(
            `SELECT mode FROM pg_locks
              WHERE pid = $1 AND relation = 'email_private.outbox'::regclass AND granted`,
            [await backendPid(caller)],
          );
          expect(held.rows).toContainEqual({ mode: "RowExclusiveLock" });
          // It cannot queue DDL on the outbox behind its own lock, either.
          expect(await outcomeOf(other.query(DDL.rule("email_private.outbox")))).toEqual(DENIED);
          const release = (run++).toString(16).padStart(40, "d");
          expect(await check(release)).toMatchObject({ result: "queued", trigger: "release" });
          await caller.query("COMMIT");
          const row = await db.admin.query(
            "SELECT enqueued_by FROM email_private.outbox WHERE id = $1",
            [id],
          );
          expect(row.rows).toEqual([{ enqueued_by: db.loginName(role) }]);
        } finally {
          await caller.query("ROLLBACK").catch(() => undefined);
          caller.release();
          other.release();
        }
      }
    } finally {
      await db.admin.query("DELETE FROM email.template_grant WHERE template = $1", [probe]);
    }
  });

  it("records each run in ops.duty_state: the last success, and failures in a row", async () => {
    await check(RELEASE_A);
    const [first] = await dutyState();
    expect(first).toMatchObject({
      scheduler: "worker",
      duty: "email-delivery-check",
      last_result: "ok",
      consecutive_failures: 0,
    });
    const success = first?.last_success_at;
    expect(success).not.toBeNull();

    // A run that finds nothing due is still a success of the duty.
    offset += 60_000;
    expect(await check(RELEASE_A)).toMatchObject({ result: "skipped" });
    expect((await dutyState())[0]?.last_result).toBe("ok");

    // A run that fails (the seed inbox is refused) keeps the last success and counts the failures.
    const log = new LineRecorder();
    for (let i = 0; i < 2; i++) {
      const failed = await runDeliveryCheck({
        db: db.as.fin_worker,
        clock,
        release: RELEASE_B,
        seedInbox: "not-an-address",
        log,
      });
      expect(failed).toMatchObject({ result: "failed", code: "pg_FE002" });
    }
    const [after] = await dutyState();
    expect(after).toMatchObject({ last_result: "failed", consecutive_failures: 2 });
    expect(after?.last_success_at).not.toBeNull();
    await check(RELEASE_B);
    expect((await dutyState())[0]).toMatchObject({ last_result: "ok", consecutive_failures: 0 });
  });

  it("reports a failure as a failed job.run, never a throw", async () => {
    const log = new LineRecorder();
    const result = await runDeliveryCheck({
      db: db.as.fin_console,
      clock,
      release: RELEASE_A,
      seedInbox: "seed@example.net",
      log,
    });
    expect(result).toMatchObject({ result: "failed", code: "pg_42501" });
    expect(log.named("job.run")[0]).toMatchObject({
      level: "error",
      // Nor may the console write the worker's duty state.
      fields: { result: "failed", dutyState: "failed", dutyStateCode: "pg_42501" },
    });
    expect(await dutyState()).toEqual([]);
  });

  it("writes the adapter's provider.call line for each Cloudflare call", async () => {
    const log = new LineRecorder();
    const calls: string[] = [];
    const config: EmailWorkerConfig = {
      environment: "staging",
      release: RELEASE_A,
      token: "a-test-token-that-is-never-sent-anywhere",
      accountId: "ef".repeat(16),
      authFrom: "account-security@auth.example.com",
      notifyFrom: undefined,
      links: { console: "https://console.example.com" },
      seedInbox: "seed@example.net",
      limitKey: { version: 1, secret: new Uint8Array(32).fill(5) },
      heartbeatUrl: undefined,
    };
    const worker = await startEmailWorker(config, {
      pool: db.as.fin_worker,
      log,
      clock,
      replica: "replica-1",
      schedule: () => () => undefined,
      fetch: (async (url: string | URL | Request) => {
        calls.push(new URL(String(url)).pathname);
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: { delivered: ["seed@example.net"], queued: [], permanent_bounces: [] },
        });
      }) as typeof fetch,
    });
    try {
      await waitFor(async () => {
        worker.loop.wake("poll");
        await worker.loop.idle();
        return log.named("email.sent").length === 1;
      });
      expect(calls).toHaveLength(1);
      const lines = log.named("provider.call");
      expect(lines).toHaveLength(1);
      expect(lines[0]?.fields).toMatchObject({
        provider: "cloudflare-email",
        operation: "send",
        outcome: "ok",
        status: 200,
        retry: 0,
        template: "ops/delivery-check",
        emailId: log.named("email.sent")[0]?.fields.emailId,
      });
      expect(log.text()).not.toContain("@example");
    } finally {
      await worker.stop();
    }
  });

  it("sends a queued code on NOTIFY and the delivery check with its heartbeat, end to end", async () => {
    const port = new FakeTransport();
    const log = new LineRecorder();
    const pings: string[] = [];
    const timers: (() => void)[] = [];
    const schedule: Scheduler = (run) => {
      timers.push(run);
      return () => undefined;
    };
    const config: EmailWorkerConfig = {
      environment: "staging",
      release: RELEASE_A,
      token: "unused-because-the-port-is-fake",
      accountId: "ef".repeat(16),
      authFrom: "account-security@auth.example.com",
      notifyFrom: undefined,
      links: { console: "https://console.example.com" },
      seedInbox: "seed@example.net",
      limitKey: { version: 1, secret: new Uint8Array(32).fill(5) },
      heartbeatUrl: "https://heartbeat.example.com/hb",
    };
    const worker = await startEmailWorker(config, {
      pool: db.as.fin_worker,
      log,
      clock,
      replica: "replica-1",
      port,
      schedule,
      fetch: (async (url: string | URL | Request) => {
        pings.push(String(url));
        return new Response("ok");
      }) as typeof fetch,
      listenClient: () => new pg.Client({ connectionString: db.urlFor("fin_worker") }),
    });
    try {
      await worker.loop.idle();
      // The start-up delivery check is queued; the poll (here, by hand) sends it.
      await waitFor(async () => {
        timers[0]?.();
        await worker.loop.idle();
        return port.of("ops/delivery-check").length === 1;
      });
      expect(pings).toEqual(["https://heartbeat.example.com/hb"]);

      // A code queued by the console wakes the loop through NOTIFY, with no poll.
      await enqueue(db.as.fin_console, {
        id: newId("eml", clock),
        template: "identity/sign-in-code",
        recipientKind: "address",
        recipient: "person@example.com",
        params: { code: "24682468" },
      });
      await waitFor(async () => {
        await worker.loop.idle();
        return port.of("identity/sign-in-code").length === 1;
      });
      expect(port.of("identity/sign-in-code")[0]?.to).toBe("person@example.com");
      const left = await db.admin.query("SELECT 1 FROM email_private.outbox");
      expect(left.rows).toEqual([]);
      expect(
        log
          .named("job.run")
          .some((l) => l.fields.job === "email-send" && l.fields.trigger === "notify"),
      ).toBe(true);
      expect(log.text()).not.toContain("@example");
      expect(log.text()).not.toContain("24682468");
    } finally {
      await worker.stop();
    }
  });
});

async function waitFor(done: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting");
}
