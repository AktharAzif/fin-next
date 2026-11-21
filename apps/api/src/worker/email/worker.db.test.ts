// The worker's email side on a real Postgres 18: the delivery check's once-per-release and daily
// rule (S0-09), and the whole path from `email.enqueue()` through NOTIFY, the loop and the sender to
// the transport and the heartbeat, as the worker's own login.
import { enqueue, newId } from "@fin/email";
import { FakeTransport, LineRecorder } from "@fin/email/testing";
import { HAS_DATABASE, openTestDatabase, type TestDatabase } from "@fin/email/testing/db";
import pg from "pg";
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
      "TRUNCATE email.outbox, email.recipient_window, email.daily_budget, email.delivery_check, ops.duty_state",
    );
    await db.admin.query("UPDATE email.send_bucket SET tokens = 0, refilled_at = '-infinity'");
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
    }>("SELECT template, recipient, enqueued_by, priority FROM email.outbox");
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

  it("cannot be held up by another login: no advisory lock, and only the worker may lock its table", async () => {
    const other = await db.as.fin_console.connect();
    try {
      // What any login could do to an advisory lock, and what it may not do to the worker's table.
      await other.query("SELECT pg_advisory_lock(hashtext('fin:email-delivery-check'))");
      await other.query("BEGIN");
      await expect(
        other.query("LOCK TABLE email.delivery_check IN ACCESS SHARE MODE"),
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
      const left = await db.admin.query("SELECT 1 FROM email.outbox");
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
