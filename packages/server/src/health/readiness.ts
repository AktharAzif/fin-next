// Health and readiness (spec 01 §4.4, §6.4; ARCHITECTURE §3.5). `/healthz` says the process is up;
// `/readyz` says it should take traffic: every registered check passes and it is not shutting
// down. Both answer only private callers that are not connectors: through any public host, with a
// proof, or from a connector peer they are 404, so they are never reachable from outside.
import type { MiddlewareHandler } from "hono";
import type { FinEnv } from "../http/context.ts";
import { peerAddress } from "../http/facts.ts";
import type { ConnectorPeers } from "../ingress/peers.ts";
import { PROOF_HEADER } from "../ingress/proofs.ts";

export type ReadinessCheck = () => boolean | Promise<boolean>;

export class Readiness {
  private readonly checks = new Map<string, ReadinessCheck>();
  private stopping = false;

  /** Registers a named check; names are bounded codes, shown in a 503's `failing` list. */
  add(name: string, check: ReadinessCheck): void {
    if (this.checks.has(name)) throw new Error(`readiness check ${name} is registered twice`);
    this.checks.set(name, check);
  }

  markStopping(): void {
    this.stopping = true;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  async evaluate(): Promise<{ ready: boolean; failing: string[] }> {
    const failing: string[] = [];
    if (this.stopping) failing.push("shutting_down");
    for (const [name, check] of this.checks) {
      try {
        if (!(await check())) failing.push(name);
      } catch {
        failing.push(name);
      }
    }
    return { ready: failing.length === 0, failing };
  }
}

export interface PrivateHealthOptions {
  readiness: Readiness;
  /** Absent on a service no tunnel reaches (api, payments). */
  peers?: ConnectorPeers;
  /** The public hosts this service answers for; a health path through one of them is 404. */
  publicHosts?: readonly string[];
  notFound: (c: Parameters<MiddlewareHandler<FinEnv>>[0]) => Response | Promise<Response>;
}

const HEALTH_PATHS = new Set(["/healthz", "/readyz"]);

/** A Host compared with the public hosts: any case, any port, a trailing dot, all the same host. */
function hostName(value: string): string {
  const lower = value.trim().toLowerCase();
  const name = lower.startsWith("[") ? lower.slice(0, lower.indexOf("]") + 1) : lower.split(":")[0];
  return (name ?? "").replace(/\.$/, "");
}

/** Step 1 of the front door: private health for private callers only. */
export function privateHealth(options: PrivateHealthOptions): MiddlewareHandler<FinEnv> {
  const publicHosts = new Set((options.publicHosts ?? []).map(hostName));
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (!HEALTH_PATHS.has(path)) return next();
    c.set("route", path);
    const host = hostName(c.req.header("host") ?? "");
    const viaTunnel =
      c.req.header(PROOF_HEADER) !== undefined ||
      publicHosts.has(host) ||
      (options.peers?.has(peerAddress(c)) ?? false);
    if (viaTunnel || (c.req.method !== "GET" && c.req.method !== "HEAD")) {
      const answer = await options.notFound(c);
      // Set after the not-found answer, which marks its own reason: the line says why.
      c.set("outcome", "refused");
      c.set("reason", "health.public");
      return answer;
    }
    if (path === "/healthz") return c.json({ status: "ok" }, 200);
    const result = await options.readiness.evaluate();
    return result.ready
      ? c.json({ status: "ready" }, 200)
      : c.json({ status: "not_ready", failing: result.failing }, 503);
  };
}
