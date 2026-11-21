// The front door's static half (spec 01 §7.4, §7.5): the zone's Workers routes equal the map
// exactly, and every static deployment is assets only.
import { type Check, type Failure, isRecord, records, roleOf } from "./common.ts";

/** The zone's Workers routes equal §7.5 exactly: no route more, none less, no other Worker. */
export const routes: Check = {
  name: "routes",
  async run(ctx) {
    const failures: Failure[] = [];
    const zoneId = await ctx.zoneId();
    const remote = records(await ctx.cf.list(`/zones/${zoneId}/workers/routes`));
    const scriptOf = (r: Record<string, unknown>) =>
      typeof r.script === "string" && r.script !== "" ? r.script : null;
    const expected = ctx.settings.routes.map((r) => ({
      ...r,
      pattern: `${ctx.settings.hosts[r.host]}${r.path}`,
    }));
    for (const want of expected) {
      const target = `${want.host}${want.path}`;
      const matches = remote.filter((r) => r.pattern === want.pattern);
      if (matches.length === 0) {
        failures.push({ check: "routes", target, detail: "route_missing" });
      } else if (matches.length > 1) {
        failures.push({ check: "routes", target, detail: "route_duplicate" });
      } else if (scriptOf(matches[0] ?? {}) !== want.script) {
        failures.push({ check: "routes", target, detail: "route_wrong_script" });
      }
    }
    const patterns = new Set(expected.map((e) => e.pattern));
    for (const route of remote) {
      if (typeof route.pattern === "string" && patterns.has(route.pattern)) continue;
      const host = typeof route.pattern === "string" ? (route.pattern.split("/")[0] ?? "") : "";
      failures.push({
        check: "routes",
        target: roleOf(ctx.settings, host),
        detail: "route_unexpected",
      });
    }
    return failures;
  },
};

const nonEmpty = (value: unknown) => Array.isArray(value) && value.length > 0;

/** Each static deployment is assets only: §7.4's invariant. No other script runs in the account. */
export const staticDeployments: Check = {
  name: "static",
  async run(ctx) {
    const failures: Failure[] = [];
    const account = ctx.settings.accountId;
    const scripts = records(await ctx.cf.list(`/accounts/${account}/workers/scripts`));
    const known = new Set([...ctx.settings.static.map((s) => s.name), ctx.settings.scriptName]);
    for (const deployment of ctx.settings.static) {
      const add = (detail: string) =>
        failures.push({ check: "static", target: deployment.name, detail });
      const script = scripts.find((s) => s.id === deployment.name);
      if (script === undefined) {
        add("deployment_missing");
        continue;
      }
      if (script.has_modules !== false) add("has_modules");
      if (script.has_assets !== true) add("no_assets");
      if (nonEmpty(script.handlers) || nonEmpty(script.named_handlers)) add("has_handlers");
      if (nonEmpty(script.tail_consumers)) add("has_tail_consumers");
      if (script.compatibility_date !== ctx.settings.staticCompatibilityDate) {
        add("compatibility_date");
      }
      const base = `/accounts/${account}/workers/scripts/${encodeURIComponent(deployment.name)}`;
      const [settings, subdomain, schedules, domains] = await Promise.all([
        ctx.cf.get(`${base}/settings`),
        ctx.cf.get(`${base}/subdomain`),
        ctx.cf.get(`${base}/schedules`),
        ctx.cf.list(`/accounts/${account}/workers/domains`, { service: deployment.name }),
      ]);
      if (!isRecord(settings) || nonEmpty(settings.bindings)) add("has_bindings");
      if (!isRecord(subdomain) || subdomain.enabled !== false) add("workers_dev_on");
      if (!isRecord(subdomain) || subdomain.previews_enabled !== false) add("previews_on");
      if (!isRecord(schedules) || nonEmpty(schedules.schedules)) add("has_schedules");
      if (records(domains).some((d) => d.service === deployment.name)) add("has_custom_domain");
    }
    for (const script of scripts) {
      if (typeof script.id === "string" && !known.has(script.id)) {
        failures.push({ check: "static", target: "other", detail: "unexpected_script" });
      }
    }
    return failures;
  },
};
