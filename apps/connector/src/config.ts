// The supervisor's settings (spec 01 §6.7, §7.3), read once in main(). The supervisor has no
// third-party dependency (ARCHITECTURE §5.4), so the checks are written out here rather than with
// Zod. A missing or malformed value is a ConfigError naming the variable, never its value: exit 78.
import { ConfigError } from "@fin/core";
import { TUNNEL_ROLES, type TunnelRole } from "./map.ts";
import type { AccessSettings } from "./render.ts";

export const CONNECTOR_SERVICES = [
  "cloudflared-public",
  "cloudflared-public-b",
  "cloudflared-admin",
  "cloudflared-admin-b",
  "cloudflared-db",
] as const;
export type ConnectorService = (typeof CONNECTOR_SERVICES)[number];

const ENVIRONMENTS = ["development", "ci", "staging", "production"] as const;
export type ConnectorEnvironment = (typeof ENVIRONMENTS)[number];

export interface ConnectorConfig {
  service: ConnectorService;
  environment: ConnectorEnvironment;
  release: string;
  drainSeconds: number;
  port: number;
  replica: string;
  telemetry: { host: string; token: string } | undefined;
  tunnel: TunnelRole;
  zone: string;
  hosts: Record<string, string>;
  access: AccessSettings | undefined;
  /** Passed to cloudflared in its environment only, never on its command line. */
  token: string;
  cloudflaredPath: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new ConfigError(name, "missing");
  return value;
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function check(name: string, value: string, ok: boolean): string {
  if (!ok) throw new ConfigError(name, "malformed");
  return value;
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) throw new ConfigError(name, "malformed");
  return value as T;
}

function integer(name: string, value: string, min: number, max: number): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new ConfigError(name, "malformed");
  }
  return n;
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// A tunnel token is base64 of a JSON object ({"a":..., "t":..., "s":...}).
const TUNNEL_TOKEN = /^eyJ[A-Za-z0-9+/_-]{40,2048}={0,2}$/;

export function loadConnectorConfig(env: Env): ConnectorConfig {
  const service = oneOf("FIN_SERVICE", read(env, "FIN_SERVICE"), CONNECTOR_SERVICES);
  const environment = oneOf("FIN_ENVIRONMENT", read(env, "FIN_ENVIRONMENT"), ENVIRONMENTS);
  const release = check(
    "FIN_RELEASE",
    read(env, "FIN_RELEASE"),
    /^[0-9a-f]{40}$/.test(env.FIN_RELEASE ?? ""),
  );
  const drainSeconds = integer("FIN_DRAIN_SECONDS", read(env, "FIN_DRAIN_SECONDS"), 5, 600);
  const port = integer("PORT", optional(env, "PORT") ?? "8080", 1, 65535);
  if (env.FIN_CONTAINER === "1" && environment === "development") {
    throw new ConfigError("FIN_ENVIRONMENT", "refused");
  }

  const telemetryHost = optional(env, "FIN_TELEMETRY_HOST");
  const telemetryToken = optional(env, "FIN_TELEMETRY_TOKEN");
  const deployed = environment === "staging" || environment === "production";
  if (deployed && telemetryHost === undefined)
    throw new ConfigError("FIN_TELEMETRY_HOST", "missing");
  if ((telemetryHost === undefined) !== (telemetryToken === undefined)) {
    throw new ConfigError(
      telemetryHost === undefined ? "FIN_TELEMETRY_HOST" : "FIN_TELEMETRY_TOKEN",
      "missing",
    );
  }
  if (telemetryHost !== undefined)
    check("FIN_TELEMETRY_HOST", telemetryHost, HOSTNAME.test(telemetryHost));
  if (telemetryToken !== undefined) {
    check("FIN_TELEMETRY_TOKEN", telemetryToken, /^[A-Za-z0-9_-]{16,128}$/.test(telemetryToken));
  }

  const tunnel = oneOf("FIN_TUNNEL_ROLE", read(env, "FIN_TUNNEL_ROLE"), TUNNEL_ROLES);
  if (!service.startsWith(`cloudflared-${tunnel}`))
    throw new ConfigError("FIN_TUNNEL_ROLE", "refused");
  const zone = read(env, "FIN_ZONE");
  check("FIN_ZONE", zone, HOSTNAME.test(zone));

  let hosts: Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(read(env, "FIN_TUNNEL_HOSTS"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("shape");
    // No prototype: a role spelled `__proto__` is kept as a key, so the renderer refuses it as an
    // unknown role instead of losing it to the prototype setter.
    hosts = Object.create(null) as Record<string, string>;
    for (const [role, host] of Object.entries(parsed)) {
      if (typeof host !== "string" || !HOSTNAME.test(host)) throw new Error("shape");
      hosts[role] = host;
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("FIN_TUNNEL_HOSTS", "malformed");
  }

  let access: AccessSettings | undefined;
  if (tunnel === "admin") {
    const team = read(env, "FIN_ACCESS_TEAM");
    check("FIN_ACCESS_TEAM", team, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(team));
    const aud = read(env, "FIN_ACCESS_AUD");
    check("FIN_ACCESS_AUD", aud, /^[A-Za-z0-9]{16,128}$/.test(aud));
    access = { team, aud };
  }

  const token = read(env, "TUNNEL_TOKEN");
  check("TUNNEL_TOKEN", "", TUNNEL_TOKEN.test(token));
  const cloudflaredPath = optional(env, "FIN_CLOUDFLARED_PATH") ?? "/usr/local/bin/cloudflared";
  check("FIN_CLOUDFLARED_PATH", cloudflaredPath, /^\/[A-Za-z0-9._/-]+$/.test(cloudflaredPath));
  const replica = optional(env, "RAILWAY_REPLICA_ID") ?? "local";

  return {
    service,
    environment,
    release,
    drainSeconds,
    port,
    replica: /^[A-Za-z0-9_-]{1,64}$/.test(replica) ? replica : "local",
    telemetry:
      telemetryHost !== undefined && telemetryToken !== undefined
        ? { host: telemetryHost, token: telemetryToken }
        : undefined,
    tunnel,
    zone,
    hosts,
    access,
    token,
    cloudflaredPath,
  };
}
