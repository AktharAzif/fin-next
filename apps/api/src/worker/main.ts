// The `worker` service (spec 01 §4.5, §6.2; ARCHITECTURE §4.2, §4.6, §9.4): the api image started with
// `--worker`, which apps/api/src/main.ts dispatches here. Nothing reaches it but its private health;
// every other request is an outside request, as on `api` (spec 01 §6.4). It is the one process that
// holds the email token and sends ([EM-04]):
//   - the email loop (worker/email/): `NOTIFY email_outbox` on its own LISTEN connection wakes it, a
//     5-second poll is the backstop, and each tick writes its `job.run` line (`job: "email-send"`);
//   - the delivery check (`email-delivery-check`, spec 01 §8.5), at start and then on the loop's timer;
//   - the database probe (`db-probe`, ARCHITECTURE §4.5), at start and every minute, as fin_probe on its
//     own one-connection pool. FIN_DB_PROBE_PASSWORD is not in spec 01 §6.7's table yet (an open item),
//     so without it each minute's run is a `job.run` skipped with `not_configured`, and the duty's
//     success alert still sees no `result=ok`.
// runService reads the process variables; build() reads the worker's own once and refuses a missing or
// malformed one with exit 78 naming it, never its value, before any connection opens. Nothing runs at
// import. On shutdown, after the server closes: the loop stops (its tick and check finish), the probe
// stops, then the pools end. The scheduler lease and its `scheduler-worker` heartbeat are not here yet.
import { type Clock, ConfigError } from "@fin/core";
import {
  clientConfig,
  createPool,
  DatabaseConfigError,
  type FinDatabase,
  type LineSink,
  type PgPool,
  type PoolSettings,
  poolSettingsFromEnv,
  ScramOnlyClient,
} from "@fin/db";
import type { ClientLike, EmailPort, PoolLike } from "@fin/email";
import type { BuiltService, Env, ServiceContext, ServiceDefinition, Telemetry } from "@fin/server";
import { loadDocsOrigin } from "@fin/server/config";
import { privateHealth } from "@fin/server/health";
import {
  apiHeaders,
  errorHandler,
  type FinEnv,
  notFoundHandler,
  type RequestOptions,
  requestUnit,
} from "@fin/server/http";
import { Hono } from "hono";
import { dropEdgeHeaders, outsideRequest } from "../doors/outside.ts";
import {
  EmailConfigError,
  type EmailWorker,
  type EmailWorkerConfig,
  readEmailConfig,
  startEmailWorker,
} from "./email/index.ts";
import { intervalScheduler, type Scheduler } from "./email/loop.ts";
import { probeDatabaseFromEnv, runDatabaseProbe } from "./probe/probe.ts";

export const PROBE_JOB = "db-probe";
/** The probe's cadence (ARCHITECTURE §4.6: the database probe, every minute). */
export const PROBE_EVERY_MS = 60_000;
/** How long `/readyz` and `process.health` reuse one `SELECT 1` (ARCHITECTURE §4.3). */
export const DB_CHECK_CACHE_MS = 1_000;

/** The worker's injection points, beside runService's (its env, clock and fetch). */
export interface WorkerDeps {
  /** The email transport; the release image always uses Cloudflare's, through ctx.fetch. */
  readonly emailPort?: EmailPort;
  /** The timers of the email loop and the probe; tests run them by hand. */
  readonly schedule?: Scheduler;
}

const VARIABLE = /^[A-Z][A-Z0-9_]*$/;

function problemOf(env: Env, variable: string): "missing" | "malformed" {
  const value = env[variable];
  return value === undefined || value === "" ? "missing" : "malformed";
}

/** Runs one of the worker's settings readers, turning its error into a ConfigError naming the variable. */
function setting<T>(ctx: ServiceContext, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof DatabaseConfigError) {
      const variable = VARIABLE.test(error.variable) ? error.variable : "FIN_DB_HOST";
      throw new ConfigError(variable, problemOf(ctx.env, variable));
    }
    if (error instanceof EmailConfigError) {
      // Every bad email variable gets its line; runService writes the first with the exit.
      const named = error.variables.filter((v) => VARIABLE.test(v));
      const [first = "FIN_EMAIL_TOKEN", ...rest] = named;
      for (const variable of rest) {
        ctx.telemetry.logUnit(
          "config.invalid",
          { variable, problem: problemOf(ctx.env, variable) },
          "error",
        );
      }
      throw new ConfigError(first, problemOf(ctx.env, first));
    }
    throw error;
  }
}

/** @fin/db's lines (the pool's errors, the probe's runs) into the process's telemetry. */
export function telemetrySink(telemetry: Pick<Telemetry, "log">): LineSink {
  return { write: (line) => telemetry.log(line.event, line.fields, line.level) };
}

type Pooled = Awaited<ReturnType<PgPool["connect"]>>;

/** Returns a client to the pool, destroying it when asked or when it was left in a transaction. */
function giveBack(client: Pooled, error?: Error | boolean): void {
  if (error instanceof Error) client.release(error);
  else client.release(error === true || client.getTransactionStatus() !== "I" ? true : undefined);
}

/**
 * The worker's pool as the email code's seam: a lone statement on a client of its own, returned at
 * once, or a client for `inTransaction`, which releases it on every path.
 */
export function emailPool(pool: PgPool): PoolLike {
  const client = (pooled: Pooled): ClientLike => ({
    query: <R>(text: string, values?: unknown[]) => pooled.query<R & object>(text, values),
    release: (error?: Error | boolean) => giveBack(pooled, error),
  });
  return {
    async query<R>(text: string, values?: unknown[]) {
      const pooled = await pool.connect();
      try {
        return await pooled.query<R & object>(text, values);
      } finally {
        giveBack(pooled);
      }
    },
    connect: async () => client(await pool.connect()),
  };
}

/**
 * The readiness and `dbOk` check (ARCHITECTURE §4.3): `SELECT 1` through the pool, one at a time,
 * its answer reused for DB_CHECK_CACHE_MS. Never throws: a failure is false.
 */
export function databaseCheck(pool: PgPool, clock: Clock): () => Promise<boolean> {
  let last: { at: number; ok: boolean } | undefined;
  let running: Promise<boolean> | undefined;
  const select = async (): Promise<boolean> => {
    try {
      const pooled = await pool.connect();
      try {
        await pooled.query("SELECT 1");
        return true;
      } finally {
        giveBack(pooled);
      }
    } catch {
      return false;
    }
  };
  return () => {
    if (last !== undefined && clock.now() - last.at < DB_CHECK_CACHE_MS) {
      return Promise.resolve(last.ok);
    }
    running ??= select().then((ok) => {
      last = { at: clock.now(), ok };
      running = undefined;
      return ok;
    });
    return running;
  };
}

export interface ProbeDuty {
  /** Waits for the run in flight, if any (tests). */
  idle(): Promise<void>;
  stop(): Promise<void>;
}

export interface ProbeDutyOptions {
  /** fin_probe's pool; absent when FIN_DB_PROBE_PASSWORD is not set. */
  readonly probe: FinDatabase | undefined;
  readonly clock: Clock;
  readonly release: string;
  readonly log: LineSink;
  readonly schedule: Scheduler;
}

/**
 * The database probe at start and every PROBE_EVERY_MS, one run at a time: a timer that fires while
 * a run is still going starts none. Each run writes one `job.run` line and never throws.
 */
export function startProbeDuty(o: ProbeDutyOptions): ProbeDuty {
  let running: Promise<void> | undefined;
  let stopped = false;
  const once = async (): Promise<void> => {
    if (o.probe === undefined) {
      o.log.write({
        event: "job.run",
        level: "warn",
        fields: {
          job: PROBE_JOB,
          trigger: "schedule",
          result: "skipped",
          skipReason: "not_configured",
        },
      });
      return;
    }
    await runDatabaseProbe(
      o.probe,
      { clock: o.clock, release: o.release, log: o.log },
      o.clock,
      o.log,
    );
  };
  const run = (): void => {
    if (stopped || running !== undefined) return;
    running = once().finally(() => {
      running = undefined;
    });
  };
  run();
  const cancel = o.schedule(run, PROBE_EVERY_MS);
  return {
    idle: async () => {
      await running;
    },
    stop: async () => {
      stopped = true;
      cancel();
      await running;
      await o.probe?.end();
    },
  };
}

/** The worker's HTTP side: its private health, and every other request an outside request. */
function workerFetch(ctx: ServiceContext, docsOrigin: string): BuiltService["fetch"] {
  const options: RequestOptions = {
    telemetry: ctx.telemetry,
    reporter: ctx.reporter,
    clock: ctx.clock,
    docsOrigin,
  };
  const app = new Hono<FinEnv>();
  app.onError(errorHandler(options));
  app.notFound(notFoundHandler(options));
  app.use(requestUnit(options));
  app.use(
    apiHeaders({
      release: ctx.config.release,
      environment: ctx.config.environment,
      defaultRole: "private",
    }),
  );
  app.use(dropEdgeHeaders());
  app.use(privateHealth({ readiness: ctx.readiness, notFound: notFoundHandler(options) }));
  app.all("*", outsideRequest(options));
  return app.fetch;
}

export async function buildWorker(
  ctx: ServiceContext,
  deps: WorkerDeps = {},
): Promise<BuiltService> {
  // Every setting first, so a bad one never leaves a connection open behind the exit (the pools
  // below connect only when first used).
  const docsOrigin = loadDocsOrigin(ctx.env, ctx.config.environment);
  const emailConfig: EmailWorkerConfig = setting(ctx, () => readEmailConfig(ctx.env));
  const poolSettings: PoolSettings = setting(ctx, () => poolSettingsFromEnv(ctx.env, "worker"));
  const sink = telemetrySink(ctx.telemetry);
  const probePassword = ctx.env.FIN_DB_PROBE_PASSWORD;
  const probe =
    probePassword === undefined || probePassword === ""
      ? undefined
      : setting(ctx, () => probeDatabaseFromEnv(ctx.env, sink));
  const schedule = deps.schedule ?? intervalScheduler;

  const pool = createPool(poolSettings, sink);
  const dbOk = databaseCheck(pool, ctx.clock);
  ctx.readiness.add("database", dbOk);

  let email: EmailWorker;
  try {
    email = await startEmailWorker(emailConfig, {
      pool: emailPool(pool),
      log: ctx.telemetry,
      clock: ctx.clock,
      replica: ctx.config.replica,
      // The LISTEN connection, outside the pool (ARCHITECTURE §4.5), with the pool's TLS and SCRAM.
      listenClient: () =>
        new ScramOnlyClient({
          ...clientConfig({ ...poolSettings, applicationName: "fin-worker-listen" }),
          connectionTimeoutMillis: 5_000,
        }),
      fetch: ctx.fetch,
      schedule,
      ...(deps.emailPort === undefined ? {} : { port: deps.emailPort }),
    });
  } catch (error) {
    await probe?.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
  const probeDuty = startProbeDuty({
    probe,
    clock: ctx.clock,
    release: ctx.config.release,
    log: sink,
    schedule,
  });

  ctx.onStop("email", () => email.stop());
  ctx.onStop("probe", () => probeDuty.stop());
  ctx.onStop("pool", () => pool.end());

  return {
    fetch: workerFetch(ctx, docsOrigin),
    health: async () => ({
      dbOk: await dbOk(),
      poolTotal: pool.totalCount,
      poolIdle: pool.idleCount,
      poolWaiting: pool.waitingCount,
    }),
  };
}

export const workerService: ServiceDefinition = {
  services: ["worker"],
  build: (ctx) => buildWorker(ctx),
};
