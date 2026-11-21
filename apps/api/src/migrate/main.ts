// The `migrate` service (spec 01 §6.2, §6.6; ARCHITECTURE §6.4): the api image started with one of
//   --bootstrap       create the roles, schemas and privileged-login guard (once per environment)
//   --migrate         apply pending migrations, render the grants, and sync the audit registry and
//                     email.enqueue()'s template allowlist (afterMigrations)
//   --print-db-cert   print the certificate chain the database presents, to pin as FIN_DB_CA_PEM
//   --task <name>     run one operator task as fin_owner (spec 01 §6.6 "Operator tasks")
// P0-D's apps/api/src/main.ts dispatches these flags here. Every mode reads its configuration once,
// refuses a missing or malformed variable with exit 78 naming it (never its value), writes
// migrate.started and migrate.done or migrate.failed (or task.done / task.failed), and exits non-zero on
// any failure, which stops the deploy.
import { syncEventTypes } from "@fin/audit";
import {
  bootstrap,
  type Clock,
  connectClient,
  createDatabase,
  createPool,
  DatabaseConfigError,
  dbAssetsRoot,
  type LineSink,
  type LoadedDbAssets,
  loadDbAssets,
  MigrationError,
  parseReplicas,
  parseRoleVerifiers,
  parseSuperuserUrl,
  type Queryable,
  readPresentedCertificate,
  runMigrations,
  sqlState,
  type TlsSettings,
  withOwnerSession,
} from "@fin/db";
import { grantInsertSql } from "@fin/email";
import { z } from "zod";
import { parseTaskParams, runTask, TaskError } from "../tasks/run.ts";
import { stdoutLines } from "./lines.ts";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 64;
export const EXIT_CONFIG = 78;

export type Mode =
  | { mode: "bootstrap" }
  | { mode: "migrate" }
  | { mode: "print-db-cert" }
  | { mode: "task"; task: string };

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export function parseArgs(argv: readonly string[]): Mode {
  const args = argv.filter((a) => a !== "--");
  if (args.length === 1 && args[0] === "--bootstrap") return { mode: "bootstrap" };
  if (args.length === 1 && args[0] === "--migrate") return { mode: "migrate" };
  if (args.length === 1 && args[0] === "--print-db-cert") return { mode: "print-db-cert" };
  if (args.length === 2 && args[0] === "--task" && /^[a-z][a-z0-9-]{1,62}$/.test(args[1] ?? "")) {
    return { mode: "task", task: args[1] ?? "" };
  }
  throw new UsageError("usage: --bootstrap | --migrate | --print-db-cert | --task <name>");
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

const baseEnv = z.object({
  FIN_ENVIRONMENT: z.enum(["development", "ci", "staging", "production"]),
  FIN_RELEASE: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  FIN_RUN_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,51}$/)
    .optional(),
  FIN_DB_CA_PEM: z.string().optional(),
  FIN_DB_ASSETS_DIR: z.string().optional(),
  RAILWAY_REPLICA_ID: z.string().max(64).optional(),
});
type BaseEnv = z.infer<typeof baseEnv>;

function readBase(env: Readonly<Record<string, string | undefined>>): BaseEnv {
  const parsed = baseEnv.safeParse(env);
  if (!parsed.success) {
    throw new DatabaseConfigError(
      String(parsed.error.issues[0]?.path[0] ?? "FIN_*"),
      "is missing or malformed",
    );
  }
  const base = parsed.data;
  if (
    (base.FIN_ENVIRONMENT === "staging" || base.FIN_ENVIRONMENT === "production") &&
    !/^[0-9a-f]{40}$/.test(base.FIN_RELEASE)
  ) {
    throw new DatabaseConfigError("FIN_RELEASE", "must be the 40-character commit SHA");
  }
  return base;
}

function tlsFor(base: BaseEnv, host: string): TlsSettings {
  if (base.FIN_DB_CA_PEM !== undefined && base.FIN_DB_CA_PEM !== "") {
    return { caPem: base.FIN_DB_CA_PEM, servername: host };
  }
  if (
    (base.FIN_ENVIRONMENT === "development" || base.FIN_ENVIRONMENT === "ci") &&
    LOOPBACK.has(host)
  ) {
    return { insecureLoopback: true };
  }
  throw new DatabaseConfigError("FIN_DB_CA_PEM", "is required outside a loopback test database");
}

/**
 * Every package's bootstrap, migrations and grants, read and checked before any connection: from
 * FIN_DB_ASSETS_DIR in the image (ops/docker/app.Dockerfile sets it), from the source tree locally.
 */
function assets(base: BaseEnv): LoadedDbAssets {
  return loadDbAssets(dbAssetsRoot({ FIN_DB_ASSETS_DIR: base.FIN_DB_ASSETS_DIR }));
}

function applicationName(base: BaseEnv): string {
  return base.FIN_RUN_ID === undefined ? "fin-migrate" : `fin-migrate:${base.FIN_RUN_ID}`;
}

function failureCode(error: unknown): string {
  if (error instanceof MigrationError || error instanceof TaskError) return error.code;
  if (error instanceof DatabaseConfigError) return "config";
  if (error instanceof UsageError) return "usage";
  return sqlState(error) ?? (error instanceof Error ? error.name : "unknown");
}

function exitCodeFor(error: unknown): number {
  if (error instanceof UsageError) return EXIT_USAGE;
  if (error instanceof DatabaseConfigError) return EXIT_CONFIG;
  if (
    error instanceof MigrationError &&
    /^(bootstrap_verifiers|bootstrap_replicas|bootstrap_environment|migration_release|grants_invalid)$/.test(
      error.code,
    )
  ) {
    return EXIT_CONFIG;
  }
  if (error instanceof TaskError && (error.code === "task_params" || error.code === "task_unknown"))
    return EXIT_CONFIG;
  return EXIT_FAILED;
}

export interface MigrateIo {
  stdout: (text: string) => void;
  clock: Clock;
}

async function bootstrapMode(
  env: Readonly<Record<string, string | undefined>>,
  base: BaseEnv,
  log: LineSink,
): Promise<void> {
  const target = parseSuperuserUrl(env.FIN_BOOTSTRAP_DATABASE_URL);
  const verifiers = parseRoleVerifiers(env.FIN_ROLE_VERIFIERS);
  const replicas = parseReplicas(env.FIN_DB_REPLICAS);
  const files = assets(base);
  const client = await connectClient({
    ...target,
    tls: tlsFor(base, target.host),
    applicationName: applicationName(base),
  });
  try {
    const result = await bootstrap(client, {
      verifiers,
      replicas,
      environment: base.FIN_ENVIRONMENT,
      files: files.bootstrap,
      fragments: files.fragments,
    });
    log.write({
      event: "migrate.done",
      level: "info",
      fields: {
        mode: "bootstrap",
        serverVersion: result.serverVersion,
        statStatementsPreloaded: result.statStatementsPreloaded,
        verifiersSet: result.verifiersSet,
      },
    });
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * What `--migrate` runs after the files and the grants, in the run's transaction as fin_owner: the
 * audit registry sync (spec 08 §3.2) and `email.enqueue()`'s per-role allowlist, generated from the
 * template catalogue's folders (spec 08 §4.4, [DA-14]). Both only add and update rows, so a release
 * never takes away a newer one's. Tests that need the schema `migrate` builds pass it as theirs.
 */
export function afterMigrations(release: string): (q: Queryable) => Promise<void> {
  return async (q) => {
    await syncEventTypes(q, release);
    await q.query(grantInsertSql());
  };
}

async function migrateMode(
  env: Readonly<Record<string, string | undefined>>,
  base: BaseEnv,
  log: LineSink,
  clock: Clock,
): Promise<void> {
  const target = parseSuperuserUrl(env.FIN_BOOTSTRAP_DATABASE_URL);
  const { migrations: files, fragments } = assets(base);
  const tls = tlsFor(base, target.host);
  const superuser = await connectClient({ ...target, tls, applicationName: applicationName(base) });
  try {
    const result = await withOwnerSession(
      superuser,
      {
        host: target.host,
        port: target.port,
        database: target.database,
        tls,
        applicationName: applicationName(base),
      },
      clock,
      (owner) =>
        runMigrations(owner, {
          files,
          release: base.FIN_RELEASE,
          fragments,
          after: afterMigrations(base.FIN_RELEASE),
        }),
    );
    log.write({
      event: "migrate.done",
      level: "info",
      fields: {
        mode: "migrate",
        applied: result.applied.length,
        newest: result.newest,
        unknown: result.unknown,
        grantStatements: result.grantStatements,
      },
    });
  } finally {
    await superuser.end().catch(() => {});
  }
}

const certEnv = z.object({
  FIN_DB_HOST: z.string().regex(/^[A-Za-z0-9.-]{1,253}$|^[0-9a-fA-F:]{2,39}$/),
  FIN_DB_PORT: z.string().regex(/^[1-9][0-9]{0,4}$/),
  FIN_DB_NAME: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
});

async function printCertMode(
  env: Readonly<Record<string, string | undefined>>,
  log: LineSink,
  io: MigrateIo,
): Promise<void> {
  const parsed = certEnv.safeParse(env);
  if (!parsed.success) {
    throw new DatabaseConfigError(
      String(parsed.error.issues[0]?.path[0] ?? "FIN_DB_*"),
      "is missing or malformed",
    );
  }
  const presented = await readPresentedCertificate({
    host: parsed.data.FIN_DB_HOST,
    port: Number(parsed.data.FIN_DB_PORT),
    database: parsed.data.FIN_DB_NAME,
  });
  presented.chain.forEach((pem, i) => {
    io.stdout(
      `# certificate ${i + 1} of ${presented.chain.length}, SHA-256 ${presented.fingerprints[i]}\n${pem}`,
    );
  });
  log.write({
    event: "migrate.done",
    level: "info",
    fields: {
      mode: "print-db-cert",
      certificates: presented.chain.length,
      fingerprints: presented.fingerprints,
    },
  });
}

async function taskMode(
  env: Readonly<Record<string, string | undefined>>,
  base: BaseEnv,
  task: string,
  log: LineSink,
  clock: Clock,
): Promise<void> {
  if (base.FIN_RUN_ID === undefined)
    throw new DatabaseConfigError("FIN_RUN_ID", "is required for a task");
  const runId = base.FIN_RUN_ID;
  const params = parseTaskParams(env.FIN_TASK_PARAMS);
  const target = parseSuperuserUrl(env.FIN_BOOTSTRAP_DATABASE_URL);
  const tls = tlsFor(base, target.host);
  const superuser = await connectClient({ ...target, tls, applicationName: applicationName(base) });
  try {
    await withOwnerSession(
      superuser,
      {
        host: target.host,
        port: target.port,
        database: target.database,
        tls,
        applicationName: applicationName(base),
      },
      clock,
      async (_owner, settings) => {
        const pool = createPool({ ...settings, max: 1 }, log);
        try {
          await runTask(createDatabase({ pool }), task, params, {
            runId,
            release: base.FIN_RELEASE,
            environment: base.FIN_ENVIRONMENT,
            unit: { clock, release: base.FIN_RELEASE, runId, log },
            log,
          });
        } finally {
          await pool.end();
        }
      },
    );
  } finally {
    await superuser.end().catch(() => {});
  }
}

/** Runs one mode and returns the process's exit code. */
export async function runMigrateCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: MigrateIo,
): Promise<number> {
  let mode: Mode;
  try {
    mode = parseArgs(argv);
  } catch (error) {
    io.stdout(`${(error as Error).message}\n`);
    return EXIT_USAGE;
  }
  let base: BaseEnv;
  try {
    base = readBase(env);
  } catch (error) {
    // No envelope yet: the configuration it would carry is what failed. The line names the variable.
    io.stdout(
      `${JSON.stringify({ dt: new Date(io.clock.now()).toISOString(), message: "migrate.failed", event: "migrate.failed", level: "error", service: "migrate", mode: mode.mode, code: "config", variable: error instanceof DatabaseConfigError ? error.variable : "unknown" })}\n`,
    );
    return EXIT_CONFIG;
  }
  const log = stdoutLines(
    {
      environment: base.FIN_ENVIRONMENT,
      release: base.FIN_RELEASE,
      replica: base.RAILWAY_REPLICA_ID ?? "migrate",
      ...(base.FIN_RUN_ID === undefined ? {} : { runId: base.FIN_RUN_ID }),
    },
    io.clock,
    io.stdout,
  );
  const name = mode.mode === "task" ? mode.task : mode.mode;
  log.write({
    event: "migrate.started",
    level: "info",
    fields: { mode: mode.mode, ...(mode.mode === "task" ? { task: name } : {}) },
  });
  try {
    if (mode.mode === "bootstrap") await bootstrapMode(env, base, log);
    else if (mode.mode === "migrate") await migrateMode(env, base, log, io.clock);
    else if (mode.mode === "print-db-cert") await printCertMode(env, log, io);
    else await taskMode(env, base, mode.task, log, io.clock);
    return EXIT_OK;
  } catch (error) {
    const fields: Record<string, string> = { mode: mode.mode, code: failureCode(error) };
    if (error instanceof DatabaseConfigError) fields.variable = error.variable;
    if (error instanceof MigrationError && error.file !== undefined) fields.file = error.file;
    if (mode.mode === "task") {
      log.write({
        event: "task.failed",
        level: "error",
        fields: { task: mode.task, code: failureCode(error) },
      });
    } else {
      log.write({ event: "migrate.failed", level: "error", fields });
    }
    return exitCodeFor(error);
  }
}
