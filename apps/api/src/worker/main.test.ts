// The worker's own pieces, without a database: the probe duty's cadence and its one-run-at-a-time
// rule, the readiness check's cache, the pool seam the email code runs on, and a start whose database
// cannot be reached (it serves, says it is not ready, and stops cleanly).
import type { FinDatabase, Line, PgPool } from "@fin/db";
import { FakeTransport } from "@fin/email/testing";
import { runService } from "@fin/server";
import { baseEnv, type Line as StdoutLine } from "@fin/server/testing";
import { describe, expect, it } from "vitest";
import {
  buildWorker,
  DB_CHECK_CACHE_MS,
  databaseCheck,
  emailPool,
  PROBE_EVERY_MS,
  startProbeDuty,
  telemetrySink,
} from "./main.ts";

function lines(): { written: Line[]; write: (line: Line) => void } {
  const written: Line[] = [];
  return { written, write: (line) => written.push(line) };
}

/** A scheduler whose timers the test fires by hand. */
function manualSchedule() {
  const timers: { run: () => void; everyMs: number; cancelled: boolean }[] = [];
  return {
    timers,
    schedule: (run: () => void, everyMs: number) => {
      const timer = { run, everyMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
}

interface FakeClient {
  queries: string[];
  released: unknown[];
  status: "I" | "T" | "E" | null;
}

/** A pool whose clients record their statements and how they were given back. */
function fakePool(answer: (text: string) => Promise<unknown> = async () => ({ rows: [] })) {
  const clients: FakeClient[] = [];
  const pool = {
    connect: async () => {
      const record: FakeClient = { queries: [], released: [], status: "I" };
      clients.push(record);
      return {
        query: async (text: string) => {
          record.queries.push(text);
          if (text === "BEGIN") record.status = "T";
          const result = await answer(text);
          return { rows: [], rowCount: 0, command: "SELECT", fields: [], ...(result as object) };
        },
        release: (destroy?: unknown) => {
          record.released.push(destroy);
        },
        getTransactionStatus: () => record.status,
      };
    },
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  };
  return { pool: pool as unknown as PgPool, clients };
}

describe("the probe duty", () => {
  it("runs at start and on each timer, every minute; without its pool each run is a skipped job.run", async () => {
    const log = lines();
    const timers = manualSchedule();
    const duty = startProbeDuty({
      probe: undefined,
      clock: { now: () => 0 },
      release: "r",
      log,
      schedule: timers.schedule,
    });
    await duty.idle();
    expect(timers.timers.map((t) => t.everyMs)).toEqual([PROBE_EVERY_MS]);
    timers.timers[0]?.run();
    await duty.idle();
    expect(log.written).toEqual([
      {
        event: "job.run",
        level: "warn",
        fields: {
          job: "db-probe",
          trigger: "schedule",
          result: "skipped",
          skipReason: "not_configured",
        },
      },
      expect.objectContaining({ event: "job.run" }),
    ]);
    await duty.stop();
    expect(timers.timers[0]?.cancelled).toBe(true);
    timers.timers[0]?.run();
    expect(log.written).toHaveLength(2);
  });

  it("starts no run while one is still going, writes a failed run's code, and ends its pool on stop", async () => {
    const log = lines();
    const timers = manualSchedule();
    let reads = 0;
    let ended = false;
    let release: () => void = () => undefined;
    const probe = {
      read: async () => {
        reads += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw Object.assign(new Error("terminating connection"), { code: "57P01" });
      },
      end: async () => {
        ended = true;
      },
    } as unknown as FinDatabase;
    let now = 1_000;
    const duty = startProbeDuty({
      probe,
      clock: { now: () => (now += 5) },
      release: "r",
      log,
      schedule: timers.schedule,
    });
    timers.timers[0]?.run();
    timers.timers[0]?.run();
    expect(reads).toBe(1);
    release();
    await duty.idle();
    expect(log.written).toEqual([
      {
        event: "job.run",
        level: "error",
        fields: expect.objectContaining({ job: "db-probe", result: "failed", code: "57P01" }),
      },
    ]);
    await duty.stop();
    expect(ended).toBe(true);
  });
});

describe("the database check", () => {
  it("runs SELECT 1, shares one run between callers, and reuses the answer for a second", async () => {
    const { pool, clients } = fakePool();
    let now = 0;
    const check = databaseCheck(pool, { now: () => now });
    expect(await Promise.all([check(), check(), check()])).toEqual([true, true, true]);
    expect(clients).toHaveLength(1);
    expect(clients[0]).toEqual({ queries: ["SELECT 1"], released: [undefined], status: "I" });
    now += DB_CHECK_CACHE_MS - 1;
    expect(await check()).toBe(true);
    expect(clients).toHaveLength(1);
    now += 1;
    expect(await check()).toBe(true);
    expect(clients).toHaveLength(2);
  });

  it("answers false, never throws, when the database cannot be reached or refuses", async () => {
    const refused = databaseCheck(
      fakePool(async () => {
        throw Object.assign(new Error("no"), { code: "28P01" });
      }).pool,
      { now: () => 0 },
    );
    expect(await refused()).toBe(false);
    const unreachable = databaseCheck(
      {
        connect: async () => {
          throw new Error("ECONNREFUSED");
        },
      } as unknown as PgPool,
      { now: () => 0 },
    );
    expect(await unreachable()).toBe(false);
  });
});

describe("the email code's pool seam", () => {
  it("runs a lone statement on a client of its own and gives it straight back", async () => {
    const { pool, clients } = fakePool(async () => ({ rows: [{ n: 1 }], rowCount: 1 }));
    const result = await emailPool(pool).query<{ n: number }>("SELECT 1 AS n");
    expect(result.rows).toEqual([{ n: 1 }]);
    expect(clients[0]?.released).toEqual([undefined]);
  });

  it("destroys a client left inside a transaction, and passes an error on", async () => {
    const { pool, clients } = fakePool();
    const seam = emailPool(pool);
    const left = await seam.connect();
    await left.query("BEGIN");
    left.release(false);
    expect(clients[0]?.released).toEqual([true]);
    const broken = await seam.connect();
    const error = new Error("rollback failed");
    broken.release(error);
    expect(clients[1]?.released).toEqual([error]);
    const clean = await seam.connect();
    clean.release(false);
    expect(clients[2]?.released).toEqual([undefined]);
  });
});

describe("a worker whose database cannot be reached", () => {
  it("still serves its health, answers not ready, fails each run with a line, and stops cleanly", async () => {
    const timers = manualSchedule();
    const port = new FakeTransport();
    const stdout: StdoutLine[] = [];
    const exits: number[] = [];
    const limitKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const running = await runService(
      {
        services: ["worker"],
        build: (ctx) => buildWorker(ctx, { schedule: timers.schedule, emailPort: port }),
      },
      {
        env: baseEnv("worker", {
          FIN_DRAIN_SECONDS: "5",
          FIN_DOCS_ORIGIN: "https://docs.example.net",
          FIN_EMAIL_TOKEN: ["unused", "because", "the", "port", "is", "fake"].join("-"),
          FIN_EMAIL_ACCOUNT_ID: "ef".repeat(16),
          FIN_EMAIL_FROM: "account-security@auth.example.com",
          FIN_EMAIL_LINK_ORIGINS: JSON.stringify({ console: "https://console.example.com" }),
          FIN_SEED_INBOX: "seed@example.net",
          FIN_LIMIT_KEY_IN_USE: "1",
          FIN_LIMIT_KEY_1: limitKey,
          // Port 1 on loopback refuses at once: nothing listens there.
          FIN_DB_HOST: "127.0.0.1",
          FIN_DB_PORT: "1",
          FIN_DB_NAME: "fin",
          FIN_DB_USER: "fin_worker_a",
          FIN_DB_PASSWORD: limitKey,
        }),
        exit: (code) => exits.push(code),
        processHandlers: false,
        host: "127.0.0.1",
        port: 0,
        stdout: (text) => stdout.push(JSON.parse(text) as StdoutLine),
      },
    );
    if (running === undefined)
      throw new Error(`the worker did not start: ${JSON.stringify(stdout)}`);
    try {
      const base = `http://127.0.0.1:${running.port}`;
      expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: "ok" });
      const ready = await fetch(`${base}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: "not_ready", failing: ["database"] });
      // The start tick failed; the poll (its timer, fired by hand) tries again and fails again, each
      // with its line.
      const failed = () =>
        stdout.filter(
          (l) => l.event === "job.run" && l.job === "email-send" && l.result === "failed",
        ).length;
      for (let i = 0; i < 100 && failed() < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      timers.timers.find((t) => t.everyMs === 5_000)?.run();
      for (let i = 0; i < 100 && failed() < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(failed()).toBe(2);
      expect(stdout.find((l) => l.job === "db-probe")).toMatchObject({
        result: "skipped",
        skipReason: "not_configured",
      });
      expect(await running.health.sample()).toMatchObject({ dbOk: false });
      expect(port.sent).toEqual([]);
    } finally {
      await running.shutdown.begin("SIGTERM");
    }
    expect(exits).toEqual([0]);
    expect(timers.timers.every((t) => t.cancelled)).toBe(true);
    expect(stdout.filter((l) => l.event === "background.failed" && l.task !== undefined)).toEqual(
      [],
    );
    expect(JSON.stringify(stdout)).not.toContain(limitKey);
  }, 20_000);
});

describe("the line sink", () => {
  it("writes @fin/db's lines into the telemetry with their level", () => {
    const logged: unknown[][] = [];
    telemetrySink({ log: (...args) => void logged.push(args) }).write({
      event: "database.pool_error",
      level: "error",
      fields: { code: "57P01" },
    });
    expect(logged).toEqual([["database.pool_error", { code: "57P01" }, "error"]]);
  });
});
