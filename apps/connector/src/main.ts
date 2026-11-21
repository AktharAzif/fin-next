// The connector supervisor's entry (spec 01 §7.3, §4.9; ARCHITECTURE §5.4). Node, no third-party
// dependency. It reads its settings once (exit 78 naming a bad variable), renders cloudflared's
// configuration from the map, starts cloudflared with TUNNEL_TOKEN in the child's environment only
// (never on its command line, never in this process's environment afterwards), and supervises it.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { ConfigError, EXIT_CONFIG, rfc3339, scrubLine, scrubText, systemClock } from "@fin/core";
import { startProcessHealth } from "@fin/server/process-health";
import { betterStackTransport, installTelemetry, Telemetry } from "@fin/server/telemetry";
import { type ConnectorConfig, loadConnectorConfig } from "./config.ts";
import { startHealthServer } from "./health-server.ts";
import { renderConfig } from "./render.ts";
import { type ChildHandle, type ProbeResult, Supervisor } from "./supervisor.ts";

export const CONFIG_PATH = "/tmp/cloudflared/config.yml";
export const METRICS_ADDRESS = "127.0.0.1:20241";

/** cloudflared's arguments (spec 01 §7.3): the token is never among them. */
export function cloudflaredArgs(configPath: string, metrics: string = METRICS_ADDRESS): string[] {
  return [
    "tunnel",
    "--no-autoupdate",
    "--loglevel",
    "info",
    "--transport-loglevel",
    "warn",
    "--protocol",
    "http2",
    "--metrics",
    metrics,
    "--config",
    configPath,
    "run",
  ];
}

/** The child's whole environment: the token and a home, nothing of this process's own. */
export function childEnvironment(token: string): Record<string, string> {
  return { TUNNEL_TOKEN: token, HOME: "/tmp" };
}

/** Reads cloudflared's `/ready` on loopback: 200 with its count of ready connections. */
export async function probeReady(metrics: string, timeoutMs = 2000): Promise<ProbeResult> {
  const response = await fetch(`http://${metrics}/ready`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  let connections = 0;
  try {
    const body = (await response.json()) as { readyConnections?: unknown };
    if (typeof body.readyConnections === "number") connections = body.readyConnections;
  } catch {
    connections = 0;
  }
  return { ok: response.status === 200, connections };
}

export function cloudflaredVersion(path: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { timeout: 5000, env: { HOME: "/tmp" } }, (error, stdout) => {
      const match = /(\d{4}\.\d{1,2}\.\d{1,3})/.exec(String(stdout));
      resolve(error === null && match?.[1] !== undefined ? match[1] : "unknown");
    });
  });
}

export interface MainOptions {
  env?: Readonly<Record<string, string | undefined>>;
  exit?: (code: number) => void;
  configPath?: string;
  metrics?: string;
  host?: string;
  signals?: boolean;
  stdout?: (line: string) => void;
}

function configInvalid(error: ConfigError, write: (line: string) => void): void {
  write(
    JSON.stringify(
      scrubLine({
        dt: rfc3339(systemClock.now()),
        message: "config.invalid",
        event: "config.invalid",
        level: "error",
        variable: error.variable,
        problem: error.problem,
      }),
    ),
  );
}

export async function main(options: MainOptions = {}): Promise<Supervisor | undefined> {
  const env = options.env ?? process.env;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const write = options.stdout ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const configPath = options.configPath ?? CONFIG_PATH;
  const metrics = options.metrics ?? METRICS_ADDRESS;

  let config: ConnectorConfig;
  let yaml: string;
  try {
    config = loadConnectorConfig(env);
    yaml = renderConfig({
      tunnel: config.tunnel,
      zone: config.zone,
      hosts: config.hosts,
      ...(config.access !== undefined ? { access: config.access } : {}),
    }).yaml;
  } catch (error) {
    if (error instanceof ConfigError) {
      configInvalid(error, write);
      exit(EXIT_CONFIG);
      return undefined;
    }
    throw error;
  }
  // From here on only the child holds the token.
  if (env === process.env) delete process.env.TUNNEL_TOKEN;

  const telemetry = new Telemetry({
    service: config.service,
    environment: config.environment,
    release: config.release,
    replica: config.replica,
    clock: systemClock,
    stdout: write,
    ...(config.telemetry !== undefined
      ? { transport: betterStackTransport(config.telemetry) }
      : {}),
  });
  installTelemetry(telemetry);
  telemetry.start();

  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, yaml, { mode: 0o600 });
  const version = await cloudflaredVersion(config.cloudflaredPath);
  telemetry.logUnit("process.start", {
    node: process.version,
    tunnel: config.tunnel,
    version,
    state: "starting",
  });

  const token = config.token;
  const supervisor = new Supervisor({
    telemetry,
    version,
    drainMs: config.drainSeconds * 1000,
    exit,
    probe: () => probeReady(metrics),
    spawnChild: (): ChildHandle => {
      const child = spawn(config.cloudflaredPath, cloudflaredArgs(configPath, metrics), {
        env: childEnvironment(token),
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [child.stdout, child.stderr]) {
        createInterface({ input: stream }).on("line", (line) => {
          telemetry.logLocal("connector.cloudflared_log", { text: scrubText(line).slice(0, 500) });
        });
      }
      return {
        kill: (signal) => void child.kill(signal),
        onExit: (listener) => void child.once("exit", listener),
      };
    },
  });

  const health = await startHealthServer({
    port: config.port,
    ...(options.host !== undefined ? { host: options.host } : {}),
    ready: () => supervisor.ready,
    alive: () => supervisor.state !== "exiting",
  });
  supervisor.start();
  // process.health every minute, as every Fin process writes it (spec 01 §8.9).
  const processHealth = startProcessHealth({ telemetry });
  if (options.signals !== false) {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        processHealth.stop();
        void supervisor.stop().finally(() => void health.close());
      });
    }
  }
  return supervisor;
}
