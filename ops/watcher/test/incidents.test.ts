// How the watcher's failures become incidents, as ops/monitoring's alerts group them: each alert
// opens one incident per series, so a failure that stands (an unset hash or version, a setting a
// registered run has not caught up with, another product's object that waits for its owner) must
// never share a series with a later, different failure, or the later one opens nothing.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Failure, makeContext } from "../src/checks/common.ts";
import { CloudflareReader } from "../src/cloudflare.ts";
import { accessPolicyHash, rulesetHash } from "../src/hash.ts";
import { CHECKS } from "../src/run.ts";
import type { WatcherSettings } from "../src/settings.ts";
import {
  ADMIN_TUNNEL,
  cloudflareFetch,
  HOSTS,
  healthyWorld,
  OLD_SCRIPT,
  PUBLIC_TUNNEL,
  settingsFor,
  type World,
  ZONE,
} from "./world.ts";

type Json = Record<string, unknown>;

interface WatcherAlert {
  readonly name: string;
  readonly checks: readonly string[];
  readonly seriesBy: readonly string[];
}

/** The alerts over watcher.check_failed in ops/monitoring/staging: the checks each reads, its series. */
function watcherAlerts(): WatcherAlert[] {
  const dir = join(import.meta.dirname, "..", "..", "monitoring", "staging", "alerts");
  const out: WatcherAlert[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const { alerts } = JSON.parse(readFileSync(join(dir, file), "utf8")) as { alerts: Json[] };
    for (const alert of alerts) {
      const count = (alert.query as Json | undefined)?.count as Json | undefined;
      if (!((count?.events as string[] | undefined) ?? []).includes("watcher.check_failed"))
        continue;
      const where = (count?.where as Json[] | undefined) ?? [];
      const checks = (where.find((c) => c.field === "check")?.in as string[] | undefined) ?? [];
      const by = alert.seriesBy;
      const seriesBy = typeof by === "string" ? [by] : Array.isArray(by) ? by.map(String) : [];
      out.push({ name: String(alert.name), checks, seriesBy });
    }
  }
  return out;
}

const ALERTS = watcherAlerts();
const key = (f: Failure) => `${f.check}/${f.target}/${f.detail}`;

/** The incident a failure opens or joins: its one alert, and its series in that alert. */
function incidentOf(f: Failure): string {
  const watching = ALERTS.filter((a) => a.checks.includes(f.check));
  if (watching.length !== 1) throw new Error(`${key(f)} is watched by ${watching.length} alerts`);
  const [alert] = watching as [WatcherAlert];
  const fields: Readonly<Record<string, string>> = f as unknown as Record<string, string>;
  return `${alert.name} ${alert.seriesBy.map((field) => fields[field] ?? "").join("/")}`;
}

async function failuresOf(world: World, settings: WatcherSettings): Promise<Failure[]> {
  const ctx = makeContext(settings, new CloudflareReader("t", cloudflareFetch(world)));
  const out: Failure[] = [];
  for (const check of CHECKS) out.push(...(await check.run(ctx)));
  return out;
}

interface Case {
  readonly name: string;
  /** What stands first, and what changes after. */
  readonly before: () => Promise<{ world: World; settings: WatcherSettings }>;
  readonly after: () => Promise<{ world: World; settings: WatcherSettings }>;
  readonly standing: readonly string[];
  readonly later: readonly string[];
}

const healthy = async () => {
  const world = healthyWorld();
  return { world, settings: await settingsFor(world) };
};
const app = (world: World) =>
  world.accessApps.find((a) => a.name === "fin-next-staging-admin") as Json & { policies: Json[] };
const REDIRECT = "http_request_dynamic_redirect";
const HEADERS = "http_response_headers_transform";
const MANAGED = "http_request_firewall_managed";
const STATIC = "fin-next-staging-console-static";

/** Another product's rule in a phase fin-next writes, aimed at one of fin-next's hosts. */
function hijack(world: World, phase: string, host: string): void {
  world.entrypoints[phase]?.unshift({
    id: `rule-hijack-${phase}`,
    ref: `legacy_hijack_${phase}`,
    expression: `(http.host eq "${host}")`,
    action: phase === REDIRECT ? "redirect" : "rewrite",
  });
}

/** The settings #9 records today for the shared redirect phase: the whole phase hashed. */
async function wholePhaseSettings(world: World): Promise<WatcherSettings> {
  const settings = await settingsFor(world);
  const {
    [HEADERS]: _headers,
    [MANAGED]: _managed,
    ...hashes
  } = settings.rulesetHashes as Record<string, string>;
  return {
    ...settings,
    rulesetHashes: { ...hashes, [REDIRECT]: await rulesetHash(world.entrypoints[REDIRECT] ?? []) },
    accessPolicyHash: null,
  };
}

const withoutHash = async (world: World, phase: string): Promise<WatcherSettings> => {
  const settings = await settingsFor(world);
  const { [phase]: _dropped, ...rest } = settings.rulesetHashes as Record<string, string>;
  return { ...settings, rulesetHashes: rest };
};

const CASES: readonly Case[] = [
  {
    name: "an unset rules hash, then another product's rule naming a fin-next host in that phase",
    before: async () => {
      const world = healthyWorld();
      return { world, settings: await withoutHash(world, REDIRECT) };
    },
    after: async () => {
      const world = healthyWorld();
      const settings = await withoutHash(world, REDIRECT);
      hijack(world, REDIRECT, HOSTS.console);
      return { world, settings };
    },
    standing: [`rules/${REDIRECT}/hash_unset`],
    later: [`rules/${REDIRECT}/foreign_rule`],
  },
  {
    name: "the whole-phase hash and unset hashes, then foreign rules and a widened Access policy",
    before: async () => {
      const world = healthyWorld();
      return { world, settings: await wholePhaseSettings(world) };
    },
    after: async () => {
      const world = healthyWorld();
      const settings = await wholePhaseSettings(world);
      hijack(world, REDIRECT, HOSTS.console);
      hijack(world, HEADERS, HOSTS.verify);
      const admin = app(world);
      admin.policies[0] = { ...admin.policies[0], include: [{ everyone: {} }] };
      admin.mfa_config = { mfa_disabled: true };
      admin.enable_binding_cookie = false;
      return { world, settings };
    },
    standing: [
      `rules/${REDIRECT}/ruleset_hash_mismatch`,
      `rules/${HEADERS}/hash_unset`,
      `rules/${MANAGED}/hash_unset`,
      "access/fin-next-staging-admin/hash_unset",
    ],
    later: [
      `rules/${REDIRECT}/foreign_rule`,
      `rules/${HEADERS}/foreign_rule`,
      "access/fin-next-staging-admin/binding_cookie",
      "access/fin-next-staging-admin/mfa_not_required",
      "access/fin-next-staging-admin/policy_everyone",
    ],
  },
  {
    name: "another product's custom domain on the admin host, then a wildcard route over every host",
    before: async () => {
      const world = healthyWorld();
      world.domains.push({ id: "d-admin", hostname: HOSTS.admin, service: OLD_SCRIPT });
      return { world, settings: await settingsFor(healthyWorld()) };
    },
    after: async () => {
      const world = healthyWorld();
      world.domains.push({ id: "d-admin", hostname: HOSTS.admin, service: OLD_SCRIPT });
      world.routes.push({ id: "wild", pattern: `*.${ZONE}/*`, script: OLD_SCRIPT });
      return { world, settings: await settingsFor(healthyWorld()) };
    },
    standing: ["static/admin/custom_domain_on_host"],
    later: ["console", "admin", "verify", "selfie", "docs", "api"].map(
      (role) => `routes/${role}/route_unexpected`,
    ),
  },
  {
    name: "a wildcard route over the admin host, then another product's custom domain on it",
    before: async () => {
      const world = healthyWorld();
      world.routes.push({ id: "wild", pattern: `*${HOSTS.admin}/*`, script: OLD_SCRIPT });
      return { world, settings: await settingsFor(healthyWorld()) };
    },
    after: async () => {
      const world = healthyWorld();
      world.routes.push({ id: "wild", pattern: `*${HOSTS.admin}/*`, script: OLD_SCRIPT });
      world.domains.push({ id: "d-admin", hostname: HOSTS.admin, service: OLD_SCRIPT });
      return { world, settings: await settingsFor(healthyWorld()) };
    },
    standing: ["routes/admin/route_unexpected"],
    later: ["static/admin/custom_domain_on_host"],
  },
  {
    name: "a connector upgraded ahead of the settings, then a connector from outside the egress",
    before: async () => {
      const world = healthyWorld();
      const [client] = world.connections[PUBLIC_TUNNEL] ?? [];
      Object.assign(client ?? {}, { version: "2026.11.2" });
      return { world, settings: await settingsFor(healthyWorld()) };
    },
    after: async () => {
      const world = healthyWorld();
      const [client] = world.connections[PUBLIC_TUNNEL] ?? [];
      Object.assign(client ?? {}, { version: "2026.11.2" });
      world.connections[PUBLIC_TUNNEL]?.push({
        id: "client-2",
        version: "2026.11.2",
        conns: [{ origin_ip: ["198", "51", "100", "7"].join("."), client_version: "2026.11.2" }],
      });
      return { world, settings: await settingsFor(healthyWorld()) };
    },
    standing: ["connectors/public/version_mismatch"],
    later: ["connectors/public/count_mismatch", "connectors/public/origin_unexpected"],
  },
  {
    name: "a second record on the admin host, then the admin tunnel made remotely managed",
    before: async () => {
      const world = healthyWorld();
      world.dns.push({
        id: "x",
        type: "A",
        name: HOSTS.admin,
        content: "192.0.2.1",
        proxied: true,
      });
      return { world, settings: await settingsFor(healthyWorld()) };
    },
    after: async () => {
      const world = healthyWorld();
      world.dns.push({
        id: "x",
        type: "A",
        name: HOSTS.admin,
        content: "192.0.2.1",
        proxied: true,
      });
      const tunnel = world.tunnels.find((t) => t.id === ADMIN_TUNNEL);
      Object.assign(tunnel ?? {}, { remote_config: true, config_src: "cloudflare" });
      return { world, settings: await settingsFor(healthyWorld()) };
    },
    standing: [
      "dns/admin/record_duplicate",
      "dns/admin/record_not_cname",
      "dns/admin/record_wrong_tunnel",
    ],
    later: ["tunnel-config/admin/remote_config", "tunnel-config/admin/config_src_not_local"],
  },
  {
    name: "an unset static version, then a registered one the deployment no longer serves",
    before: async () => {
      const world = healthyWorld();
      const settings = await settingsFor(world);
      const { [STATIC]: _dropped, ...versions } = settings.staticVersions as Record<string, string>;
      return { world, settings: { ...settings, staticVersions: versions } };
    },
    after: async () => {
      const world = healthyWorld();
      const settings = await settingsFor(world);
      const versions = { ...settings.staticVersions, [STATIC]: `ver-${STATIC}-1` };
      return { world, settings: { ...settings, staticVersions: versions } };
    },
    standing: [`static/${STATIC}/version/version_unset`],
    later: [`static/${STATIC}/version/version_changed`],
  },
  {
    name: "an unset rules hash, then a registered one fin-next's rules no longer match",
    before: async () => {
      const world = healthyWorld();
      return { world, settings: await withoutHash(world, "http_ratelimit") };
    },
    after: async () => {
      const world = healthyWorld();
      const settings = await settingsFor(world);
      const stale = await rulesetHash([]);
      return {
        world,
        settings: {
          ...settings,
          rulesetHashes: { ...settings.rulesetHashes, http_ratelimit: stale },
        },
      };
    },
    standing: ["rules/http_ratelimit/hash_unset"],
    later: ["rules/http_ratelimit/ruleset_hash_mismatch"],
  },
  {
    name: "an unset Access hash, then a registered one the policy no longer matches",
    before: async () => {
      const world = healthyWorld();
      return { world, settings: { ...(await settingsFor(world)), accessPolicyHash: null } };
    },
    after: async () => {
      const world = healthyWorld();
      const stale = await accessPolicyHash([]);
      return { world, settings: { ...(await settingsFor(world)), accessPolicyHash: stale } };
    },
    standing: ["access/fin-next-staging-admin/hash_unset"],
    later: ["access/fin-next-staging-admin/policy_hash_mismatch"],
  },
  {
    name: "a moved compatibility date, then a binding on the same deployment",
    before: async () => {
      const world = healthyWorld();
      Object.assign(world.scripts.find((s) => s.id === STATIC) ?? {}, {
        compatibility_date: "2026-12-01",
      });
      return { world, settings: await settingsFor(healthyWorld()) };
    },
    after: async () => {
      const world = healthyWorld();
      Object.assign(world.scripts.find((s) => s.id === STATIC) ?? {}, {
        compatibility_date: "2026-12-01",
      });
      world.scriptSettings[STATIC] = { bindings: [{ type: "kv_namespace", name: "X" }] };
      return { world, settings: await settingsFor(healthyWorld()) };
    },
    standing: [`static/${STATIC}/compatibility_date`],
    later: [`static/${STATIC}/has_bindings`],
  },
  {
    name: "a sending domain in preview, then drop-suppressed turned on for it",
    before: async () => {
      const world = healthyWorld();
      Object.assign(world.emailSubdomains[0] ?? {}, { preview_enabled: true });
      return { world, settings: await settingsFor(healthyWorld()) };
    },
    after: async () => {
      const world = healthyWorld();
      Object.assign(world.emailSubdomains[0] ?? {}, {
        preview_enabled: true,
        drop_suppressed_recipients: true,
      });
      return { world, settings: await settingsFor(healthyWorld()) };
    },
    standing: ["email/auth/preview_enabled"],
    later: ["email/auth/drop_suppressed_on"],
  },
];

describe("the watcher's incidents", () => {
  it("has one alert for every failure the checks write", async () => {
    const { world, settings } = await healthy();
    expect(await failuresOf(world, settings)).toEqual([]);
    for (const check of CHECKS) {
      const watching = ALERTS.filter((a) => a.checks.includes(check.name));
      expect(
        watching.map((a) => a.name),
        check.name,
      ).toHaveLength(1);
    }
  });

  for (const c of CASES) {
    it(`opens a new incident for ${c.name}`, async () => {
      const first = await c.before();
      const then = await c.after();
      const before = await failuresOf(first.world, first.settings);
      const after = await failuresOf(then.world, then.settings);
      expect(before.map(key)).toEqual([...c.standing]);
      const later = after.filter((f) => !before.some((b) => key(b) === key(f)));
      expect(later.map(key)).toEqual([...c.later]);
      const open = new Set(before.map(incidentOf));
      for (const f of later) expect(open.has(incidentOf(f)), key(f)).toBe(false);
    });
  }
});
