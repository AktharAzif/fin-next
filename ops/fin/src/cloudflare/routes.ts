// `pnpm fin routes apply <env>` (spec 01 §7.2 and §7.5, [FD-18], EXECUTION §2.5 steps 6 and 8):
// the Workers routes first (`<host>/*` to the host's assets-only deployment, `<host>/api/*` with no
// Worker on every app host but the docs host), then the proxied CNAMEs to each host's tunnel, so no
// host answers before its routes exist. Routes on Fin's hosts that the settings do not list are
// deleted (with --confirm-delete), whatever their path; the API host has no route at all.
//
// A route of any other shape that still matches one of Fin's hosts (another product's
// `*.<zone>/*`, say, which would send the API host's requests to that product's Worker) is refused
// before anything is sent and left alone: §7.5 forbids touching another name, and §7.11 requires
// that no other route on the zone matches Fin's names. Records and routes on any other host are
// never written. Every pending write is checked before the run registers.

import type { Command } from "../command.ts";
import type { Context } from "../core/context.ts";
import { RefusedError } from "../core/errors.ts";
import { type HostRole, hostOf } from "../core/overlay.ts";
import type { Change } from "../core/plan.ts";
import type { TunnelRole } from "../core/settings.ts";
import { patternHost, type WriteTarget } from "./api.ts";
import { cloudflare, registerId, requireTunnel } from "./common.ts";

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
  role: HostRole;
  tunnel: TunnelRole;
  content: string;
}

interface Write {
  target: WriteTarget;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
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

/** Whether a Workers route's host part (`*` matches any run of characters) matches `host`. */
export function routeHostMatches(patternHostPart: string, host: string): boolean {
  if (patternHostPart === host) return true;
  if (!patternHostPart.includes("*")) return false;
  const pattern = patternHostPart
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\-]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(host);
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
        records.push({
          name,
          role: hostRole,
          tunnel: role,
          content: `${tunnels[role].id}.cfargotunnel.com`,
        });
      }
    }
    const ourHosts = new Set(records.map((r) => r.name.toLowerCase()));

    const changes: Change[] = [];
    const zoneRoutes = await api.list<Route>(`${zonePath}/workers/routes`);
    // Another shape of route that reaches a Fin host is someone else's to remove.
    for (const route of zoneRoutes) {
      const host = patternHost(route.pattern);
      if (ourHosts.has(host)) continue;
      const reached = [...ourHosts].filter((h) => routeHostMatches(host, h));
      if (reached.length > 0) {
        throw new RefusedError(
          `another route (${route.pattern}) matches ${reached.join(", ")}; resolve it by hand (pnpm fin never touches another name's route)`,
        );
      }
    }
    const existingRoutes = zoneRoutes.filter((r) => ourHosts.has(patternHost(r.pattern)));
    existingRoutes.forEach((r, i) => {
      registerId(ctx, r.id, "route", String(i + 1));
    });
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
      for (const r of exact) registerId(ctx, r.id, "dns", want.role);
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

    /** The one write a change sends. */
    const writeFor = (change: Change): Write | undefined => {
      if (change.kind === "route") {
        const want = routes.find((r) => r.pattern === change.name);
        const id = routeIds.get(change.name);
        const target: WriteTarget = {
          kind: "route",
          pattern: change.name,
          ...(id === undefined ? {} : { id }),
        };
        const body =
          want === undefined
            ? undefined
            : { pattern: want.pattern, ...(want.script === null ? {} : { script: want.script }) };
        if (change.action === "create")
          return { target, method: "POST", path: `${zonePath}/workers/routes`, body };
        if (change.action === "update")
          return { target, method: "PUT", path: `${zonePath}/workers/routes/${id}`, body };
        if (change.action === "delete")
          return { target, method: "DELETE", path: `${zonePath}/workers/routes/${id}` };
        return undefined;
      }
      const want = records.find((r) => r.name === change.name);
      if (want === undefined) return undefined;
      const id = recordIds.get(want.name);
      const target: WriteTarget = {
        kind: "dns",
        name: want.name,
        ...(id === undefined ? {} : { id }),
      };
      const body = {
        type: "CNAME",
        name: want.name,
        content: want.content,
        proxied: true,
        ttl: 1,
        comment: DNS_COMMENT,
      };
      if (change.action === "create")
        return { target, method: "POST", path: `${zonePath}/dns_records`, body };
      if (change.action === "update")
        return { target, method: "PATCH", path: `${zonePath}/dns_records/${id}`, body };
      return undefined;
    };

    return ctx.applyPlan(
      "routes and DNS",
      changes,
      async (change) => {
        const write = writeFor(change);
        if (write !== undefined)
          await writer.write(write.target, write.method, write.path, write.body);
      },
      {},
      {
        check: (change) => {
          const write = writeFor(change);
          if (write !== undefined) writer.check(write.target, write.method, write.path, write.body);
        },
      },
    );
  },
};
