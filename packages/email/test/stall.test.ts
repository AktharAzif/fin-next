// A stall on the delivery path (the `email-delivery-stalled` alert): a lock wait that ran out
// (SQLSTATE 55P03) or a connection `pg` could not open or hand out in time writes one
// `email.delivery_stalled` line, with the step and the code (and the row's ID for a row) and nothing
// of the error's message, and the error goes on as before. Any other error writes none. The
// connection timeouts are built as `pg` and `pg-pool` build them; stall.db.test.ts makes a real lock
// wait and a real pool timeout on Postgres 18.
import { describe, expect, it } from "vitest";
import type { PoolLike, QueryResultLike } from "../src/outbox/db.ts";
import { recipientHasher } from "../src/recipient-key.ts";
import { Sender, stallOf } from "../src/sender/sender.ts";
import { FakeTransport, LineRecorder } from "../src/testing/index.ts";

const EMAIL_ID = "eml_01jd0000000000000000000000";
const USER = "usr_01jd0000000000000000000000";

/** An error as Postgres reports a lock wait that ran out. */
function lockTimeout(): Error {
  return Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
}

const POOL_BUSY = "timeout exceeded when trying to connect";
const CONNECT_SLOW = "Connection terminated due to connection timeout";

/** A pool whose statements are answered by `answer`, in order. */
function pool(answer: (text: string, call: number) => unknown[]): PoolLike {
  let call = 0;
  const query = async <R>(text: string): Promise<QueryResultLike<R>> => {
    const rows = answer(text, call++) as R[];
    return { rows, rowCount: rows.length };
  };
  return {
    query,
    connect: async () => ({ query, release: () => undefined }),
  };
}

function failing(error: unknown): PoolLike {
  return pool(() => {
    throw error;
  });
}

function sender(db: PoolLike, log: LineRecorder): Sender {
  return new Sender({
    db,
    port: new FakeTransport(),
    clock: { now: () => Date.parse("2026-11-22T09:00:00.000Z") },
    log,
    holder: "worker-a:1",
    environment: "staging",
    from: { auth: { address: "account-security@auth.example.com", name: "Fin" } },
    links: { console: "https://console.example.com", admin: "https://staff.example.com" },
    hashRecipient: recipientHasher({ version: 1, secret: new Uint8Array(32).fill(3) }),
    random: () => 0.5,
  });
}

/** What a sender method rejects with (the test fails if it resolves). */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("stallOf", () => {
  it("names a lock wait that ran out and each connection timeout pg gives", () => {
    expect(stallOf(lockTimeout())).toBe("pg_55P03");
    expect(stallOf(new Error(POOL_BUSY))).toBe("connect_timeout");
    expect(stallOf(new Error(CONNECT_SLOW, { cause: new Error("Connection terminated") }))).toBe(
      "connect_timeout",
    );
    expect(stallOf(new Error("timeout expired"))).toBe("connect_timeout");
  });

  it("names nothing else a stall", () => {
    for (const error of [
      Object.assign(new Error("permission denied for schema email_private"), { code: "42501" }),
      Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
      new Error("Query read timeout"),
      new Error(`${POOL_BUSY}, again`),
      { message: POOL_BUSY },
      "55P03",
      undefined,
      null,
    ]) {
      expect(stallOf(error), String(error)).toBeUndefined();
    }
  });
});

describe("a stall on the delivery path", () => {
  const cases: readonly [string, () => unknown, string][] = [
    ["a lock wait that ran out", lockTimeout, "pg_55P03"],
    ["no pooled connection in time", () => new Error(POOL_BUSY), "connect_timeout"],
    ["a new connection not made in time", () => new Error(CONNECT_SLOW), "connect_timeout"],
  ];

  for (const [what, make, code] of cases) {
    it(`writes one line for ${what} at each step the loop runs, and the error goes on`, async () => {
      const steps: readonly [string, (s: Sender) => Promise<unknown>][] = [
        ["claim", (s) => s.runOnce()],
        ["digest", (s) => s.flushDigests()],
        ["age", (s) => s.age()],
        ["sweep", (s) => s.sweep()],
      ];
      for (const [step, run] of steps) {
        const log = new LineRecorder();
        const error = make();
        expect(await rejection(run(sender(failing(error), log))), step).toBe(error);
        expect(log.lines, step).toEqual([
          { event: "email.delivery_stalled", level: "error", fields: { step, code } },
        ]);
      }
    });
  }

  it("writes one line with the row's ID for a row that stalls, beside its email.send_failed", async () => {
    const log = new LineRecorder();
    // The urgent claim returns one security notice; every later statement waits out its lock.
    const db = pool((text, call) => {
      if (call === 0 && text.includes("UPDATE email_private.outbox o")) {
        return [
          {
            id: EMAIL_ID,
            template: "identity/new-sign-in",
            category: "security",
            priority: 10,
            recipient_kind: "address",
            recipient: "person@example.com",
            params: { userId: USER, device: "Safari on macOS", time: "2026-11-22T08:59:00.000Z" },
            carries_code: false,
            due_at: new Date("2026-11-22T08:59:00.000Z"),
            attempts: 1,
            last_error_code: null,
            created_at: new Date("2026-11-22T08:59:00.000Z"),
            counted: false,
            security_unsent_at: null,
          },
        ];
      }
      if (text.includes("UPDATE email_private.outbox o")) return [];
      throw lockTimeout();
    });
    const result = await sender(db, log).runOnce();
    expect(result).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    expect(log.named("email.delivery_stalled")).toEqual([
      {
        event: "email.delivery_stalled",
        level: "error",
        fields: { step: "row", code: "pg_55P03", emailId: EMAIL_ID },
      },
    ]);
    expect(log.named("email.send_failed").map((l) => l.fields.code)).toEqual(["sender_error"]);
    expect(log.text()).not.toContain("person@example.com");
    expect(log.text()).not.toContain("lock timeout");
  });

  it("writes nothing for an error that is no stall", async () => {
    for (const error of [
      Object.assign(new Error("permission denied for schema email_private"), { code: "42501" }),
      new Error("Connection terminated unexpectedly"),
    ]) {
      const log = new LineRecorder();
      expect(await rejection(sender(failing(error), log).runOnce())).toBe(error);
      expect(await rejection(sender(failing(error), log).flushDigests())).toBe(error);
      expect(log.lines).toEqual([]);
    }
  });
});
