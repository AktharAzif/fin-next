// What every check shares: the failure shape, the run's context, and the tunnel lookup.
import type { CloudflareReader } from "../cloudflare.ts";
import type { TunnelRole, WatcherSettings } from "../settings.ts";

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

/**
 * One failure: which check, what it was about (a role or a fin-next name, never an ID or a
 * hostname), and a code. Alerts open one incident per check, target and detail together
 * (ops/monitoring's catalogue holds them to it), so a failure that stands for a while never hides
 * a later, different one.
 */
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

/** The stamp a blue and green swap appends to its replacement's name: twelve digits. */
const SWAP_STAMP = /^[0-9]{12}$/;

/**
 * A tunnel's name, or the dated name a blue and green swap gives its replacement. The configured
 * name is compared as text, never built into a pattern, so no character in it needs escaping.
 */
export function tunnelNameMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  if (actual === expected) return true;
  const prefix = `${expected}-`;
  return actual.startsWith(prefix) && SWAP_STAMP.test(actual.slice(prefix.length));
}

/** Builds the shared context: the zone ID and each role's tunnel, read once per run. */
export function makeContext(settings: WatcherSettings, cf: CloudflareReader): CheckContext {
  let zone: Promise<string> | undefined;
  const zoneId = () => {
    // The zone of this name in this account, and only one: a second zone of the same name (one
    // pending in another account, say) must never be the one the checks read.
    zone ??= cf.list("/zones", { name: settings.zone }).then((zones) => {
      const matches = records(zones).filter(
        (z) =>
          z.name === settings.zone && (!isRecord(z.account) || z.account.id === settings.accountId),
      );
      const [only] = matches;
      if (matches.length !== 1 || only === undefined || typeof only.id !== "string") {
        throw new Error(matches.length > 1 ? "zone ambiguous" : "zone not found");
      }
      return only.id;
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
