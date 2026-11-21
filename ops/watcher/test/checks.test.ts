import { describe, expect, it } from "vitest";
import { access } from "../src/checks/access.ts";
import { type Check, type Failure, makeContext, tunnelNameMatches } from "../src/checks/common.ts";
import { email } from "../src/checks/email.ts";
import { routes, staticDeployments } from "../src/checks/front.ts";
import { connectors, dns, tunnelConfig } from "../src/checks/tunnels.ts";
import { matches, rules, zone } from "../src/checks/zone.ts";
import { CloudflareReader } from "../src/cloudflare.ts";
import { CHECKS } from "../src/run.ts";
import {
  ACCOUNT,
  ADMIN_TUNNEL,
  cloudflareFetch,
  HOSTS,
  healthyWorld,
  PUBLIC_TUNNEL,
  settingsFor,
  type World,
  ZONE,
  ZONE_ID,
} from "./world.ts";

async function run(check: Check, world: World, settingsWorld: World = healthyWorld()) {
  const settings = await settingsFor(settingsWorld);
  const ctx = makeContext(
    settings,
    new CloudflareReader("read-only-token", cloudflareFetch(world)),
  );
  return check.run(ctx);
}

const details = (failures: Failure[]) => failures.map((f) => `${f.check}/${f.target}/${f.detail}`);

describe("the healthy front door", () => {
  it("passes every Phase 0 check", async () => {
    const world = healthyWorld();
    for (const check of CHECKS) expect(await run(check, world), check.name).toEqual([]);
  });

  it("runs exactly the Phase 0 checks", () => {
    expect(CHECKS.map((c) => c.name)).toEqual([
      "connectors",
      "tunnel-config",
      "dns",
      "routes",
      "static",
      "rules",
      "zone",
      "access",
      "email",
    ]);
  });
});

describe("connectors", () => {
  it("fails on a connector count other than the replicas", async () => {
    const world = healthyWorld();
    const [first] = world.connections[PUBLIC_TUNNEL] ?? [];
    world.connections[PUBLIC_TUNNEL] = [first ?? {}, first ?? {}];
    expect(details(await run(connectors, world))).toEqual(["connectors/public/count_mismatch"]);
  });

  it("fails on a connector of another version", async () => {
    const world = healthyWorld();
    const client = world.connections[ADMIN_TUNNEL]?.[0] as Record<string, unknown>;
    client.version = "2026.10.0";
    expect(details(await run(connectors, world))).toEqual(["connectors/admin/version_mismatch"]);
  });

  it("fails on a connection from an address outside the tunnel's static egress", async () => {
    const world = healthyWorld();
    const client = world.connections[PUBLIC_TUNNEL]?.[0] as { conns: Record<string, unknown>[] };
    const [conn] = client.conns;
    if (conn !== undefined) conn.origin_ip = ["198", "51", "100", "7"].join(".");
    expect(details(await run(connectors, world))).toEqual(["connectors/public/origin_unexpected"]);
  });

  it("does not accept the admin tunnel's egress for the public tunnel", async () => {
    const world = healthyWorld();
    const client = world.connections[PUBLIC_TUNNEL]?.[0] as { conns: Record<string, unknown>[] };
    for (const conn of client.conns) conn.origin_ip = ["203", "0", "113", "20"].join(".");
    expect(details(await run(connectors, world))).toEqual(["connectors/public/origin_unexpected"]);
  });

  it("accepts the standby service's egress (a blue and green swap)", async () => {
    const world = healthyWorld();
    const client = world.connections[PUBLIC_TUNNEL]?.[0] as { conns: Record<string, unknown>[] };
    for (const conn of client.conns) conn.origin_ip = ["203", "0", "113", "11"].join(".");
    expect(await run(connectors, world)).toEqual([]);
  });

  it("fails when a tunnel is missing, and when two tunnels claim a role", async () => {
    const world = healthyWorld();
    world.tunnels = world.tunnels.filter((t) => t.id !== ADMIN_TUNNEL);
    world.tunnels.push({
      ...world.tunnels[0],
      id: "x",
      name: "fin-next-staging-public-202611211200",
    });
    expect(details(await run(connectors, world))).toEqual([
      "connectors/public/tunnel_duplicate",
      "connectors/admin/tunnel_missing",
    ]);
  });

  it("matches a tunnel by its exact name or its dated replacement only", () => {
    expect(tunnelNameMatches("fin-next-staging-public", "fin-next-staging-public")).toBe(true);
    expect(
      tunnelNameMatches("fin-next-staging-public", "fin-next-staging-public-202611211200"),
    ).toBe(true);
    expect(tunnelNameMatches("fin-next-staging-public", "fin-next-staging-public-b")).toBe(false);
    expect(tunnelNameMatches("fin-next-staging-public", "xfin-next-staging-public")).toBe(false);
  });

  it("fails closed when Cloudflare refuses the read", async () => {
    const world = healthyWorld();
    world.failures[`/accounts/${ACCOUNT}/cfd_tunnel/${PUBLIC_TUNNEL}/connections`] = 403;
    await expect(run(connectors, world)).rejects.toThrow(/403/);
  });
});

describe("tunnel-config", () => {
  it("fails on a remotely managed tunnel", async () => {
    const world = healthyWorld();
    Object.assign(world.tunnels[0] ?? {}, { remote_config: true, config_src: "cloudflare" });
    expect(details(await run(tunnelConfig, world))).toEqual([
      "tunnel-config/public/remote_config",
      "tunnel-config/public/config_src_not_local",
    ]);
  });
});

describe("dns", () => {
  it("fails on a record pointing at another tunnel, unproxied, or missing", async () => {
    const world = healthyWorld();
    const record = (role: string) =>
      world.dns.find((r) => r.name === HOSTS[role as keyof typeof HOSTS]);
    Object.assign(record("console") ?? {}, { content: `${ADMIN_TUNNEL}.cfargotunnel.com` });
    Object.assign(record("verify") ?? {}, { proxied: false });
    world.dns = world.dns.filter((r) => r.name !== HOSTS.docs);
    expect(details(await run(dns, world))).toEqual([
      "dns/console/record_wrong_tunnel",
      "dns/verify/record_not_proxied",
      "dns/docs/record_missing",
    ]);
  });

  it("fails on an A record or a second record for a host", async () => {
    const world = healthyWorld();
    world.dns.push({
      id: "dup",
      type: "A",
      name: HOSTS.admin,
      content: "192.0.2.1",
      proxied: true,
    });
    expect(details(await run(dns, world))).toEqual([
      "dns/admin/record_duplicate",
      "dns/admin/record_not_cname",
      "dns/admin/record_wrong_tunnel",
    ]);
  });
});

describe("routes", () => {
  it("fails on a Worker attached to an /api/* route", async () => {
    const world = healthyWorld();
    const route = world.routes.find((r) => r.pattern === `${HOSTS.console}/api/*`);
    if (route !== undefined) route.script = "something";
    expect(details(await run(routes, world))).toEqual(["routes/console/api/*/route_wrong_script"]);
  });

  it("fails on a missing route and an extra route, naming roles not hosts", async () => {
    const world = healthyWorld();
    world.routes = world.routes.filter((r) => r.pattern !== `${HOSTS.selfie}/api/*`);
    world.routes.push({ id: "extra", pattern: `${HOSTS.admin}/api*`, script: "x" });
    world.routes.push({ id: "other", pattern: `elsewhere.${ZONE}/*` });
    expect(details(await run(routes, world))).toEqual([
      "routes/selfie/api/*/route_missing",
      "routes/admin/route_unexpected",
      "routes/other/route_unexpected",
    ]);
  });

  it("fails when a static route loses its deployment", async () => {
    const world = healthyWorld();
    const route = world.routes.find((r) => r.pattern === `${HOSTS.docs}/*`);
    if (route !== undefined) delete route.script;
    expect(details(await run(routes, world))).toEqual(["routes/docs/*/route_wrong_script"]);
  });
});

describe("static", () => {
  it("fails on a deployment that gained a module, a binding, a schedule and workers.dev", async () => {
    const world = healthyWorld();
    const name = "fin-next-staging-console-static";
    Object.assign(world.scripts.find((s) => s.id === name) ?? {}, {
      has_modules: true,
      handlers: ["fetch"],
    });
    world.scriptSettings[name] = { bindings: [{ type: "kv_namespace", name: "X" }] };
    world.schedules[name] = { schedules: [{ cron: "* * * * *" }] };
    world.subdomains[name] = { enabled: true, previews_enabled: true };
    world.domains.push({ id: "d", hostname: `x.${ZONE}`, service: name });
    expect(details(await run(staticDeployments, world))).toEqual([
      `static/${name}/has_modules`,
      `static/${name}/has_handlers`,
      `static/${name}/has_bindings`,
      `static/${name}/workers_dev_on`,
      `static/${name}/previews_on`,
      `static/${name}/has_schedules`,
      `static/${name}/has_custom_domain`,
    ]);
  });

  it("fails on a missing deployment and on any other script in the account", async () => {
    const world = healthyWorld();
    world.scripts = world.scripts.filter((s) => s.id !== "fin-next-staging-selfie-static");
    world.scripts.push({ id: "surprise", has_modules: true });
    expect(details(await run(staticDeployments, world))).toEqual([
      "static/fin-next-staging-selfie-static/deployment_missing",
      "static/other/unexpected_script",
    ]);
  });

  it("fails on a moved compatibility date", async () => {
    const world = healthyWorld();
    Object.assign(world.scripts[0] ?? {}, { compatibility_date: "2026-12-01" });
    expect(details(await run(staticDeployments, world))).toEqual([
      "static/fin-next-staging-console-static/compatibility_date",
    ]);
  });
});

describe("zone", () => {
  it("fails on each setting that moved, and on Universal SSL and Bot Fight Mode", async () => {
    const world = healthyWorld();
    for (const s of world.zoneSettings) {
      if (s.id === "0rtt") s.value = "on";
      if (s.id === "security_header") s.value = { strict_transport_security: { enabled: true } };
    }
    world.zoneSettings = world.zoneSettings.filter((s) => s.id !== "polish");
    world.universal = { enabled: false };
    world.bots = { fight_mode: true };
    expect(details(await run(zone, world))).toEqual([
      "zone/0rtt/setting_mismatch",
      "zone/polish/setting_missing",
      "zone/security_header/setting_mismatch",
      "zone/universal_ssl/universal_ssl_off",
      "zone/bot_fight_mode/bot_fight_on",
    ]);
  });

  it("compares nested settings as a subset", () => {
    expect(matches({ a: { b: false } }, { a: { b: false, c: 1 } })).toBe(true);
    expect(matches({ a: { b: false } }, { a: { b: true } })).toBe(false);
    expect(matches("on", "off")).toBe(false);
  });
});

describe("rules", () => {
  it("fails when a rule set changed outside a registered run", async () => {
    const world = healthyWorld();
    const settingsWorld = healthyWorld();
    const [rule] = world.entrypoints.http_request_late_transform ?? [];
    if (rule !== undefined) rule.expression = "true";
    expect(details(await run(rules, world, settingsWorld))).toEqual([
      "rules/http_request_late_transform/ruleset_hash_mismatch",
    ]);
  });

  it("ignores IDs, versions and timestamps", async () => {
    const world = healthyWorld();
    const [rule] = world.entrypoints.http_ratelimit ?? [];
    if (rule !== undefined)
      Object.assign(rule, { id: "new", version: "9", last_updated: "2027-01-01" });
    expect(await run(rules, world)).toEqual([]);
  });

  it("fails when an entrypoint disappears, or a phase nobody registered appears", async () => {
    const world = healthyWorld();
    world.entrypoints.http_config_settings = undefined;
    world.rulesets.push({ id: "rs-x", kind: "zone", phase: "http_request_origin" });
    expect(details(await run(rules, world))).toEqual([
      "rules/http_config_settings/ruleset_hash_mismatch",
      "rules/http_request_origin/ruleset_unexpected",
    ]);
  });
});

describe("access", () => {
  it("fails on MFA off, a weakened cookie and a policy change", async () => {
    const world = healthyWorld();
    const app = world.accessApps[0] as Record<string, unknown> & {
      policies: Record<string, unknown>[];
    };
    app.mfa_config = { mfa_disabled: true };
    app.enable_binding_cookie = false;
    app.same_site_cookie_attribute = "none";
    app.policies[0] = { ...app.policies[0], include: [{ everyone: {} }] };
    expect(details(await run(access, world))).toEqual([
      "access/fin-next-staging-admin/binding_cookie",
      "access/fin-next-staging-admin/same_site",
      "access/fin-next-staging-admin/mfa_not_required",
      "access/fin-next-staging-admin/policy_everyone",
      "access/fin-next-staging-admin/policy_hash_mismatch",
    ]);
  });

  it("fails when the application is gone or moved to another host", async () => {
    const world = healthyWorld();
    Object.assign(world.accessApps[0] ?? {}, { domain: HOSTS.console });
    expect(details(await run(access, world))).toEqual(["access/fin-next-staging-admin/app_domain"]);
    world.accessApps = [];
    expect(details(await run(access, world))).toEqual([
      "access/fin-next-staging-admin/app_missing",
    ]);
  });
});

describe("email", () => {
  it("fails on preview or drop-suppressed on, a missing domain and a missing _dmarc", async () => {
    const world = healthyWorld();
    Object.assign(world.emailSubdomains[0] ?? {}, { preview_enabled: true });
    Object.assign(world.emailSubdomains[0] ?? {}, { drop_suppressed_recipients: true });
    world.emailSubdomains = world.emailSubdomains.slice(0, 1);
    world.dns = world.dns.filter((r) => r.type !== "TXT");
    expect(details(await run(email, world))).toEqual([
      "email/auth/preview_enabled",
      "email/auth/drop_suppressed_on",
      "email/notify/subdomain_missing",
      "email/dmarc/dmarc_missing",
    ]);
  });
});

describe("the zone lookup", () => {
  it("resolves the zone by name once per run", async () => {
    const world = healthyWorld();
    const recorded: { url: string }[] = [];
    const fetch = cloudflareFetch(world, recorded as never);
    const ctx = makeContext(await settingsFor(world), new CloudflareReader("t", fetch));
    await Promise.all([dns.run(ctx), routes.run(ctx), zone.run(ctx)]);
    expect(await ctx.zoneId()).toBe(ZONE_ID);
    expect(recorded.filter((r) => new URL(r.url).pathname.endsWith("/zones")).length).toBe(1);
  });
});
