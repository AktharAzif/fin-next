// runService: the main() every Fin HTTP service shares (ARCHITECTURE §3.5). It reads the
// environment once and validates it (exit 78 naming the variable), refuses seams in a release build,
// sets up telemetry, error reporting, the private-DNS cache and the crash handlers, builds the app,
// listens on [::]:PORT, writes `process.start`, samples `process.health` every minute and drains on
// SIGTERM within FIN_DRAIN_SECONDS.
import {
  type Clock,
  ConfigError,
  EXIT_CONFIG,
  rfc3339,
  safeError,
  scrubLine,
  systemClock,
} from "@fin/core";
import {
  type Env,
  loadProcessConfig,
  type ProcessConfig,
  SERVICE_NAMES,
  type ServiceName,
} from "./config/index.ts";
import { buildTarget, checkSeams, refuseForbidden } from "./config/seams.ts";
import { createPrivateResolver, type PrivateResolver } from "./dns/railway-lookup.ts";
import { type ProcessHealth, startProcessHealth } from "./health/process-health.ts";
import { Readiness } from "./health/readiness.ts";
import { type FetchHandler, type HttpServerHandle, startHttpServer } from "./http/serve.ts";
import type { ConnectorPeers } from "./ingress/peers.ts";
import { type StdoutWriter, writeStdout } from "./log/stdout.ts";
import { Reporter } from "./report.ts";
import { isErrorsDsn } from "./report-dsn.ts";
import { createShutdown, onCrash, onSignals, type Shutdown, type StopHook } from "./shutdown.ts";
import type { Fields } from "./telemetry/lines.ts";
import { betterStackTransport, type Transport } from "./telemetry/ship.ts";
import { installTelemetry, Telemetry } from "./telemetry/telemetry.ts";

export interface ServiceContext {
  env: Env;
  config: ProcessConfig;
  clock: Clock;
  telemetry: Telemetry;
  reporter: Reporter;
  resolver: PrivateResolver;
  readiness: Readiness;
  /** Registers work for shutdown, run in registration order after the server closes. */
  onStop(name: string, run: StopHook["run"]): void;
}

export interface BuiltService {
  fetch: FetchHandler;
  /** Started before the server listens; readiness waits for its first resolution. */
  peers?: ConnectorPeers;
  /** Fields `process.health` adds (the pool, dbOk, clockSkewMs) once they exist. */
  health?: () => Promise<Fields>;
}

export interface ServiceDefinition {
  /** The FIN_SERVICE values this entry may run as. */
  services: readonly ServiceName[];
  build(ctx: ServiceContext): BuiltService | Promise<BuiltService>;
}

export interface RunOptions {
  env?: Env;
  exit?: (code: number) => void;
  clock?: Clock;
  /** Install SIGTERM, SIGINT and crash handlers on the process (off in tests). */
  processHandlers?: boolean;
  host?: string;
  /** Overrides PORT (tests listen on 0). */
  port?: number;
  stdout?: StdoutWriter;
  transport?: Transport;
  fetch?: typeof fetch;
}

export interface RunningService {
  port: number;
  server: HttpServerHandle;
  telemetry: Telemetry;
  reporter: Reporter;
  readiness: Readiness;
  shutdown: Shutdown;
  health: ProcessHealth;
}

/**
 * Writes `config.invalid` (the variable and the problem, never the value) before telemetry exists.
 * `service` is written only when FIN_SERVICE is one of Fin's service names, so a value pasted into
 * the wrong variable is never echoed, FIN_SERVICE's own included.
 */
export function writeConfigInvalid(
  error: ConfigError,
  env: Env,
  stdout: StdoutWriter = writeStdout,
  clock: Clock = systemClock,
): void {
  const service = env.FIN_SERVICE;
  const known = (SERVICE_NAMES as readonly string[]).includes(service ?? "");
  stdout(
    JSON.stringify(
      scrubLine({
        dt: rfc3339(clock.now()),
        message: "config.invalid",
        event: "config.invalid",
        level: "error",
        ...(known ? { service } : {}),
        variable: error.variable,
        problem: error.problem,
      }),
    ),
  );
}

export async function runService(
  definition: ServiceDefinition,
  options: RunOptions = {},
): Promise<RunningService | undefined> {
  const env = options.env ?? process.env;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const clock = options.clock ?? systemClock;
  const stdout = options.stdout ?? writeStdout;

  let config: ProcessConfig;
  try {
    checkSeams(env);
    refuseForbidden(env);
    config = loadProcessConfig(env, isErrorsDsn, definition.services);
  } catch (error) {
    if (error instanceof ConfigError) {
      writeConfigInvalid(error, env, stdout, clock);
      exit(EXIT_CONFIG);
      return undefined;
    }
    throw error;
  }

  const transport =
    options.transport ??
    (config.telemetry !== undefined
      ? betterStackTransport({
          ...config.telemetry,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
      : undefined);
  const telemetry = new Telemetry({
    service: config.service,
    environment: config.environment,
    release: config.release,
    replica: config.replica,
    clock,
    stdout,
    ...(transport !== undefined ? { transport } : {}),
  });
  installTelemetry(telemetry);
  telemetry.start();
  const reporter = new Reporter({
    dsn: config.errorsDsn,
    release: config.release,
    environment: config.environment,
    service: config.service,
    telemetry,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  telemetry.onBackgroundFailure((error, name) => reporter.reportError(error, { job: name }));
  if (options.processHandlers !== false) onCrash({ telemetry, reporter, exit });

  const resolver = createPrivateResolver({
    clock,
    onFailure: (fields) => telemetry.log("dns.lookup_failed", fields, "warn"),
  });
  const readiness = new Readiness();
  const hooks: StopHook[] = [];
  const ctx: ServiceContext = {
    env,
    config,
    clock,
    telemetry,
    reporter,
    resolver,
    readiness,
    onStop: (name, run) => hooks.push({ name, run }),
  };

  // A start that fails is a line, flushed, then an exit: never a process left running with no
  // server (the crash handlers only log a rejection).
  const startFailed = async (error: unknown): Promise<undefined> => {
    const safe = safeError(error);
    telemetry.logUnit(
      "process.start_failed",
      { errorName: safe.errorName, errorCode: safe.errorCode },
      "error",
    );
    reporter.reportError(error, { job: "start" });
    await Promise.allSettled([telemetry.flush(2000), reporter.flush(2000)]);
    exit(1);
    return undefined;
  };

  let built: BuiltService;
  try {
    built = await definition.build(ctx);
  } catch (error) {
    if (error instanceof ConfigError) {
      telemetry.logUnit(
        "config.invalid",
        { variable: error.variable, problem: error.problem },
        "error",
      );
      await telemetry.flush(2000);
      exit(EXIT_CONFIG);
      return undefined;
    }
    return startFailed(error);
  }

  if (built.peers !== undefined) {
    const peers = built.peers;
    await peers.start();
    readiness.add("connector_peers", () => peers.ready);
    hooks.push({ name: "peers", run: () => peers.stop() });
  }

  let server: HttpServerHandle;
  try {
    server = await startHttpServer({
      fetch: built.fetch,
      port: options.port ?? config.port,
      ...(options.host !== undefined ? { host: options.host } : {}),
    });
  } catch (error) {
    built.peers?.stop();
    return startFailed(error);
  }
  const health = startProcessHealth({
    telemetry,
    httpConnections: () => server.connections(),
    ...(built.health !== undefined ? { extra: built.health } : {}),
  });
  hooks.unshift({ name: "health", run: () => health.stop() });
  hooks.push({ name: "telemetry", run: () => telemetry.stop() });

  const shutdown = createShutdown({
    drainSeconds: config.drainSeconds,
    telemetry,
    reporter,
    readiness,
    server,
    hooks,
    exit,
  });
  if (options.processHandlers !== false) onSignals(shutdown);

  telemetry.logUnit("process.start", {
    node: process.version,
    target: buildTarget(),
    port: server.port,
    drainSeconds: config.drainSeconds,
    shipping: telemetry.shipping,
    reporting: reporter.sending,
  });

  return { port: server.port, server, telemetry, reporter, readiness, shutdown, health };
}
