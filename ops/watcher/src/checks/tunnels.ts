// The tunnel checks (spec 01 §7.3, §7.11): connectors, tunnel-config and dns.
import { allowedOrigins, TUNNEL_ROLES } from "../settings.ts";
import { type Check, type Failure, records } from "./common.ts";

/** Per tunnel: the connector count, every connector's version, every connection's origin. */
export const connectors: Check = {
  name: "connectors",
  async run(ctx) {
    const failures: Failure[] = [];
    for (const role of TUNNEL_ROLES) {
      const add = (detail: string) => failures.push({ check: "connectors", target: role, detail });
      const found = await ctx.tunnel(role);
      if (!found.ok) {
        add(found.detail);
        continue;
      }
      const clients = records(
        await ctx.cf.get(`/accounts/${ctx.settings.accountId}/cfd_tunnel/${found.id}/connections`),
      );
      const expected = ctx.settings.tunnels[role].replicas;
      if (clients.length !== expected) add("count_mismatch");
      const version = ctx.settings.connectorVersion;
      const conns = clients.flatMap((c) => records(c.conns));
      const versions = [
        ...clients.map((c) => c.version),
        ...conns.map((c) => c.client_version).filter((v) => v !== undefined),
      ];
      if (versions.some((v) => v !== version)) add("version_mismatch");
      const allowed = allowedOrigins(ctx.settings, role);
      if (conns.some((c) => typeof c.origin_ip !== "string" || !allowed.has(c.origin_ip))) {
        add("origin_unexpected");
      }
    }
    return failures;
  },
};

/** Each tunnel is locally managed: no remote configuration. */
export const tunnelConfig: Check = {
  name: "tunnel-config",
  async run(ctx) {
    const failures: Failure[] = [];
    for (const role of TUNNEL_ROLES) {
      const add = (detail: string) =>
        failures.push({ check: "tunnel-config", target: role, detail });
      const found = await ctx.tunnel(role);
      if (!found.ok) {
        add(found.detail);
        continue;
      }
      if (found.tunnel.remote_config !== false) add("remote_config");
      if (found.tunnel.config_src !== undefined && found.tunnel.config_src !== "local") {
        add("config_src_not_local");
      }
    }
    return failures;
  },
};

/** Each host's record is one proxied CNAME to its own tunnel. */
export const dns: Check = {
  name: "dns",
  async run(ctx) {
    const failures: Failure[] = [];
    const zoneId = await ctx.zoneId();
    for (const role of TUNNEL_ROLES) {
      const found = await ctx.tunnel(role);
      for (const hostRole of ctx.settings.tunnels[role].hosts) {
        const add = (detail: string) => failures.push({ check: "dns", target: hostRole, detail });
        const host = ctx.settings.hosts[hostRole];
        const all = records(await ctx.cf.list(`/zones/${zoneId}/dns_records`, { name: host }));
        const list = all.filter((r) => r.name === host);
        if (list.length === 0) {
          add("record_missing");
          continue;
        }
        if (list.length > 1) add("record_duplicate");
        for (const record of list) {
          if (record.type !== "CNAME") add("record_not_cname");
          if (record.proxied !== true) add("record_not_proxied");
          if (!found.ok) add("tunnel_unknown");
          else if (record.content !== `${found.id}.cfargotunnel.com`) add("record_wrong_tunnel");
        }
      }
    }
    return failures;
  },
};
