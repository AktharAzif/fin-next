// `pnpm fin routes apply <env>` (spec 01 §7.2 and §7.5, [FD-18], EXECUTION §2.5 steps 6 and 8):
// the Workers routes first (`<host>/*` to the host's assets-only deployment, `<host>/api/*` with no
// Worker on every app host but the docs host), then the proxied CNAMEs to each host's tunnel, so no
// host answers before its routes exist. Routes on Fin's hosts that the settings do not list are
// deleted (with --confirm-delete); the API host has no route at all. Records and routes on any
// other host are never read for change, let alone written.

import type { Command } from "../command.ts";
import type { Context } from "../core/context.ts";
import { hostOf } from "../core/overlay.ts";
import type { Change } from "../core/plan.ts";
import type { TunnelRole } from "../core/settings.ts";
import { cloudflare, requireTunnel } from "./common.ts";

interface Route {
  id: string;
  pattern: string;
  script?: string | null;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  comment?: string | null;
}

interface DesiredRoute {
  pattern: string;
  script: string | null;
}

interface DesiredRecord {
  name: string;
  tunnel: TunnelRole;
  content: string;
}

export const DNS_COMMENT = "fin-next: pnpm fin routes apply";

export function desiredRoutes(ctx: Context): DesiredRoute[] {
  const routes: DesiredRoute[] = [];
  for (const name of ctx.settings.staticOrder) {
    const s = ctx.settings.static[name];
    if (s === undefined) continue;
    const host = hostOf(ctx.overlay, s.host);
    routes.push({ pattern: `${host}/*`, script: s.script });
    if (s.apiRoute) routes.push({ pattern: `${host}/api/*`, script: null });
  }
  for (const r of routes) ctx.guard.checkRoutePattern(r.pattern);
  return routes;
}

function hostOfPattern(pattern: string): string {
  return (pattern.split("/")[0] ?? "").toLowerCase();
}

export const routesApply: Command = {
  words: ["routes", "apply"],
  summary: "apply the Workers routes, then the proxied CNAMEs to the tunnels",
  positionals: [],
  flags: [],
  overlay: true,
  mutating: true,
  runbook: "routes-apply.md",
  async run(ctx) {
    const { api, writer, zonePath } = cloudflare(ctx);
    const tunnels = {
      public: await requireTunnel(ctx, api, "public"),
      admin: await requireTunnel(ctx, api, "admin"),
    };
    const routes = desiredRoutes(ctx);
    const records: DesiredRecord[] = [];
    for (const role of ["public", "admin"] as const) {
      for (const hostRole of ctx.settings.tunnels[role].hosts) {
        const name = hostOf(ctx.overlay, hostRole);
        ctx.guard.checkName(name, "dns record");
        records.push({ name, tunnel: role, content: `${tunnels[role].id}.cfargotunnel.com` });
      }
    }
    const ourHosts = new Set(records.map((r) => r.name.toLowerCase()));

    const changes: Change[] = [];
    const existingRoutes = (await api.list<Route>(`${zonePath}/workers/routes`)).filter((r) =>
      ourHosts.has(hostOfPattern(r.pattern)),
    );
    const routeIds = new Map<string, string>();
    for (const want of routes) {
      const found = existingRoutes.find((r) => r.pattern === want.pattern);
      const detail =
        want.script === null ? "-> no Worker (falls through to the tunnel)" : `-> ${want.script}`;
      if (found === undefined)
        changes.push({ kind: "route", name: want.pattern, action: "create", detail });
      else {
        routeIds.set(want.pattern, found.id);
        const same = (found.script ?? null) === want.script;
        changes.push({
          kind: "route",
          name: want.pattern,
          action: same ? "keep" : "update",
          detail,
          ...(same ? {} : { fields: ["script"] }),
        });
      }
    }
    for (const r of existingRoutes) {
      if (!routes.some((w) => w.pattern === r.pattern)) {
        routeIds.set(r.pattern, r.id);
        changes.push({
          kind: "route",
          name: r.pattern,
          action: "delete",
          detail: `(was -> ${r.script ?? "no Worker"})`,
        });
      }
    }

    const recordIds = new Map<string, string>();
    for (const want of records) {
      const found = await api.list<DnsRecord>(`${zonePath}/dns_records`, { name: want.name });
      const exact = found.filter((r) => r.name.toLowerCase() === want.name.toLowerCase());
      const detail = `CNAME -> ${want.content} (proxied)`;
      const other = exact.find((r) => r.type !== "CNAME");
      if (other !== undefined) {
        changes.push({
          kind: "dns",
          name: want.name,
          action: "update",
          detail,
          held: `a ${other.type} record holds this name; resolve it by hand`,
        });
        continue;
      }
      const cname = exact[0];
      if (cname === undefined) {
        changes.push({ kind: "dns", name: want.name, action: "create", detail });
        continue;
      }
      recordIds.set(want.name, cname.id);
      const fields: string[] = [];
      if (cname.content.toLowerCase() !== want.content.toLowerCase()) fields.push("content");
      if (cname.proxied !== true) fields.push("proxied");
      changes.push({
        kind: "dns",
        name: want.name,
        action: fields.length === 0 ? "keep" : "update",
        detail,
        ...(fields.length === 0 ? {} : { fields }),
      });
    }

    return ctx.applyPlan("routes and DNS", changes, async (change) => {
      if (change.kind === "route") {
        const want = routes.find((r) => r.pattern === change.name);
        const id = routeIds.get(change.name);
        const body =
          want === undefined
            ? undefined
            : { pattern: want.pattern, ...(want.script === null ? {} : { script: want.script }) };
        if (change.action === "create") {
          await writer.write(
            { kind: "route", pattern: change.name },
            "POST",
            `${zonePath}/workers/routes`,
            body,
          );
        } else if (change.action === "update") {
          await writer.write(
            { kind: "route", pattern: change.name },
            "PUT",
            `${zonePath}/workers/routes/${id}`,
            body,
          );
        } else if (change.action === "delete") {
          await writer.write(
            { kind: "route", pattern: change.name },
            "DELETE",
            `${zonePath}/workers/routes/${id}`,
          );
        }
        return;
      }
      const want = records.find((r) => r.name === change.name);
      if (want === undefined) return;
      const body = {
        type: "CNAME",
        name: want.name,
        content: want.content,
        proxied: true,
        ttl: 1,
        comment: DNS_COMMENT,
      };
      if (change.action === "create") {
        await writer.write(
          { kind: "dns", name: want.name },
          "POST",
          `${zonePath}/dns_records`,
          body,
        );
      } else if (change.action === "update") {
        await writer.write(
          { kind: "dns", name: want.name },
          "PATCH",
          `${zonePath}/dns_records/${recordIds.get(want.name)}`,
          body,
        );
      }
    });
  },
};
