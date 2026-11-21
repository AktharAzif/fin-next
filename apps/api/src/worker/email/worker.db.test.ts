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
      "TRUNCATE email.outbox, email.recipient_window, email.daily_budget, email.delivery_check",
    );
    await db.admin.query("UPDATE email.send_bucket SET tokens = 0, refilled_at = '-infinity'");
    offset = 2_000;
  });

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
    expect(log.named("job.run")[0]).toMatchObject({ level: "error", fields: { result: "failed" } });
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
