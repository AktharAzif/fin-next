// What the Cloudflare commands share: the clients built from a context, and the tunnel lookup.

import type { Context } from "../core/context.ts";
import { ConfigError, RefusedError } from "../core/errors.ts";
import { type HostRole, hostOf } from "../core/overlay.ts";
import type { TunnelRole } from "../core/settings.ts";
import { RailwayApi } from "../railway/api.ts";
import { CloudflareApi, CloudflareWriter } from "./api.ts";

export interface Clients {
  api: CloudflareApi;
  writer: CloudflareWriter;
  zonePath: string;
  accountPath: string;
}

export function cloudflare(ctx: Context, settingIds: Iterable<string> = []): Clients {
  const api = new CloudflareApi(ctx.credential("FIN_CF_TOKEN_FILE"), ctx.runtime);
  const writer = new CloudflareWriter(api, ctx.guard, ctx.run, ctx.overlay, settingIds);
  return {
    api,
    writer,
    zonePath: `/zones/${ctx.overlay.cloudflare.zoneId}`,
    accountPath: `/accounts/${ctx.overlay.cloudflare.accountId}`,
  };
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
