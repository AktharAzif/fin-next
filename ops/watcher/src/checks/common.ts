// What every check shares: the failure shape, the run's context, and the tunnel lookup.
import type { CloudflareReader } from "../cloudflare.ts";
import type { HostRole, TunnelRole, WatcherSettings } from "../settings.ts";

export const CHECK_NAMES = [
  "connectors",
  "tunnel-config",
  "dns",
  "routes",
  "static",
  "rules",
  "zone",
  "access",
  "email",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** One failure: which check, what it was about (a role or a name, never an ID), and a code. */
export interface Failure {
  readonly check: CheckName;
  readonly target: string;
  readonly detail: string;
}

export interface CheckContext {
  readonly settings: WatcherSettings;
  readonly cf: CloudflareReader;
  zoneId(): Promise<string>;
  tunnel(role: TunnelRole): Promise<TunnelLookup>;
}

export interface Check {
  readonly name: CheckName;
  run(ctx: CheckContext): Promise<Failure[]>;
}

export type TunnelLookup =
  | { readonly ok: true; readonly id: string; readonly tunnel: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly detail: "tunnel_missing" | "tunnel_duplicate" };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** A tunnel's name, or the dated name a blue and green swap gives its replacement. */
export function tunnelNameMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  return (
    actual === expected || new RegExp(`^${expected.replace(/[.-]/g, "\\$&")}-\\d{12}$`).test(actual)
  );
}

/** The role a hostname belongs to, or "other" (never the hostname itself in a line). */
export function roleOf(settings: WatcherSettings, host: string): HostRole | "other" {
  for (const [role, name] of Object.entries(settings.hosts)) {
    if (name === host) return role as HostRole;
  }
  return "other";
}

/** Builds the shared context: the zone ID and each role's tunnel, read once per run. */
export function makeContext(settings: WatcherSettings, cf: CloudflareReader): CheckContext {
  let zone: Promise<string> | undefined;
  const zoneId = () => {
    zone ??= cf.list("/zones", { name: settings.zone }).then((zones) => {
      const match = records(zones).find((z) => z.name === settings.zone);
      if (match === undefined || typeof match.id !== "string") throw new Error("zone not found");
      return match.id;
    });
    return zone;
  };
  const tunnel = async (role: TunnelRole): Promise<TunnelLookup> => {
    const all = records(
      await cf.list(`/accounts/${settings.accountId}/cfd_tunnel`, { is_deleted: "false" }),
    );
    const matches = all.filter((t) => tunnelNameMatches(settings.tunnels[role].name, t.name));
    if (matches.length === 0) return { ok: false, detail: "tunnel_missing" };
    if (matches.length > 1) return { ok: false, detail: "tunnel_duplicate" };
    const [only] = matches;
    if (only === undefined || typeof only.id !== "string")
      return { ok: false, detail: "tunnel_missing" };
    return { ok: true, id: only.id, tunnel: only };
  };
  return { settings, cf, zoneId, tunnel };
}
