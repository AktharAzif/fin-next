// One minute of watching: run every Phase 0 check, write one watcher.run line and one
// watcher.check_failed line per failure, ship them, then ping the heartbeat. A check that cannot
// read its API fails (fail closed); a run whose lines did not ship, or whose settings are broken,
// pings the heartbeat's failure URL so `watcher-down` fires.
import { access } from "./checks/access.ts";
import { type Check, type Failure, makeContext } from "./checks/common.ts";
import { email } from "./checks/email.ts";
import { routes, staticDeployments } from "./checks/front.ts";
import { connectors, dns, tunnelConfig } from "./checks/tunnels.ts";
import { rules, zone } from "./checks/zone.ts";
import { CloudflareError, CloudflareReader, type Fetch } from "./cloudflare.ts";
import { parseSettings, type WatcherSettings } from "./settings.ts";
import { type Line, log, ping, ship } from "./ship.ts";

/** The Phase 0 checks, in the order their lines are written. */
export const CHECKS: readonly Check[] = [
  connectors,
  tunnelConfig,
  dns,
  routes,
  staticDeployments,
  rules,
  zone,
  access,
  email,
];

/** The Worker's environment: one plain setting and four secrets, nothing else. */
export interface WatcherEnv {
  readonly FIN_WATCHER_SETTINGS?: string;
  readonly FIN_CF_TOKEN?: string;
  readonly FIN_TELEMETRY_HOST?: string;
  readonly FIN_TELEMETRY_TOKEN?: string;
  readonly FIN_HEARTBEAT_WATCHER_URL?: string;
}

export interface RunDeps {
  readonly fetch: Fetch;
  readonly now: () => number;
  readonly randomId: () => string;
}

export interface RunResult {
  readonly lines: readonly Line[];
  readonly failures: readonly Failure[];
  readonly shipped: boolean;
  readonly pinged: boolean;
  readonly healthy: boolean;
}

function failureDetail(error: unknown): string {
  if (error instanceof CloudflareError && (error.status === 401 || error.status === 403)) {
    return "api_forbidden";
  }
  return "api_error";
}

export async function runWatcher(env: WatcherEnv, deps: RunDeps): Promise<RunResult> {
  const started = deps.now();
  const failures: Failure[] = [];
  let settings: WatcherSettings | undefined;
  let broken = false;
  try {
    settings = parseSettings(env.FIN_WATCHER_SETTINGS ?? "");
  } catch {
    broken = true;
  }
  let checks = 0;
  if (settings !== undefined) {
    const token = env.FIN_CF_TOKEN ?? "";
    if (token === "" || /\s/.test(token)) {
      broken = true;
    } else {
      const ctx = makeContext(settings, new CloudflareReader(token, deps.fetch));
      const results = await Promise.allSettled(CHECKS.map((check) => check.run(ctx)));
      checks = CHECKS.length;
      for (const [index, result] of results.entries()) {
        const name = CHECKS[index]?.name ?? "connectors";
        if (result.status === "fulfilled") failures.push(...result.value);
        else failures.push({ check: name, target: name, detail: failureDetail(result.reason) });
      }
    }
  }
  const lineCtx = {
    environment: settings?.environment ?? "unknown",
    release: settings?.release ?? "unknown",
    runId: `watch_${deps.randomId()}`,
    now: deps.now,
  };
  const lines: Line[] = [
    log(
      "watcher.run",
      { checks, failed: failures.length, durationMs: deps.now() - started },
      lineCtx,
      broken || failures.length > 0 ? "warn" : "info",
    ),
    ...failures.map((f) =>
      log(
        "watcher.check_failed",
        { check: f.check, target: f.target, detail: f.detail },
        lineCtx,
        "error",
      ),
    ),
  ];
  const shipped = await ship(lines, env.FIN_TELEMETRY_HOST, env.FIN_TELEMETRY_TOKEN, deps.fetch);
  const pinged = await ping(env.FIN_HEARTBEAT_WATCHER_URL, broken || !shipped, deps.fetch);
  return { lines, failures, shipped, pinged, healthy: !broken && shipped };
}
