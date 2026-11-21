// The watcher's settings: the committed public part (ops/watcher/settings/<env>.json) joined at
// deploy time with the private part (account, zone, hostnames, egress addresses, registered
// hashes), and uploaded as the Worker's FIN_WATCHER_SETTINGS. Parsed strictly at every run: a
// malformed value is itself a failure, never a silent pass.

export const HOST_ROLES = ["console", "admin", "verify", "selfie", "docs", "api"] as const;
export type HostRole = (typeof HOST_ROLES)[number];
export const TUNNEL_ROLES = ["public", "admin"] as const;
export type TunnelRole = (typeof TUNNEL_ROLES)[number];

export interface TunnelSettings {
  readonly name: string;
  readonly replicas: number;
  readonly egressServices: readonly string[];
  readonly hosts: readonly HostRole[];
}

export interface RouteSettings {
  readonly host: HostRole;
  readonly path: "/*" | "/api/*";
  readonly script: string | null;
}

export interface AccessSettings {
  readonly appName: string;
  readonly host: HostRole;
  readonly sessionDuration: string;
  readonly sameSite: string;
  readonly bindingCookie: boolean;
  readonly httpOnly: boolean;
  readonly appLauncherVisible: boolean;
  readonly mfaRequired: boolean;
}

/** The committed, public part. */
export interface PublicSettings {
  readonly environment: string;
  readonly scriptName: string;
  readonly cron: string;
  readonly compatibilityDate: string;
  readonly telemetrySource: string;
  readonly heartbeat: string;
  readonly connectorVersion: string;
  readonly tunnels: Readonly<Record<TunnelRole, TunnelSettings>>;
  readonly static: readonly { readonly name: string; readonly host: HostRole }[];
  readonly staticCompatibilityDate: string;
  readonly routes: readonly RouteSettings[];
  readonly zoneSettings: Readonly<Record<string, unknown>>;
  readonly universalSsl: boolean;
  readonly botFightMode: boolean;
  readonly rulesetPhases: readonly string[];
  readonly access: AccessSettings;
  readonly email: { readonly subdomains: readonly string[] };
}

/** The private part, added at deploy time and never committed. */
export interface PrivateSettings {
  readonly accountId: string;
  readonly zone: string;
  readonly hosts: Readonly<Record<HostRole, string>>;
  /** Static egress addresses by Railway service (the overlay's staticEgress). */
  readonly egress: Readonly<Record<string, readonly string[]>>;
  /** Each rule set phase's hash from the last registered `pnpm fin rules apply`. */
  readonly rulesetHashes: Readonly<Record<string, string>>;
  /** The Access policy hash from the last registered `pnpm fin access apply`. */
  readonly accessPolicyHash: string | null;
  readonly release: string;
}

export type WatcherSettings = PublicSettings & PrivateSettings;

export class SettingsError extends Error {
  override readonly name = "SettingsError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function need(condition: boolean, what: string): asserts condition {
  if (!condition) throw new SettingsError(`settings: ${what}`);
}

const isString = (v: unknown): v is string => typeof v === "string" && v !== "";
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,39})$/i;
const HASH = /^[0-9a-f]{64}$/;

/** Validates a whole settings object (the Worker runs this every minute). */
export function parseSettings(raw: unknown): WatcherSettings {
  const value = typeof raw === "string" ? safeJson(raw) : raw;
  need(isRecord(value), "not an object");
  const s = value as Record<string, unknown>;
  for (const key of [
    "environment",
    "scriptName",
    "cron",
    "compatibilityDate",
    "telemetrySource",
    "heartbeat",
    "connectorVersion",
    "staticCompatibilityDate",
    "accountId",
    "zone",
    "release",
  ]) {
    need(isString(s[key]), `${key} must be a non-empty string`);
  }
  need(/^[0-9a-f]{32}$/.test(String(s.accountId)), "accountId is not an account ID");
  need(HOSTNAME.test(String(s.zone)), "zone is not a hostname");
  need(isRecord(s.hosts), "hosts must be an object");
  const hosts = s.hosts as Record<string, unknown>;
  for (const role of HOST_ROLES) {
    const host = hosts[role];
    need(isString(host) && HOSTNAME.test(host), `hosts.${role} is not a hostname`);
    need(
      host === String(s.zone) || host.endsWith(`.${String(s.zone)}`),
      `hosts.${role} is outside the zone`,
    );
  }
  need(isRecord(s.tunnels), "tunnels must be an object");
  const tunnels = s.tunnels as Record<string, unknown>;
  for (const role of TUNNEL_ROLES) {
    const t = tunnels[role];
    need(isRecord(t), `tunnels.${role} is missing`);
    need(isString(t.name), `tunnels.${role}.name`);
    need(Number.isInteger(t.replicas) && Number(t.replicas) >= 1, `tunnels.${role}.replicas`);
    need(isStringArray(t.egressServices), `tunnels.${role}.egressServices`);
    need(
      isStringArray(t.hosts) && t.hosts.every((h) => (HOST_ROLES as readonly string[]).includes(h)),
      `tunnels.${role}.hosts`,
    );
  }
  need(isRecord(s.egress), "egress must be an object");
  const egress = s.egress as Record<string, unknown>;
  for (const role of TUNNEL_ROLES) {
    const services = (tunnels[role] as Record<string, unknown>).egressServices as string[];
    const addresses = services.flatMap((svc) => (Array.isArray(egress[svc]) ? egress[svc] : []));
    need(addresses.length > 0, `no static egress address for the ${role} tunnel's services`);
    need(
      addresses.every((a) => typeof a === "string" && ADDRESS.test(a)),
      `egress for the ${role} tunnel holds a value that is not an address`,
    );
  }
  need(
    Array.isArray(s.static) &&
      s.static.every(
        (d) =>
          isRecord(d) &&
          isString(d.name) &&
          (HOST_ROLES as readonly string[]).includes(String(d.host)),
      ),
    "static must list { name, host }",
  );
  need(
    Array.isArray(s.routes) &&
      s.routes.every(
        (r) =>
          isRecord(r) &&
          (HOST_ROLES as readonly string[]).includes(String(r.host)) &&
          (r.path === "/*" || r.path === "/api/*") &&
          (r.script === null || isString(r.script)),
      ),
    "routes must list { host, path, script }",
  );
  need(isRecord(s.zoneSettings), "zoneSettings must be an object");
  need(typeof s.universalSsl === "boolean", "universalSsl must be a boolean");
  need(typeof s.botFightMode === "boolean", "botFightMode must be a boolean");
  need(isStringArray(s.rulesetPhases), "rulesetPhases must list phases");
  need(isRecord(s.rulesetHashes), "rulesetHashes must be an object");
  for (const hash of Object.values(s.rulesetHashes as Record<string, unknown>)) {
    need(
      typeof hash === "string" && HASH.test(hash),
      "rulesetHashes holds a value that is not a hash",
    );
  }
  need(
    s.accessPolicyHash === null ||
      (typeof s.accessPolicyHash === "string" && HASH.test(s.accessPolicyHash)),
    "accessPolicyHash must be a hash or null",
  );
  need(isRecord(s.access), "access must be an object");
  const a = s.access as Record<string, unknown>;
  need(isString(a.appName) && isString(a.sessionDuration) && isString(a.sameSite), "access names");
  need((HOST_ROLES as readonly string[]).includes(String(a.host)), "access.host");
  for (const key of ["bindingCookie", "httpOnly", "appLauncherVisible", "mfaRequired"]) {
    need(typeof a[key] === "boolean", `access.${key} must be a boolean`);
  }
  need(
    isRecord(s.email) && isStringArray((s.email as Record<string, unknown>).subdomains),
    "email",
  );
  return value as unknown as WatcherSettings;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SettingsError("settings: not valid JSON");
  }
}

/** The fully qualified email sending domains and the DMARC record name. */
export function emailNames(settings: WatcherSettings): { domains: string[]; dmarc: string } {
  return {
    domains: settings.email.subdomains.map((label) => `${label}.${settings.zone}`),
    dmarc: `_dmarc.${settings.zone}`,
  };
}

/** The addresses a tunnel's connectors may come from. */
export function allowedOrigins(settings: WatcherSettings, role: TunnelRole): Set<string> {
  return new Set(
    settings.tunnels[role].egressServices.flatMap((svc) => [...(settings.egress[svc] ?? [])]),
  );
}
