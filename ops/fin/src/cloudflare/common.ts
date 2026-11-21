// What the Cloudflare commands share: the clients built from a context, the zone check, the tunnel
// lookup, and the registration of every object ID a command reads (spec 01 §9.2: `pnpm fin` prints
// names, never IDs), each under a placeholder that names its role and nothing private.

import type { Context } from "../core/context.ts";
import { ConfigError, RefusedError } from "../core/errors.ts";
import { type HostRole, hostOf } from "../core/overlay.ts";
import type { TunnelRole } from "../core/settings.ts";
import { RailwayApi } from "../railway/api.ts";
import { CloudflareApi, CloudflareWriter } from "./api.ts";

export interface Clients {
  api: CloudflareApi;
  writer: CloudflareWriter;
  accountPath: string;
}

/**
 * Registers an object ID with the masker as `<kind>` or `<kind:label>`. The label must be public (a
 * role, a `fin_next_` ref, an ordinal), never a hostname: a placeholder is printed as it is.
 */
export function registerId(ctx: Context, id: unknown, kind: string, label?: string): void {
  if (typeof id !== "string" || id === "") return;
  ctx.masker.register(id, label === undefined ? `<${kind}>` : `<${kind}:${label}>`);
}

export function cloudflare(ctx: Context, settingIds: Iterable<string> = []): Clients {
  const api = new CloudflareApi(ctx.credential("FIN_CF_TOKEN_FILE"), ctx.runtime, ctx.masker);
  const writer = new CloudflareWriter(api, ctx.guard, ctx.run, ctx.overlay, {
    settings: settingIds,
    now: () => ctx.runtime.now(),
    tokenServices: { [ctx.settings.email.token.name]: ctx.settings.email.token.service },
    identityProvider: ctx.settings.access.identityProvider,
  });
  return { api, writer, accountPath: `/accounts/${ctx.overlay.cloudflare.accountId}` };
}

/**
 * Reads the overlay's zone from Cloudflare (by the overlay's zone ID when it names one, otherwise
 * by the zone's name in the overlay's account) and binds the guard to Cloudflare's answer, so every
 * zone check and zone write uses the checked ID (core/guard.ts). Returns the zone's path. A command
 * calls it before anything that concerns the zone.
 */
export async function bindZone(ctx: Context, api: CloudflareApi): Promise<string> {
  const { accountId, zoneId } = ctx.overlay.cloudflare;
  let answer: unknown;
  if (zoneId !== undefined) answer = await api.get<unknown>(`/zones/${zoneId}`);
  else {
    const zones = await api.list<unknown>("/zones", {
      name: ctx.overlay.zone,
      "account.id": accountId,
    });
    if (zones.length !== 1) {
      throw new RefusedError(
        `Cloudflare holds ${zones.length} zones under the overlay's zone name in its account, not one; nothing is sent`,
      );
    }
    answer = zones[0];
  }
  const id = ctx.guard.bindZone(answer);
  registerId(ctx, id, "zone");
  return `/zones/${id}`;
}

export function railway(ctx: Context): RailwayApi {
  return new RailwayApi(
    ctx.credential("FIN_RAILWAY_TOKEN_FILE"),
    ctx.runtime,
    ctx.overlay,
    ctx.masker,
  );
}

/** The hostnames of a list of roles, each checked by the guard. */
export function hosts(ctx: Context, roles: readonly HostRole[]): string[] {
  return roles.map((role) => {
    const host = hostOf(ctx.overlay, role);
    ctx.guard.checkName(host, `host ${role}`);
    return host;
  });
}

export interface Tunnel {
  id: string;
  name: string;
  config_src?: string;
  remote_config?: boolean;
  deleted_at?: string | null;
}

/** Finds one of Fin's tunnels by name; undefined when it does not exist. */
export async function findTunnel(
  ctx: Context,
  api: CloudflareApi,
  role: TunnelRole,
): Promise<Tunnel | undefined> {
  const name = ctx.settings.tunnels[role].name;
  ctx.guard.checkOwnName(name, "tunnel");
  const found = await api.list<Tunnel>(`/accounts/${ctx.overlay.cloudflare.accountId}/cfd_tunnel`, {
    name,
    is_deleted: false,
  });
  const live = found.filter(
    (t) => t.name === name && (t.deleted_at === null || t.deleted_at === undefined),
  );
  if (live.length > 1)
    throw new RefusedError(`two live tunnels are named ${name}; resolve it by hand`);
  const tunnel = live[0];
  if (tunnel === undefined) return undefined;
  ctx.masker.register(tunnel.id, `<tunnel:${role}>`);
  if (tunnel.config_src !== undefined && tunnel.config_src !== "local") {
    throw new RefusedError(
      `tunnel ${name} is remotely managed (config_src ${tunnel.config_src}); it must be locally managed (SP-04a): evict and recreate it`,
    );
  }
  return tunnel;
}

export async function requireTunnel(
  ctx: Context,
  api: CloudflareApi,
  role: TunnelRole,
): Promise<Tunnel> {
  const tunnel = await findTunnel(ctx, api, role);
  if (tunnel === undefined) {
    throw new ConfigError(
      `tunnel ${ctx.settings.tunnels[role].name} does not exist; run: pnpm fin tunnel create ${ctx.environment} ${role}`,
    );
  }
  return tunnel;
}
