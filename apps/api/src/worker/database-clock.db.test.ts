// process.health's `clockSkewMs` against Postgres 18 (DECISIONS CF-72; ARCHITECTURE §10.2): the
// clock query runs as the worker's own login through a pool made as the worker makes it, reads the
// database's clock_timestamp() (the moment it is evaluated, not now()'s transaction start), and
// measures a process clock that is ahead of or behind the database by a known amount.
import { type Clock, systemClock } from "@fin/core";
import { createPool, type PgPool } from "@fin/db";
import {
  collectLines,
  createTestDatabase,
  type TestDatabase,
  testLoginPassword,
} from "@fin/db/testing";
import {
  type ClockClient,
  type ClockPool,
  DATABASE_CLOCK_SQL,
  sampleDatabaseClock,
} from "@fin/server/process-health";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/** The local database shares the test's host clock; this bounds the round trip's noise. */
const NOISE_MS = 250;
/** How long the open transaction waits before the clock is read inside it. */
const WAIT_S = 1.5;

let db: TestDatabase;
let pool: PgPool;

beforeAll(async () => {
  db = await createTestDatabase({ prefix: "apiclk", packages: ["db"] });
  pool = createPool(
    {
      host: db.target.host,
      port: db.target.port,
      database: db.target.database,
      user: "fin_worker_a",
      password: testLoginPassword("fin_worker_a"),
      tls: { insecureLoopback: true },
      applicationName: "fin-worker-clock-test",
      max: 1,
    },
    collectLines(),
  );
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const offset = (ms: number): Clock => ({ now: () => systemClock.now() + ms });

describe("sampleDatabaseClock against Postgres 18", () => {
  it("runs as the worker's login and returns the client to the pool", async () => {
    const sample = await sampleDatabaseClock(pool, systemClock);
    expect(sample.dbOk).toBe(true);
    expect(typeof sample.clockSkewMs).toBe("number");
    expect(Math.abs(sample.clockSkewMs ?? Number.POSITIVE_INFINITY)).toBeLessThan(NOISE_MS);
    expect(pool.totalCount - pool.idleCount).toBe(0);
    expect(pool.waitingCount).toBe(0);
  });

  it("measures a process clock ahead of the database as positive, and behind as negative", async () => {
    const ahead = await sampleDatabaseClock(pool, offset(90_000));
    const behind = await sampleDatabaseClock(pool, offset(-45_000));
    expect(ahead.dbOk && behind.dbOk).toBe(true);
    expect(Math.abs((ahead.clockSkewMs ?? 0) - 90_000)).toBeLessThan(NOISE_MS);
    expect(Math.abs((behind.clockSkewMs ?? 0) + 45_000)).toBeLessThan(NOISE_MS);
  });

  it("reads clock_timestamp(): inside a transaction that has waited, the time is the current one", async () => {
    // A client that arrives inside an open transaction, started WAIT_S ago.
    const held = await pool.connect();
    try {
      await held.query("BEGIN");
      await held.query("SELECT pg_sleep($1)", [WAIT_S]);
      const one: ClockPool = {
        connect: async (): Promise<ClockClient> => ({
          query: (text) => held.query(text),
          release: () => undefined,
        }),
      };
      const sample = await sampleDatabaseClock(one, systemClock);
      expect(sample.dbOk).toBe(true);
      expect(Math.abs(sample.clockSkewMs ?? Number.POSITIVE_INFINITY)).toBeLessThan(NOISE_MS);

      // The same measurement over now() would be the transaction's start, WAIT_S stale: the test
      // tells the two apart.
      const stale = DATABASE_CLOCK_SQL.replace("clock_timestamp()", "now()");
      expect(stale).not.toBe(DATABASE_CLOCK_SQL);
      const sent = systemClock.now();
      const result = await held.query<{ at_ms: number }>(stale);
      const received = systemClock.now();
      const staleSkew = (sent + received) / 2 - Number(result.rows[0]?.at_ms);
      expect(staleSkew).toBeGreaterThan(WAIT_S * 1_000 - NOISE_MS);
      expect(await held.query("SELECT 1")).toMatchObject({ rowCount: 1 });
    } finally {
      await held.query("ROLLBACK").catch(() => undefined);
      held.release();
    }
  });

  it("is dbOk false with no skew when the database cannot be reached, and never throws", async () => {
    const closed = createPool(
      {
        host: "127.0.0.1",
        port: 1,
        database: "fin",
        user: "fin_worker_a",
        password: testLoginPassword("fin_worker_a"),
        tls: { insecureLoopback: true },
        applicationName: "fin-worker-clock-test",
        max: 1,
      },
      collectLines(),
    );
    try {
      expect(await sampleDatabaseClock(closed, systemClock)).toEqual({
        dbOk: false,
        clockSkewMs: null,
      });
    } finally {
      await closed.end();
    }
  });
});
