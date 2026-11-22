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
  FIN_PHASES,
  HOSTS,
  healthyWorld,
  OLD_HOST,
  OLD_SCRIPT,
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

type Json = Record<string, unknown>;
const STATIC = "fin-next-staging-console-static";
const ADMIN_STATIC = "fin-next-staging-admin-static";

describe("the healthy front door", () => {
  it("passes every Phase 0 check, with the old product's objects beside fin-next's", async () => {
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

  it("fails on a missing route and an extra route on fin-next's hosts, naming roles not hosts", async () => {
    const world = healthyWorld();
    world.routes = world.routes.filter((r) => r.pattern !== `${HOSTS.selfie}/api/*`);
    world.routes.push({ id: "extra", pattern: `${HOSTS.admin}/api*`, script: "x" });
    world.routes.push({ id: "extra-api", pattern: `${HOSTS.api}/v4/*`, script: "x" });
    expect(details(await run(routes, world))).toEqual([
      "routes/selfie/api/*/route_missing",
      "routes/admin/route_unexpected",
      "routes/api/route_unexpected",
    ]);
  });

  it("leaves the old product's routes on its own hosts alone", async () => {
    const world = healthyWorld();
    world.routes.push({ id: "old-2", pattern: `${OLD_HOST}/api/*`, script: OLD_SCRIPT });
    world.routes.push({ id: "old-3", pattern: `elsewhere.${ZONE}/*` });
    expect(await run(routes, world)).toEqual([]);
  });

  it("fails on a wildcard route that reaches fin-next's hosts, once per host it reaches", async () => {
    const world = healthyWorld();
    world.routes.push({ id: "wild", pattern: `*.${ZONE}/*`, script: OLD_SCRIPT });
    expect(details(await run(routes, world))).toEqual(
      ["console", "admin", "verify", "selfie", "docs", "api"].map(
        (role) => `routes/${role}/route_unexpected`,
      ),
    );
    const narrow = healthyWorld();
    narrow.routes.push({ id: "wild-admin", pattern: `*${HOSTS.admin}/*`, script: OLD_SCRIPT });
    expect(details(await run(routes, narrow))).toEqual(["routes/admin/route_unexpected"]);
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
    Object.assign(world.scripts.find((s) => s.id === STATIC) ?? {}, {
      has_modules: true,
      handlers: ["fetch"],
    });
    world.scriptSettings[STATIC] = { bindings: [{ type: "kv_namespace", name: "X" }] };
    world.schedules[STATIC] = { schedules: [{ cron: "* * * * *" }] };
    world.subdomains[STATIC] = { enabled: true, previews_enabled: true };
    world.domains.push({ id: "d", hostname: `x.${ZONE}`, service: STATIC });
    expect(details(await run(staticDeployments, world))).toEqual([
      `static/${STATIC}/has_modules`,
      `static/${STATIC}/has_handlers`,
      `static/${STATIC}/has_bindings`,
      `static/${STATIC}/workers_dev_on`,
      `static/${STATIC}/previews_on`,
      `static/${STATIC}/has_schedules`,
      `static/${STATIC}/has_custom_domain`,
    ]);
  });

  it("fails on a missing deployment and on another fin-next script, by its name", async () => {
    const world = healthyWorld();
    world.scripts = world.scripts.filter((s) => s.id !== "fin-next-staging-selfie-static");
    world.scripts.push({ id: `${STATIC}-v2`, has_modules: true, handlers: ["fetch"] });
    world.scripts.push({ id: "fin-next-staging-surprise", has_modules: true });
    expect(details(await run(staticDeployments, world))).toEqual([
      "static/fin-next-staging-selfie-static/deployment_missing",
      `static/${STATIC}-v2/unexpected_script`,
      "static/fin-next-staging-surprise/unexpected_script",
    ]);
  });

  it("leaves the old product's own Workers in the shared account alone", async () => {
    const world = healthyWorld();
    world.scripts.push({ id: "old-product-cron", has_modules: true, handlers: ["scheduled"] });
    expect(await run(staticDeployments, world)).toEqual([]);
  });

  it("fails on any Worker's custom domain on one of fin-next's hosts", async () => {
    const world = healthyWorld();
    world.domains.push({ id: "d-1", hostname: HOSTS.admin, service: OLD_SCRIPT });
    world.domains.push({ id: "d-2", hostname: `x.${HOSTS.console}`, service: OLD_SCRIPT });
    expect(details(await run(staticDeployments, world))).toEqual([
      "static/admin/custom_domain_on_host",
      "static/console/custom_domain_on_host",
    ]);
  });

  it("fails when a deployment's active version is not the registered one (a re-upload)", async () => {
    const world = healthyWorld();
    const settingsWorld = healthyWorld();
    const current = world.deployments[ADMIN_STATIC] as { deployments: Json[] };
    current.deployments.unshift({
      id: "dep-new",
      source: "api",
      strategy: "percentage",
      versions: [{ version_id: "ver-unregistered", percentage: 100 }],
    });
    expect(details(await run(staticDeployments, world, settingsWorld))).toEqual([
      `static/${ADMIN_STATIC}/version/version_changed`,
    ]);
  });

  it("fails on a split deployment, a deployment with no version, and an unregistered one", async () => {
    const world = healthyWorld();
    const settingsWorld = healthyWorld();
    const split = world.deployments[STATIC] as { deployments: Json[] };
    const [active] = split.deployments;
    if (active !== undefined) {
      active.versions = [
        { version_id: `ver-${STATIC}-2`, percentage: 90 },
        { version_id: "ver-other", percentage: 10 },
      ];
    }
    world.deployments["fin-next-staging-docs-static"] = { deployments: [] };
    delete settingsWorld.deployments["fin-next-staging-verify-static"];
    expect(details(await run(staticDeployments, world, settingsWorld))).toEqual([
      `static/${STATIC}/version/version_split`,
      "static/fin-next-staging-verify-static/version/version_unset",
      "static/fin-next-staging-docs-static/version/version_unknown",
    ]);
  });

  it("fails on a moved compatibility date", async () => {
    const world = healthyWorld();
    Object.assign(world.scripts[0] ?? {}, { compatibility_date: "2026-12-01" });
    expect(details(await run(staticDeployments, world))).toEqual([
      `static/${STATIC}/compatibility_date`,
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
  const ruleOf = (world: World, phase: string, ref: string) =>
    (world.entrypoints[phase] ?? []).find((r) => r.ref === ref) as Json;

  it("hashes every phase fin-next writes, the response header and managed phases included", async () => {
    const settings = await settingsFor(healthyWorld());
    expect(settings.rulesetPhases).toEqual([...FIN_PHASES]);
  });

  it("fails when one of fin-next's rules changed outside a registered run", async () => {
    const world = healthyWorld();
    ruleOf(
      world,
      "http_request_late_transform",
      "fin_next_http_request_late_transform",
    ).expression = "true";
    expect(details(await run(rules, world))).toEqual([
      "rules/http_request_late_transform/ruleset_hash_mismatch",
    ]);
  });

  it("fails when BD-12's response header rule is edited or disabled", async () => {
    const world = healthyWorld();
    const rule = ruleOf(
      world,
      "http_response_headers_transform",
      "fin_next_http_response_headers_transform",
    );
    rule.enabled = false;
    expect(details(await run(rules, world))).toEqual([
      "rules/http_response_headers_transform/ruleset_hash_mismatch",
    ]);
  });

  it("fails when the managed ruleset's execute rule is removed", async () => {
    const world = healthyWorld();
    world.entrypoints.http_request_firewall_managed = [];
    expect(details(await run(rules, world))).toEqual([
      "rules/http_request_firewall_managed/ruleset_hash_mismatch",
    ]);
  });

  it("ignores the old product's rules in a shared phase, before or after fin-next's", async () => {
    const world = healthyWorld();
    const old = ruleOf(world, "http_request_dynamic_redirect", "legacy_redirect");
    old.expression = `(http.host eq "renamed.${ZONE}")`;
    world.entrypoints.http_request_dynamic_redirect?.push({
      id: "rule-legacy-2",
      ref: "legacy_redirect_2",
      expression: `(http.host eq "${OLD_HOST}")`,
      action: "redirect",
    });
    expect(await run(rules, world)).toEqual([]);
  });

  it("fails on a rule of another product that names one of fin-next's hosts", async () => {
    const world = healthyWorld();
    world.entrypoints.http_request_firewall_custom?.unshift({
      id: "rule-skip",
      ref: "skip_everything",
      expression: `(http.host eq "${HOSTS.admin}")`,
      action: "skip",
    });
    expect(details(await run(rules, world))).toEqual([
      "rules/http_request_firewall_custom/foreign_rule",
    ]);
  });

  it("fails when a rule moves its ref out of fin_next_ (it leaves the hash)", async () => {
    const world = healthyWorld();
    ruleOf(world, "http_ratelimit", "fin_next_http_ratelimit").ref = "renamed";
    expect(details(await run(rules, world))).toEqual([
      "rules/http_ratelimit/ruleset_hash_mismatch",
      "rules/http_ratelimit/foreign_rule",
    ]);
  });

  it("ignores IDs, versions and timestamps", async () => {
    const world = healthyWorld();
    const [rule] = world.entrypoints.http_ratelimit ?? [];
    if (rule !== undefined)
      Object.assign(rule, { id: "new", version: "9", last_updated: "2027-01-01" });
    expect(await run(rules, world)).toEqual([]);
  });

  it("fails when an entrypoint disappears, or a fin_next_ rule appears in a phase nobody registered", async () => {
    const world = healthyWorld();
    world.entrypoints.http_config_settings = undefined;
    world.rulesets.push({ id: "rs-x", kind: "zone", phase: "http_request_origin" });
    world.otherRulesets["rs-x"] = [{ id: "r", ref: "fin_next_origin", expression: "true" }];
    expect(details(await run(rules, world))).toEqual([
      "rules/http_config_settings/ruleset_hash_mismatch",
      "rules/http_request_origin/ruleset_unexpected",
    ]);
  });

  it("fails as hash_unset for a phase no registered run hashed", async () => {
    const world = healthyWorld();
    const settingsWorld = healthyWorld();
    delete settingsWorld.entrypoints.http_request_firewall_managed;
    expect(details(await run(rules, world, settingsWorld))).toEqual([
      "rules/http_request_firewall_managed/hash_unset",
    ]);
  });
});

describe("access", () => {
  it("fails on MFA off, a weakened cookie and a policy change", async () => {
    const world = healthyWorld();
    const app = world.accessApps.find((a) => a.name === "fin-next-staging-admin") as Json & {
      policies: Json[];
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
    const app = world.accessApps.find((a) => a.name === "fin-next-staging-admin") ?? {};
    Object.assign(app, { domain: HOSTS.console, self_hosted_domains: [HOSTS.console] });
    expect(details(await run(access, world))).toEqual(["access/fin-next-staging-admin/app_domain"]);
    world.accessApps = world.accessApps.filter((a) => a !== app);
    expect(details(await run(access, world))).toEqual([
      "access/fin-next-staging-admin/app_missing",
    ]);
  });

  it("fails on another application that covers the admin host or a path under it", async () => {
    const bypass = [{ id: "p", name: "open", decision: "bypass", include: [{ everyone: {} }] }];
    const cases: Json[] = [
      {
        name: "something-else",
        type: "self_hosted",
        domain: `${HOSTS.admin}/api`,
        policies: bypass,
      },
      { name: "assets", type: "self_hosted", self_hosted_domains: [`${HOSTS.admin}/assets`] },
      { name: "wild", type: "self_hosted", domain: `*.${ZONE}` },
      {
        name: "dest",
        type: "self_hosted",
        destinations: [{ type: "public", uri: `https://${HOSTS.admin}/x` }],
      },
    ];
    for (const extra of cases) {
      const world = healthyWorld();
      world.accessApps.push({ id: `app-${String(extra.name)}`, ...extra });
      expect(details(await run(access, world)), String(extra.name)).toEqual([
        "access/admin/app_overlap",
      ]);
    }
  });

  it("leaves applications on other hosts and bookmarks alone, and fails on a duplicate name", async () => {
    const world = healthyWorld();
    world.accessApps.push({ id: "app-c", name: "c", type: "self_hosted", domain: HOSTS.console });
    world.accessApps.push({ id: "app-b", name: "b", type: "bookmark", domain: HOSTS.admin });
    expect(await run(access, world)).toEqual([]);
    const original = world.accessApps.find((a) => a.name === "fin-next-staging-admin") ?? {};
    world.accessApps.push({ ...original, id: "app-dup" });
    expect(details(await run(access, world))).toEqual([
      "access/fin-next-staging-admin/app_duplicate",
    ]);
  });
});

describe("email", () => {
  const dmarc = (world: World, label: string) =>
    world.dns.find((r) => r.name === `_dmarc.${label}.${ZONE}`) as Json;

  it("fails on preview or drop-suppressed on and a missing domain", async () => {
    const world = healthyWorld();
    Object.assign(world.emailSubdomains[0] ?? {}, { preview_enabled: true });
    Object.assign(world.emailSubdomains[0] ?? {}, { drop_suppressed_recipients: true });
    world.emailSubdomains = world.emailSubdomains.slice(0, 1);
    expect(details(await run(email, world))).toEqual([
      "email/auth/preview_enabled",
      "email/auth/drop_suppressed_on",
      "email/notify/subdomain_missing",
    ]);
  });

  it("reads both sending subdomains' DMARC records and never the zone's apex record", async () => {
    const world = healthyWorld();
    const recorded: { url: string }[] = [];
    const ctx = makeContext(
      await settingsFor(world),
      new CloudflareReader("t", cloudflareFetch(world, recorded as never)),
    );
    expect(await email.run(ctx)).toEqual([]);
    const names = recorded
      .filter((r) => new URL(r.url).pathname.endsWith("/dns_records"))
      .map((r) => new URL(r.url).searchParams.get("name"));
    expect(names).toEqual([`_dmarc.auth.${ZONE}`, `_dmarc.notify.${ZONE}`]);
    world.dns = world.dns.filter((r) => r.name !== `_dmarc.${ZONE}`);
    expect(await run(email, world)).toEqual([]);
  });

  it("fails on a deleted DMARC record and one lowered to p=none", async () => {
    const world = healthyWorld();
    world.dns = world.dns.filter((r) => r !== dmarc(world, "auth"));
    dmarc(world, "notify").content = '"v=DMARC1; p=none"';
    expect(details(await run(email, world))).toEqual([
      "email/_dmarc.auth/dmarc_missing",
      "email/_dmarc.notify/dmarc_weak",
    ]);
  });

  it("fails on a second record, a partial pct, a weak subdomain policy, or no DMARC tag", async () => {
    const cases: [string, (w: World) => void, string][] = [
      [
        "a second record",
        (w) => w.dns.push({ ...dmarc(w, "auth"), id: "dup", content: '"v=DMARC1; p=none"' }),
        "email/_dmarc.auth/dmarc_duplicate",
      ],
      [
        "pct",
        (w) => {
          dmarc(w, "auth").content = '"v=DMARC1; p=reject; pct=10"';
        },
        "email/_dmarc.auth/dmarc_weak",
      ],
      [
        "sp",
        (w) => {
          dmarc(w, "auth").content = '"v=DMARC1; p=reject; sp=none"';
        },
        "email/_dmarc.auth/dmarc_weak",
      ],
      [
        "not DMARC",
        (w) => {
          dmarc(w, "auth").content = '"v=spf1 -all"';
        },
        "email/_dmarc.auth/dmarc_invalid",
      ],
    ];
    for (const [what, change, expected] of cases) {
      const world = healthyWorld();
      change(world);
      expect(details(await run(email, world)), what).toEqual([expected]);
    }
  });

  it("fails on any second TXT record beside a valid one, one that receivers may read as DMARC above all", async () => {
    // Receivers differ on what they read as a DMARC record (some trim white space or a byte-order
    // mark, some ignore case, some read past the quoted strings), and one that reads two applies
    // no policy at all (RFC 7489 §6.6.3). The name is fin-next's own, so any second record fails.
    const nbsp = " ";
    const bom = "﻿";
    for (const content of [
      '" v=DMARC1; p=none"',
      '"\tv=DMARC1; p=none"',
      `"${bom}v=DMARC1; p=none"`,
      `"${nbsp}v=DMARC1; p=none"`,
      `"v=DMARC1${nbsp}; p=none"`,
      '"v=DMARC1\n; p=none"',
      '"v=dmarc1; p=none"',
      '"V = dmarc1"',
      '"\\032v=DMARC1; p=none"',
      '"v=DMARC1; p=none" x',
      `${bom}v=DMARC1; p=none`,
      " v=DMARC1; p=none",
      '"v=spf1 -all"',
      '"a verification token"',
    ]) {
      const world = healthyWorld();
      world.dns.push({ ...dmarc(world, "auth"), id: "second", content });
      expect(details(await run(email, world)), JSON.stringify(content)).toEqual([
        "email/_dmarc.auth/dmarc_duplicate",
      ]);
    }
  });

  it("still judges the valid record beside a second one, so a doubled name never hides a weaker policy", async () => {
    const world = healthyWorld();
    dmarc(world, "auth").content = '"v=DMARC1; p=none"';
    world.dns.push({ ...dmarc(world, "auth"), id: "second", content: '"v=spf1 -all"' });
    expect(details(await run(email, world))).toEqual([
      "email/_dmarc.auth/dmarc_duplicate",
      "email/_dmarc.auth/dmarc_weak",
    ]);
    // Two records neither of which is valid: doubled, and no valid record to judge.
    const twice = healthyWorld();
    dmarc(twice, "auth").content = '" v=DMARC1; p=reject"';
    twice.dns.push({ ...dmarc(twice, "auth"), id: "second", content: '"v=spf1 -all"' });
    expect(details(await run(email, twice))).toEqual([
      "email/_dmarc.auth/dmarc_duplicate",
      "email/_dmarc.auth/dmarc_invalid",
    ]);
  });

  it("accepts a record split into quoted strings, and tags in any case", async () => {
    const world = healthyWorld();
    dmarc(world, "auth").content = '"v=DMARC1; " "P=Reject; rua=mailto:dmarc@example.com"';
    expect(await run(email, world)).toEqual([]);
  });

  it("fails on a record that repeats a tag, whichever value comes last (RFC 6376 §3.2)", async () => {
    for (const content of [
      "v=DMARC1; p=none; p=reject",
      "v=DMARC1; p=none; rua=mailto:dmarc@example.org; p=reject",
      "v=DMARC1; p=reject; pct=0; pct=100",
      "v=DMARC1; p=reject; sp=none; sp=reject",
      "v=DMARC1; p=reject; P=reject",
    ]) {
      const world = healthyWorld();
      dmarc(world, "auth").content = `"${content}"`;
      expect(details(await run(email, world)), content).toEqual([
        "email/_dmarc.auth/dmarc_invalid",
      ]);
    }
  });

  it("fails on a record whose p is not the tag right after v, or whose tags are malformed", async () => {
    for (const content of [
      "v=DMARC1; rua=mailto:dmarc@example.org; p=reject",
      "v=DMARC1; p=reject; junk",
      "v=DMARC1;; p=reject",
      "v=DMARC1; p=reject; 1x=y",
    ]) {
      const world = healthyWorld();
      dmarc(world, "auth").content = `"${content}"`;
      expect(details(await run(email, world)), content).toEqual([
        "email/_dmarc.auth/dmarc_invalid",
      ]);
    }
  });

  it("fails on a record with white space or a character DMARC's grammar does not allow", async () => {
    // RFC 7489 allows only space and tab as white space; receivers read anything else as part of
    // a tag (` p` is unknown, `reject ` is no policy) or discard the record.
    const nbsp = " ";
    const bom = "﻿";
    for (const content of [
      `"v=DMARC1;${nbsp}p=reject"`,
      `"v=DMARC1; p=reject${nbsp}"`,
      `"${bom}v=DMARC1; p=reject"`,
      `"v=DMARC1;　p=reject"`,
      `"v=DMARC1;\u000bp=reject"`,
      `"v=DMARC1;\u000cp=reject"`,
      `"v=DMARC1; p=reject"`,
      `"v${nbsp}=DMARC1; p=reject"`,
      `"v=DMARC1; p=reject; rua=mailto:dmarc@example.org${nbsp}"`,
      // The same characters as the zone file writes them, and in a record that is not quoted.
      '"v=DMARC1;\\194\\160p=reject"',
      `${bom}v=DMARC1; p=reject`,
      `v=DMARC1;${nbsp}p=reject`,
      // Text outside the quoted strings, which the record also holds.
      '"v=DMARC1; p=reject" ;p=none',
      '" v=DMARC1; p=reject"',
    ]) {
      const world = healthyWorld();
      dmarc(world, "auth").content = content;
      expect(details(await run(email, world)), JSON.stringify(content)).toEqual([
        "email/_dmarc.auth/dmarc_invalid",
      ]);
    }
  });

  it("accepts space and tab around the separators, and escapes that spell them", async () => {
    for (const content of [
      '"v=DMARC1;\tp=reject"',
      '"v = DMARC1 ;  p = reject ; adkim=s"',
      '"v=DMARC1;\\032p=reject"',
      "v=DMARC1; p=reject",
    ]) {
      const world = healthyWorld();
      dmarc(world, "auth").content = content;
      expect(await run(email, world), JSON.stringify(content)).toEqual([]);
    }
  });

  it("fails on RFC 9989's test mode or a weaker policy for subdomains that do not exist", async () => {
    for (const content of [
      "v=DMARC1; p=reject; t=y",
      "v=DMARC1; p=reject; t=Y",
      "v=DMARC1; p=reject; t=",
      "v=DMARC1; p=reject; np=none",
      "v=DMARC1; p=reject; np=quarantine",
      "v=DMARC1; p=reject; sp=reject; np=none; t=y",
    ]) {
      const world = healthyWorld();
      dmarc(world, "auth").content = `"${content}"`;
      expect(details(await run(email, world)), content).toEqual(["email/_dmarc.auth/dmarc_weak"]);
    }
    const world = healthyWorld();
    dmarc(world, "auth").content = '"v=DMARC1; p=reject; sp=reject; np=Reject; t=n"';
    expect(await run(email, world)).toEqual([]);
  });

  it("accepts a trailing separator, and reports a record with no p as weak", async () => {
    const world = healthyWorld();
    dmarc(world, "auth").content = '"v=DMARC1; p=reject; adkim=s;"';
    expect(await run(email, world)).toEqual([]);
    dmarc(world, "auth").content = '"v=DMARC1; rua=mailto:dmarc@example.org"';
    expect(details(await run(email, world))).toEqual(["email/_dmarc.auth/dmarc_weak"]);
  });
});

describe("the zone lookup", () => {
  it("reads only this account's zone, and fails closed when two zones of the name are this account's", async () => {
    const world = healthyWorld();
    world.otherZones.push({ id: "ef".repeat(16), name: ZONE, account: { id: "12".repeat(16) } });
    expect(await run(zone, world)).toEqual([]);
    world.otherZones.push({ id: "aa".repeat(16), name: ZONE, account: { id: ACCOUNT } });
    await expect(run(zone, world)).rejects.toThrow(/zone ambiguous/);
  });

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
