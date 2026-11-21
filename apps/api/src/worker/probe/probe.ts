// The database probe (ARCHITECTURE §4.5; spec 08 §7.2, §7.8): a worker duty, every minute, as fin_probe,
// which holds pg_monitor and nothing else in Fin's schemas but the readings below. One `job.run` line
// per run (`job: "db-probe"`) with the WAL archiver's lag and failures, replication, the timeline (a
// failover moves it), the longest open transaction, connections per role, the database's size and the
// age of the oldest unchained audit row, which it reads even when the sequencer has stopped.
import {
  type Clock,
  createDatabase,
  createPool,
  DatabaseConfigError,
  type FinDatabase,
  type LineSink,
  type PoolSettings,
  type Queryable,
  type UnitContext,
} from "@fin/db";
import { z } from "zod";

export interface ProbeReading {
  archiverLagS: number | null;
  archiverFailed: number;
  replicas: number;
  replayLagS: number | null;
  syncState: string | null;
  timeline: number | null;
  inRecovery: boolean;
  longestTxS: number;
  connections: number;
  connectionsByRole: Record<string, number>;
  sizeMb: number;
  auditUnsequencedS: number;
}

export async function readDatabaseProbe(q: Queryable): Promise<ProbeReading> {
  const archiver = await q.query<{ lag: number | null; failed: string }>(
    `SELECT floor(extract(epoch FROM now() - last_archived_time))::int AS lag, failed_count::text AS failed
     FROM pg_catalog.pg_stat_archiver`,
  );
  const replication = await q.query<{ replicas: number; lag: number | null; sync: string | null }>(
    `SELECT count(*)::int AS replicas, max(extract(epoch FROM replay_lag))::float8 AS lag,
            string_agg(DISTINCT sync_state, ',' ORDER BY sync_state) AS sync
     FROM pg_catalog.pg_stat_replication`,
  );
  const control = await q.query<{ timeline: number | null; recovery: boolean }>(
    "SELECT (SELECT timeline_id FROM pg_catalog.pg_control_checkpoint()) AS timeline, pg_catalog.pg_is_in_recovery() AS recovery",
  );
  const activity = await q.query<{ longest: number | null; role: string | null; n: number }>(
    `SELECT NULL::int AS longest, usename::text AS role, count(*)::int AS n
     FROM pg_catalog.pg_stat_activity WHERE datname = current_database() AND usename IS NOT NULL GROUP BY usename
     UNION ALL
     SELECT floor(coalesce(max(extract(epoch FROM now() - xact_start)), 0))::int, NULL, 0
     FROM pg_catalog.pg_stat_activity WHERE xact_start IS NOT NULL AND pid <> pg_catalog.pg_backend_pid()`,
  );
  const size = await q.query<{ mb: number }>(
    "SELECT (pg_catalog.pg_database_size(current_database()) / 1048576)::int AS mb",
  );
  const audit = await q.query<{ age: number }>("SELECT audit.unsequenced_age() AS age");

  const byRole: Record<string, number> = {};
  let longest = 0;
  for (const row of activity.rows) {
    if (row.role === null) longest = row.longest ?? 0;
    else byRole[row.role] = row.n;
  }
  return {
    archiverLagS: archiver.rows[0]?.lag ?? null,
    archiverFailed: Number(archiver.rows[0]?.failed ?? 0),
    replicas: replication.rows[0]?.replicas ?? 0,
    replayLagS: replication.rows[0]?.lag ?? null,
    syncState: replication.rows[0]?.sync ?? null,
    timeline: control.rows[0]?.timeline ?? null,
    inRecovery: control.rows[0]?.recovery ?? false,
    longestTxS: longest,
    connections: Object.values(byRole).reduce((a, b) => a + b, 0),
    connectionsByRole: byRole,
    sizeMb: size.rows[0]?.mb ?? 0,
    auditUnsequencedS: audit.rows[0]?.age ?? 0,
  };
}

/** One run of the duty: reads, writes its `job.run` line, and returns the reading (or null on failure). */
export async function runDatabaseProbe(
  db: FinDatabase,
  context: UnitContext,
  clock: Clock,
  log: LineSink,
): Promise<ProbeReading | null> {
  const started = clock.now();
  try {
    const reading = await db.read(context, readDatabaseProbe);
    log.write({
      event: "job.run",
      level: "info",
      fields: {
        job: "db-probe",
        trigger: "schedule",
        result: "ok",
        durationMs: clock.now() - started,
        archiverLagS: reading.archiverLagS,
        archiverFailed: reading.archiverFailed,
        replicas: reading.replicas,
        replayLagS: reading.replayLagS,
        syncState: reading.syncState,
        timeline: reading.timeline,
        longestTxS: reading.longestTxS,
        connections: reading.connections,
        connectionsByRole: reading.connectionsByRole,
        sizeMb: reading.sizeMb,
        auditUnsequencedS: reading.auditUnsequencedS,
      },
    });
    return reading;
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "unknown";
    log.write({
      event: "job.run",
      level: "error",
      fields: {
        job: "db-probe",
        trigger: "schedule",
        result: "failed",
        durationMs: clock.now() - started,
        code,
      },
    });
    return null;
  }
}

const probeEnv = z.object({
  FIN_DB_HOST: z.string().min(1),
  FIN_DB_PORT: z.string().regex(/^[1-9][0-9]{0,4}$/),
  FIN_DB_NAME: z.string().min(1),
  FIN_DB_PROBE_PASSWORD: z.string().min(16).max(256),
  FIN_DB_CA_PEM: z.string().min(1),
});

/**
 * The probe's own one-connection pool, as fin_probe. FIN_DB_PROBE_PASSWORD is the worker's second
 * database credential (recorded as an open item for spec 01 §6.7's table and the provisioning).
 */
export function probeDatabaseFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  log: LineSink,
): FinDatabase {
  const parsed = probeEnv.safeParse(env);
  if (!parsed.success) {
    throw new DatabaseConfigError(
      String(parsed.error.issues[0]?.path[0] ?? "FIN_DB_*"),
      "is missing or malformed",
    );
  }
  const e = parsed.data;
  const settings: PoolSettings = {
    host: e.FIN_DB_HOST,
    port: Number(e.FIN_DB_PORT),
    database: e.FIN_DB_NAME,
    user: "fin_probe",
    password: e.FIN_DB_PROBE_PASSWORD,
    tls: { caPem: e.FIN_DB_CA_PEM, servername: e.FIN_DB_HOST },
    applicationName: "fin-worker-probe",
    max: 1,
  };
  return createDatabase({ pool: createPool(settings, log) });
}
