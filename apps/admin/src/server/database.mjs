// Fin Admin's database: @fin/db's pool (SCRAM only, TLS pinned to FIN_DB_CA_PEM outside a loopback
// test database, the pool budget of ARCHITECTURE §4.5) under @fin/identity's unit of work, which the
// staff realm and every staff route run in.
//
// This file is JavaScript, typed by database.d.mts, for one reason recorded in the pull request:
// @fin/db and @fin/identity each declare the `pg` module for themselves, and the two declarations
// cannot share one TypeScript program, so the one place that joins them is read by TypeScript
// through its declaration only. It goes when the two declarations become one.
import { createPool, poolSettingsFromEnv } from "@fin/db";
import { createPgDatabase } from "@fin/identity";
import { sampleDatabaseClock } from "@fin/server/process-health";

export function openAdminDatabase({ env, clock, release, lines }) {
  const pool = createPool(poolSettingsFromEnv(env, "admin"), {
    write: (line) => lines.write(line.event, line.level, line.fields ?? {}),
  });
  const db = createPgDatabase({ pool, clock, release, lines });
  return {
    db,
    close: () => pool.end(),
    stats: () => ({
      poolTotal: pool.totalCount,
      poolIdle: pool.idleCount,
      poolWaiting: pool.waitingCount,
    }),
    // dbOk and the process's clock against the database's, on a client held for that one query.
    sampleClock: (processClock) => sampleDatabaseClock(pool, processClock),
  };
}
