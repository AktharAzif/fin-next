// The database probe as fin_probe (pg_monitor only) against Postgres 18.

import { createDatabase, createPool, discardLines, type FinDatabase } from "@fin/db";
import {
  collectLines,
  createTestDatabase,
  type TestDatabase,
  testContext,
  testLoginPassword,
} from "@fin/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeDatabaseFromEnv, readDatabaseProbe, runDatabaseProbe } from "./probe.ts";

let db: TestDatabase;
let probe: FinDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ prefix: "p0e" });
  const pool = createPool(
    {
      ...db.target,
      user: "fin_probe",
      password: testLoginPassword("fin_probe"),
      tls: { insecureLoopback: true },
      applicationName: "fin-worker-probe",
      max: 1,
    },
    discardLines,
  );
  probe = createDatabase({ pool });
});

afterAll(async () => {
  await probe?.end();
  await db?.drop();
});

describe("the database probe", () => {
  it("reads the archiver, replication, timeline, transactions, connections, size and audit age", async () => {
    const reading = await probe.read(testContext(), readDatabaseProbe);
    expect(reading.archiverFailed).toBeGreaterThanOrEqual(0);
    expect(reading.replicas).toBeGreaterThanOrEqual(0);
    expect(reading.timeline).toBeGreaterThanOrEqual(1);
    expect(reading.inRecovery).toBe(false);
    expect(reading.longestTxS).toBeGreaterThanOrEqual(0);
    expect(reading.connectionsByRole.fin_probe).toBeGreaterThanOrEqual(1);
    expect(reading.connections).toBeGreaterThanOrEqual(1);
    expect(reading.sizeMb).toBeGreaterThan(0);
    expect(reading.auditUnsequencedS).toBe(0);
  });

  it("writes one job.run line per run, with the readings and no value but counts and codes", async () => {
    const lines = collectLines();
    let now = 0;
    const clock = {
      now: () => {
        now += 5;
        return now;
      },
    };
    await runDatabaseProbe(probe, testContext(), clock, lines);
    expect(lines.lines).toHaveLength(1);
    expect(lines.lines[0]?.event).toBe("job.run");
    expect(lines.lines[0]?.fields).toMatchObject({
      job: "db-probe",
      result: "ok",
      durationMs: 5,
      auditUnsequencedS: 0,
    });
    expect(typeof lines.lines[0]?.fields.connectionsByRole).toBe("object");
  });

  it("writes a failed run with the SQLSTATE when the probe cannot read (a login without its grants)", async () => {
    const lines = collectLines();
    const api = db.database("fin_api");
    const reading = await runDatabaseProbe(api, testContext(), { now: () => Date.now() }, lines);
    expect(reading).toBeNull();
    expect(lines.lines[0]?.fields).toMatchObject({
      job: "db-probe",
      result: "failed",
      code: "42501",
    });
  });

  it("builds its pool from the worker's environment, refusing it without the pinned CA", () => {
    expect(() =>
      probeDatabaseFromEnv(
        {
          FIN_DB_HOST: "h",
          FIN_DB_PORT: "5432",
          FIN_DB_NAME: "d",
          FIN_DB_PROBE_PASSWORD: "x".repeat(20),
        },
        discardLines,
      ),
    ).toThrow(/FIN_DB_CA_PEM/);
  });
});
