// `process.health`'s fields (ARCHITECTURE §10.2, §4.5): the HTTP server's sockets are
// `httpConnections`; `listenConnected` belongs to the Postgres LISTEN client and comes only from
// the database layer; what a process adds never replaces a core field.
import { createManualClock, type ManualClock } from "@fin/core";
import { describe, expect, it } from "vitest";
import { capture } from "../testing/capture.ts";
import {
  type ClockClient,
  type ClockPool,
  DATABASE_CLOCK_SQL,
  sampleDatabaseClock,
  startProcessHealth,
} from "./process-health.ts";

describe("startProcessHealth", () => {
  it("reports the HTTP sockets as httpConnections, and no listenConnected of its own", async () => {
    const { telemetry } = capture();
    const health = startProcessHealth({ telemetry, httpConnections: async () => 0 });
    try {
      const fields = await health.sample();
      expect(fields).toMatchObject({
        httpConnections: 0,
        heapUsedMb: expect.any(Number),
        rssMb: expect.any(Number),
        background: 0,
      });
      expect(fields).not.toHaveProperty("listenConnected");
    } finally {
      health.stop();
    }
  });

  it("reports null, never zero, when a value cannot be read", async () => {
    const { telemetry } = capture();
    const failing = startProcessHealth({
      telemetry,
      httpConnections: async () => {
        throw new Error("closed");
      },
    });
    const none = startProcessHealth({ telemetry });
    try {
      expect((await failing.sample()).httpConnections).toBeNull();
      expect((await none.sample()).httpConnections).toBeNull();
    } finally {
      failing.stop();
      none.stop();
    }
  });

  it("adds the database layer's fields, which never replace a core one", async () => {
    const { telemetry } = capture();
    const health = startProcessHealth({
      telemetry,
      httpConnections: async () => 3,
      extra: async () => ({ listenConnected: true, poolWaiting: 0, httpConnections: 99 }),
    });
    try {
      expect(await health.sample()).toMatchObject({
        listenConnected: true,
        poolWaiting: 0,
        httpConnections: 3,
      });
    } finally {
      health.stop();
    }
  });
});

/**
 * A pool of one fake client: connecting takes `connectMs` and the query `roundTripMs` on the
 * injected clock, and the database answers with its own time at the round trip's midpoint, `skewMs`
 * behind the process (ahead when negative).
 */
function fakePool(
  clock: ManualClock,
  o: { skewMs?: number; roundTripMs?: number; connectMs?: number; answer?: () => unknown } = {},
) {
  const queries: string[] = [];
  const released: (Error | undefined)[] = [];
  let connects = 0;
  const client: ClockClient = {
    async query(text) {
      queries.push(text);
      const half = (o.roundTripMs ?? 0) / 2;
      clock.advance(half);
      const at = o.answer !== undefined ? o.answer() : clock.now() - (o.skewMs ?? 0);
      clock.advance(half);
      return { rows: [{ at_ms: at }] };
    },
    release(error) {
      released.push(error);
    },
  };
  const pool: ClockPool = {
    async connect() {
      connects++;
      clock.advance(o.connectMs ?? 0);
      return client;
    },
  };
  return { pool, queries, released, connects: () => connects };
}

describe("sampleDatabaseClock", () => {
  const T = Date.UTC(2026, 10, 22, 12, 0, 0);

  it("reports a process ahead of the database as a positive skew, and one behind as negative", async () => {
    // Each fake pool moves the clock the sampler reads.
    const clockA = createManualClock(T);
    const a = await sampleDatabaseClock(
      fakePool(clockA, { skewMs: 1_500, roundTripMs: 40 }).pool,
      clockA,
    );
    const clockB = createManualClock(T);
    const b = await sampleDatabaseClock(
      fakePool(clockB, { skewMs: -2_500, roundTripMs: 40 }).pool,
      clockB,
    );
    expect(a).toEqual({ dbOk: true, clockSkewMs: 1_500 });
    expect(b).toEqual({ dbOk: true, clockSkewMs: -2_500 });
    // The alert reads the absolute value, so either direction past its threshold fires.
    expect([a, b].map((s) => Math.abs(s.clockSkewMs ?? 0))).toEqual([1_500, 2_500]);
  });

  it("corrects by half the round trip, and leaves the connection's setup out of it", async () => {
    const clock = createManualClock(T);
    const fake = fakePool(clock, { skewMs: 0, roundTripMs: 400, connectMs: 5_000 });
    expect(await sampleDatabaseClock(fake.pool, clock)).toEqual({ dbOk: true, clockSkewMs: 0 });
    const slow = createManualClock(T);
    expect(
      await sampleDatabaseClock(fakePool(slow, { skewMs: 300, roundTripMs: 1_001 }).pool, slow),
    ).toEqual({ dbOk: true, clockSkewMs: 300 });
  });

  it("asks for clock_timestamp(), never now(), on one client it releases at once", async () => {
    const clock = createManualClock(T);
    const fake = fakePool(clock);
    await sampleDatabaseClock(fake.pool, clock);
    expect(fake.queries).toEqual([DATABASE_CLOCK_SQL]);
    expect(DATABASE_CLOCK_SQL).toContain("clock_timestamp()");
    expect(DATABASE_CLOCK_SQL).not.toMatch(/\bnow\(\)|current_timestamp|transaction_timestamp/i);
    expect(fake.connects()).toBe(1);
    expect(fake.released).toEqual([undefined]);
  });

  it("takes the value pg gives as text, and reports null when there is none", async () => {
    const clock = createManualClock(T);
    const text = fakePool(clock, { answer: () => String(clock.now() - 75) });
    expect(await sampleDatabaseClock(text.pool, clock)).toEqual({ dbOk: true, clockSkewMs: 75 });
    for (const answer of [null, undefined, "", "soon", Number.NaN]) {
      const fake = fakePool(clock, { answer: () => answer });
      expect(await sampleDatabaseClock(fake.pool, clock), String(answer)).toEqual({
        dbOk: true,
        clockSkewMs: null,
      });
      expect(fake.released).toEqual([undefined]);
    }
  });

  it("never throws: a pool that cannot connect or a failed query is dbOk false, the client destroyed", async () => {
    const clock = createManualClock(T);
    const refused: ClockPool = {
      connect: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    };
    expect(await sampleDatabaseClock(refused, clock)).toEqual({ dbOk: false, clockSkewMs: null });

    const error = new Error("query timeout");
    const released: (Error | undefined)[] = [];
    const failing: ClockPool = {
      connect: async () => ({
        query: async () => {
          throw error;
        },
        release: (e) => void released.push(e),
      }),
    };
    expect(await sampleDatabaseClock(failing, clock)).toEqual({ dbOk: false, clockSkewMs: null });
    expect(released).toEqual([error]);
  });
});
