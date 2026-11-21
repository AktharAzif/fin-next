// `dist/main.js --worker` end to end against Postgres 18, as the worker's own logins: the api image's
// entry starts the worker, which answers its readiness through the database, sends the start-up
// delivery check and pings its heartbeat, sends a code the console queued as soon as NOTIFY wakes it,
// probes the database as fin_probe, and stops cleanly. Cloudflare is the only thing faked, through
// runService's fetch, as the release image calls it.
import type { FinDatabase } from "@fin/db";
import { createTestDatabase, type TestDatabase, testLoginPassword } from "@fin/db/testing";
import { enqueue, newId } from "@fin/email";
import { baseEnv, type Line } from "@fin/server/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../main.ts";
import { afterMigrations } from "../migrate/main.ts";
import { emailPool } from "./main.ts";

// The integration timeouts, which the root Vitest configuration leaves to each file: a file's
// database is made under the cluster-wide lock that other files' bootstraps may hold.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let db: TestDatabase;

beforeAll(async () => {
  // Exactly what `migrate --migrate` builds: every package's files, then its own after-step. Nothing
  // is applied by hand, so the worker runs on the schema an environment gets.
  db = await createTestDatabase({ prefix: "apiwk", after: afterMigrations("test-release") });
});

afterAll(async () => {
  await db?.drop();
});

async function waitFor(done: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting");
}

describe("the api image started with --worker", () => {
  it("sends the delivery check and a queued code, probes the database, and stops cleanly", async () => {
    // Made at run time: nothing credential-shaped is committed, and every value is checked for below.
    const token = ["worker", "token", "never", "sent", "anywhere"].join("-");
    const limitKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const code = String(10_000_000 + Math.floor(Math.random() * 89_999_999));
    const env = {
      ...baseEnv("worker", { FIN_DRAIN_SECONDS: "5" }),
      FIN_DOCS_ORIGIN: "https://docs.example.net",
      FIN_DB_HOST: db.target.host,
      FIN_DB_PORT: String(db.target.port),
      FIN_DB_NAME: db.target.database,
      FIN_DB_USER: "fin_worker_a",
      FIN_DB_PASSWORD: testLoginPassword("fin_worker_a"),
      FIN_DB_PROBE_PASSWORD: testLoginPassword("fin_probe"),
      FIN_EMAIL_TOKEN: token,
      FIN_EMAIL_ACCOUNT_ID: "ef".repeat(16),
      FIN_EMAIL_FROM: "account-security@auth.example.com",
      FIN_EMAIL_LINK_ORIGINS: JSON.stringify({ console: "https://console.example.com" }),
      FIN_SEED_INBOX: "seed@example.net",
      FIN_LIMIT_KEY_IN_USE: "1",
      FIN_LIMIT_KEY_1: limitKey,
      FIN_HEARTBEAT_EMAIL_DELIVERY_CHECK_URL: "https://heartbeat.example.com/hb",
    };
    const calls: { host: string; auth: string | null }[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ host: url.hostname, auth: new Headers(init?.headers).get("authorization") });
      if (url.hostname === "heartbeat.example.com") return new Response("ok");
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { delivered: ["delivered"], queued: [], permanent_bounces: [] },
      });
    }) as typeof fetch;

    const stdout: Line[] = [];
    const exits: number[] = [];
    const running = await main(["--worker"], {
      run: {
        env,
        exit: (c) => exits.push(c),
        processHandlers: false,
        host: "127.0.0.1",
        port: 0,
        stdout: (text) => stdout.push(JSON.parse(text) as Line),
        fetch: fakeFetch,
      },
    });
    if (running === undefined)
      throw new Error(`the worker did not start: ${JSON.stringify(stdout)}`);
    const sent = (template: string) =>
      stdout.filter((l) => l.event === "email.sent" && l.template === template).length;
    let console_: FinDatabase | undefined;
    try {
      expect(stdout.find((l) => l.event === "process.start")).toMatchObject({ service: "worker" });
      const base = `http://127.0.0.1:${running.port}`;
      expect(await (await fetch(`${base}/readyz`)).json()).toEqual({ status: "ready" });
      expect((await fetch(`${base}/doors/anything`)).status).toBe(403);
      expect(stdout.filter((l) => l.event === "api.outside_request")).toHaveLength(1);

      // The start-up delivery check is queued, sent through Cloudflare, and its heartbeat pinged.
      await waitFor(() => sent("ops/delivery-check") === 1);
      await waitFor(() => calls.some((c) => c.host === "heartbeat.example.com"));
      expect(
        stdout.find((l) => l.event === "job.run" && l.job === "email-delivery-check"),
      ).toMatchObject({ result: "ok", trigger: "release" });

      // A code the console queues wakes the loop through NOTIFY, long before the next 5-second poll.
      console_ = db.database("fin_console");
      const queued = Date.now();
      await enqueue(emailPool(console_.pool), {
        id: newId("eml", { now: () => Date.now() }),
        template: "identity/sign-in-code",
        recipientKind: "address",
        recipient: "person@example.com",
        params: { code },
      });
      await waitFor(() => sent("identity/sign-in-code") === 1, 4_000);
      expect(Date.now() - queued).toBeLessThan(4_000);
      expect(calls.filter((c) => c.host !== "heartbeat.example.com")).toHaveLength(2);
      expect(calls.find((c) => c.host !== "heartbeat.example.com")?.auth).toBe(`Bearer ${token}`);

      // The probe ran at start as fin_probe; the health line reads the pool and the database.
      await waitFor(() =>
        stdout.some((l) => l.event === "job.run" && l.job === "db-probe" && l.result === "ok"),
      );
      expect(await running.health.sample()).toMatchObject({ dbOk: true, poolWaiting: 0 });
      const roles = await db.superuser();
      try {
        const sessions = await roles.query<{ usename: string; application_name: string }>(
          `SELECT usename::text, application_name FROM pg_stat_activity
            WHERE datname = $1 AND application_name LIKE 'fin-worker%' ORDER BY application_name`,
          [db.target.database],
        );
        expect(new Set(sessions.rows.map((r) => `${r.usename} ${r.application_name}`))).toEqual(
          new Set([
            "fin_worker_a fin-worker",
            "fin_worker_a fin-worker-listen",
            "fin_probe fin-worker-probe",
          ]),
        );
      } finally {
        await roles.end();
      }
    } finally {
      await running.shutdown.begin("SIGTERM");
    }
    expect(exits).toEqual([0]);
    expect(stdout.filter((l) => l.event === "background.failed")).toEqual([]);
    expect(stdout.find((l) => l.event === "shutdown.done")).toBeDefined();

    // Every connection the worker opened is closed.
    const after = await db.superuser();
    try {
      const left = await after.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND application_name LIKE 'fin-worker%'",
        [db.target.database],
      );
      expect(left.rows).toEqual([]);
    } finally {
      await after.end();
    }

    // IDs and codes only: no address, code, token, key or password reaches a line.
    const text = JSON.stringify(stdout);
    for (const value of [
      "seed@example.net",
      "person@example.com",
      code,
      token,
      limitKey,
      testLoginPassword("fin_worker_a"),
      testLoginPassword("fin_probe"),
    ]) {
      expect(text).not.toContain(value);
    }
  });
});
