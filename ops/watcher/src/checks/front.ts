// The front door's static half (spec 01 §7.4, §7.5, §7.11; ARCHITECTURE §5.9): the Workers routes
// on fin-next's hosts equal the map exactly and no other route reaches one of them; every static
// deployment is assets only and serves the version the last registered static deploy uploaded; no
// fin-next Worker but the watcher exists beside them, and no Worker is bound to a custom domain on
// a fin-next host.
//
// The account and the zone are shared with the old product's staging (FD-09): its own Workers,
// routes and custom domains on its own hosts are not fin-next's and never fail a check.
import { roleOwning, rolesMatching } from "../settings.ts";
import { type Check, type Failure, isRecord, records } from "./common.ts";

/** Every Worker fin-next makes is named `fin-next-<env>-...` (spec 01 §7.4, §7.11). */
export const FIN_SCRIPT_PREFIX = "fin-next-";

/** The zone's Workers routes on fin-next's hosts equal §7.5 exactly. */
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
    // Any other route that reaches a fin-next host, exactly or through a wildcard, is one too
    // many; a route on another product's own host is not fin-next's.
    const patterns = new Set(expected.map((e) => e.pattern));
    for (const route of remote) {
      if (typeof route.pattern !== "string" || patterns.has(route.pattern)) continue;
      for (const role of rolesMatching(ctx.settings, route.pattern)) {
        failures.push({ check: "routes", target: role, detail: "route_unexpected" });
      }
    }
    return failures;
  },
};

const nonEmpty = (value: unknown) => Array.isArray(value) && value.length > 0;

/** The version a deployment serves: its latest deployment's one version at 100 %. */
function activeVersion(value: unknown): { id?: string; split: boolean } {
  const deployments = isRecord(value) ? records(value.deployments) : [];
  const [latest] = deployments;
  if (latest === undefined) return { split: false };
  const versions = records(latest.versions);
  const [only] = versions;
  if (versions.length !== 1 || only === undefined || Number(only.percentage) !== 100) {
    return { split: true };
  }
  return typeof only.version_id === "string"
    ? { id: only.version_id, split: false }
    : { split: false };
}

/** Each static deployment is assets only (§7.4's invariant) and serves its registered version. */
export const staticDeployments: Check = {
  name: "static",
  async run(ctx) {
    const failures: Failure[] = [];
    const account = ctx.settings.accountId;
    const [scripts, domains] = await Promise.all([
      ctx.cf.list(`/accounts/${account}/workers/scripts`).then(records),
      ctx.cf.list(`/accounts/${account}/workers/domains`).then(records),
    ]);
    const known = new Set([...ctx.settings.static.map((s) => s.name), ctx.settings.scriptName]);
    for (const deployment of ctx.settings.static) {
      const add = (detail: string) =>
        failures.push({ check: "static", target: deployment.name, detail });
      // Its own target, so a standing version failure never hides a change of shape.
      const addVersion = (detail: string) =>
        failures.push({ check: "static", target: `${deployment.name}/version`, detail });
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
      const [settings, subdomain, schedules, deployed] = await Promise.all([
        ctx.cf.get(`${base}/settings`),
        ctx.cf.get(`${base}/subdomain`),
        ctx.cf.get(`${base}/schedules`),
        ctx.cf.get(`${base}/deployments`),
      ]);
      if (!isRecord(settings) || nonEmpty(settings.bindings)) add("has_bindings");
      if (!isRecord(subdomain) || subdomain.enabled !== false) add("workers_dev_on");
      if (!isRecord(subdomain) || subdomain.previews_enabled !== false) add("previews_on");
      if (!isRecord(schedules) || nonEmpty(schedules.schedules)) add("has_schedules");
      if (domains.some((d) => d.service === deployment.name)) add("has_custom_domain");
      // Every upload makes a new version, so a version the registered static deploy did not
      // read back is an upload outside a registered run (AC-P0-15).
      const active = activeVersion(deployed);
      const registered = ctx.settings.staticVersions[deployment.name];
      if (active.split) addVersion("version_split");
      else if (registered === undefined) addVersion("version_unset");
      else if (active.id === undefined) addVersion("version_unknown");
      else if (active.id !== registered) addVersion("version_changed");
    }
    // No fin-next Worker but the deployments and the watcher. The old product's own Workers are
    // not fin-next's; one of them bound to a fin-next host shows below or in the routes check.
    for (const script of scripts) {
      const id = script.id;
      if (typeof id === "string" && id.startsWith(FIN_SCRIPT_PREFIX) && !known.has(id)) {
        failures.push({ check: "static", target: id, detail: "unexpected_script" });
      }
    }
    // No Worker, whosever, is bound to a custom domain on a fin-next host or a name under one.
    for (const domain of domains) {
      const role =
        typeof domain.hostname === "string" ? roleOwning(ctx.settings, domain.hostname) : undefined;
      if (role !== undefined) {
        failures.push({ check: "static", target: role, detail: "custom_domain_on_host" });
      }
    }
    return failures;
  },
};
