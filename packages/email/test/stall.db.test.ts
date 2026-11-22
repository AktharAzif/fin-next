// A stall on the delivery path on a real Postgres 18 (the `email-delivery-stalled` alert), the sender
// running as the worker's own login: a lock wait that runs out (SQLSTATE 55P03, after the login's
// lock timeout, as the bootstrap's role default sets it for every service login) and a pool that
// cannot hand out a connection in time each write one `email.delivery_stalled` line with the step
// and the code, and the row's ID for a row, never the error's words; the error goes on as before.
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "../src/ids.ts";
import type { PoolLike } from "../src/outbox/db.ts";
import { enqueue } from "../src/outbox/store.ts";
import { recipientHasher } from "../src/recipient-key.ts";
import { Sender } from "../src/sender/sender.ts";
import { HAS_DATABASE, openTestDatabase, type TestDatabase } from "../src/testing/db.ts";
import { FakeTransport, LineRecorder } from "../src/testing/index.ts";

/** The login's lock timeout here; the services' role default is 5 s. */
const LOCK_TIMEOUT_MS = 300;
const USER = "usr_01jd0000000000000000000000";

/** What a promise rejects with (the test fails if it resolves). */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe.skipIf(!HAS_DATABASE)("a stall on the delivery path, on Postgres 18", () => {
  let db: TestDatabase;
  let worker: Pool;
  let log: LineRecorder;

  beforeAll(async () => {
    db = await openTestDatabase("stall");
    worker = new pg.Pool({
      connectionString: db.urlFor("fin_worker"),
      max: 2,
      lock_timeout: LOCK_TIMEOUT_MS,
    });
  }, 60_000);

  afterAll(async () => {
    await worker?.end();
    await db?.close();
  });

  beforeEach(async () => {
    await db.admin.query("TRUNCATE email_private.outbox, email_private.recipient_window");
    log = new LineRecorder();
  });

  function sender(pool: PoolLike): Sender {
    return new Sender({
      db: pool,
      port: new FakeTransport(),
      // Just ahead of the database's clock, so a row queued now is due.
      clock: { now: () => Date.now() + 2_000 },
      log,
      holder: "worker-a:1",
      environment: "staging",
      from: { auth: { address: "account-security@auth.example.com", name: "Fin" } },
      links: { console: "https://console.example.com", admin: "https://staff.example.com" },
      hashRecipient: recipientHasher({ version: 1, secret: new Uint8Array(32).fill(3) }),
      random: () => 0.5,
    });
  }

  /** Holds `table` in ACCESS EXCLUSIVE mode, as another session's lock would, while `work` runs. */
  async function holding<T>(table: string, work: () => Promise<T>): Promise<T> {
    const holder = await db.admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
      return await work();
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }

  it("writes one line when the claim waits out its lock timeout, and the error goes on", async () => {
    const error = await holding("email_private.outbox", () => rejection(sender(worker).runOnce()));
    expect((error as { code?: unknown }).code).toBe("55P03");
    expect(log.lines).toEqual([
      {
        event: "email.delivery_stalled",
        level: "error",
        fields: { step: "claim", code: "pg_55P03" },
      },
    ]);
  });

  it("writes one line with the row's ID when a claimed row waits out its lock timeout", async () => {
    const id = await enqueue(db.as.fin_console, {
      id: newId("eml", { now: () => Date.now() }),
      template: "identity/new-sign-in",
      recipientKind: "address",
      recipient: "person@example.com",
      params: { userId: USER, device: "Safari on macOS", time: "2026-11-22T09:00:00.000Z" },
    });
    // The claim goes through; counting the recipient waits behind the hold and gives up.
    const result = await holding("email_private.recipient_window", () => sender(worker).runOnce());
    expect(result).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    expect(log.named("email.delivery_stalled")).toEqual([
      {
        event: "email.delivery_stalled",
        level: "error",
        fields: { step: "row", code: "pg_55P03", emailId: id },
      },
    ]);
    expect(log.named("email.send_failed").map((l) => l.fields.code)).toEqual(["sender_error"]);
    expect(log.text()).not.toContain("@");
    expect(log.text()).not.toContain("lock timeout");
  });

  it("writes one line when the pool cannot hand out a connection in time, and the error goes on", async () => {
    const tight = new pg.Pool({
      connectionString: db.urlFor("fin_worker"),
      max: 1,
      connectionTimeoutMillis: LOCK_TIMEOUT_MS,
    });
    // Another unit of work holds the pool's only connection.
    const busy = await tight.connect();
    try {
      const error = await rejection(sender(tight).runOnce());
      expect((error as Error).message).toBe("timeout exceeded when trying to connect");
      expect(log.lines).toEqual([
        {
          event: "email.delivery_stalled",
          level: "error",
          fields: { step: "claim", code: "connect_timeout" },
        },
      ]);
      expect(log.text()).not.toContain("timeout exceeded");
    } finally {
      busy.release();
      await tight.end();
    }
  });

  it("writes nothing when the path is not held", async () => {
    expect(await sender(worker).runOnce()).toMatchObject({ claimed: 0, failed: 0 });
    expect(await sender(worker).flushDigests()).toBe(0);
    expect(log.named("email.delivery_stalled")).toEqual([]);
  });
});
