// The stall line as it leaves the worker (the `email-delivery-stalled` alert): worker hands the
// sender and the delivery check its @fin/server Telemetry, which scrubs every line before stdout and
// before Better Stack (spec 08 §5.4). The line's `step` and `reason` come out readable, so the
// alert's series is the reason, never `other`; a field named `code` would come out "[withheld]".
// The sender's claim, the delivery check's run and its record in ops.duty_state each write it for
// a lock wait that ran out (55P03) and for a connection not had in time, and nothing else does.
import { type PoolLike, recipientHasher, Sender } from "@fin/email";
import { FakeTransport } from "@fin/email/testing";
import { capture, type Line } from "@fin/server/testing";
import { describe, expect, it } from "vitest";
import { runDeliveryCheck } from "./delivery-check.ts";

const RELEASE = "a1".repeat(20);
const POOL_BUSY = "timeout exceeded when trying to connect";

/** An error as Postgres reports a lock wait that ran out. */
function lockTimeout(): Error {
  return Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
}

/** A pool that hands out connections whose every statement throws what `make` gives. */
function failingStatements(make: () => unknown): PoolLike {
  const query = async (): Promise<never> => {
    throw make();
  };
  return { query, connect: async () => ({ query, release: () => undefined }) };
}

/** A pool that cannot hand out a connection in time, as pg-pool says so. */
function noConnection(): PoolLike {
  const fail = async (): Promise<never> => {
    throw new Error(POOL_BUSY);
  };
  return { query: fail, connect: fail };
}

function stalls(lines: Line[]): unknown[] {
  return lines.map((line) => [line.step, line.reason]);
}

describe("email.delivery_stalled through the worker's telemetry", () => {
  it("keeps the sender's step and reason readable, and withholds nothing on the line", async () => {
    for (const [pool, reason] of [
      [failingStatements(lockTimeout), "lock_timeout"],
      [noConnection(), "connect_timeout"],
    ] as const) {
      const { telemetry, clock, events } = capture({ service: "worker" });
      const sender = new Sender({
        db: pool,
        port: new FakeTransport(),
        clock,
        log: telemetry,
        holder: "worker-a:1",
        environment: "staging",
        from: { auth: { address: "account-security@auth.example.com", name: "Fin" } },
        links: { console: "https://console.example.com" },
        hashRecipient: recipientHasher({ version: 1, secret: new Uint8Array(32).fill(3) }),
        random: () => 0.5,
      });
      await expect(sender.runOnce()).rejects.toBeInstanceOf(Error);
      const lines = events("email.delivery_stalled");
      expect(lines).toEqual([
        expect.objectContaining({ level: "error", service: "worker", step: "claim", reason }),
      ]);
      expect(JSON.stringify(lines)).not.toContain("[withheld]");
    }
  });

  it("is written by the delivery check for its run and for its record, beside its failed job.run", async () => {
    for (const [pool, reason, code] of [
      [failingStatements(lockTimeout), "lock_timeout", "pg_55P03"],
      [noConnection(), "connect_timeout", "error"],
    ] as const) {
      const { telemetry, clock, events } = capture({ service: "worker" });
      const result = await runDeliveryCheck({
        db: pool,
        clock,
        release: RELEASE,
        seedInbox: "seed@example.net",
        log: telemetry,
      });
      expect(result).toEqual({ result: "failed", code });
      expect(stalls(events("email.delivery_stalled"))).toEqual([
        ["check", reason],
        ["check_state", reason],
      ]);
      expect(JSON.stringify(events("email.delivery_stalled"))).not.toContain("[withheld]");
      expect(events("job.run")).toEqual([
        expect.objectContaining({ job: "email-delivery-check", result: "failed" }),
      ]);
    }
  });

  it("is not written by the delivery check for an error that is no stall", async () => {
    const { telemetry, clock, events } = capture({ service: "worker" });
    const denied = () => Object.assign(new Error("permission denied"), { code: "42501" });
    const result = await runDeliveryCheck({
      db: failingStatements(denied),
      clock,
      release: RELEASE,
      seedInbox: "seed@example.net",
      log: telemetry,
    });
    expect(result).toEqual({ result: "failed", code: "pg_42501" });
    expect(events("email.delivery_stalled")).toEqual([]);
  });

  it("would lose the reason under `code`, a name the telemetry withholds", () => {
    const { telemetry, events } = capture({ service: "worker" });
    telemetry.log("email.delivery_stalled", { step: "claim", code: "lock_timeout" }, "error");
    expect(events("email.delivery_stalled")[0]?.code).toBe("[withheld]");
  });
});
