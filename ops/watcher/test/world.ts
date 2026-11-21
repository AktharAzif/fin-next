// A healthy staging front door as Cloudflare's API returns it (the shapes recorded from the API
// reference: { success, errors, result, result_info }), and a fetch that serves it. Each test
// changes one thing and expects exactly the matching failure. IDs and addresses are built at run
// time (documentation ranges, example.net), so no ID-shaped literal is committed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accessPolicyHash, rulesetHash } from "../src/hash.ts";
import { HOST_ROLES, parseSettings, type WatcherSettings } from "../src/settings.ts";

export const ACCOUNT = "ab".repeat(16);
export const ZONE_ID = "cd".repeat(16);
export const ZONE = "example.net";
const uuid = (last: string) =>
  ["1a2b3c4d", "0000", "4000", "8000", last.padStart(12, "0")].join("-");
export const PUBLIC_TUNNEL = uuid("1");
export const ADMIN_TUNNEL = uuid("2");
const net = (n: number) => ["203", "0", "113", String(n)].join(".");
export const EGRESS = {
  "cloudflared-public": [net(10)],
  "cloudflared-public-b": [net(11)],
  "cloudflared-admin": [net(20)],
  "cloudflared-admin-b": [net(21)],
};
export const HOSTS = Object.fromEntries(HOST_ROLES.map((r) => [r, `${r}-host.${ZONE}`])) as Record<
  (typeof HOST_ROLES)[number],
  string
>;

export const PUBLIC_SETTINGS = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "settings", "staging.json"), "utf8"),
) as Record<string, unknown>;

type Json = Record<string, unknown>;

export interface World {
  tunnels: Json[];
  connections: Record<string, Json[]>;
  dns: Json[];
  routes: Json[];
  scripts: Json[];
  scriptSettings: Record<string, Json>;
  subdomains: Record<string, Json>;
  schedules: Record<string, Json>;
  domains: Json[];
  zoneSettings: Json[];
  universal: Json;
  bots: Json;
  rulesets: Json[];
  entrypoints: Record<string, Json[] | undefined>;
  accessApps: Json[];
  emailSubdomains: Json[];
  /** Paths that answer with this status instead (to test failing closed). */
  failures: Record<string, number>;
}

const connector = (version: string, origin: string): Json => ({
  id: "client-1",
  arch: "linux_amd64",
  version,
  run_at: "2026-11-21T10:00:00Z",
  conns: [0, 1, 2, 3].map((i) => ({
    colo_name: `col${i}`,
    is_pending_reconnect: false,
    opened_at: "2026-11-21T10:00:00Z",
    origin_ip: origin,
    client_version: version,
  })),
});

export function healthyWorld(): World {
  const settings = PUBLIC_SETTINGS as {
    static: { name: string; host: string }[];
    routes: { host: keyof typeof HOSTS; path: string; script: string | null }[];
    rulesetPhases: string[];
  };
  const tunnelOf = (role: string) => (role === "admin" ? ADMIN_TUNNEL : PUBLIC_TUNNEL);
  const staticScripts = settings.static.map((s) => ({
    id: s.name,
    has_assets: true,
    has_modules: false,
    handlers: [],
    named_handlers: [],
    compatibility_date: "2026-11-20",
    tail_consumers: [],
  }));
  const perScript = <T>(make: () => T) =>
    Object.fromEntries(settings.static.map((s) => [s.name, make()])) as Record<string, T>;
  return {
    tunnels: [
      {
        id: PUBLIC_TUNNEL,
        name: "fin-next-staging-public",
        config_src: "local",
        remote_config: false,
        status: "healthy",
      },
      {
        id: ADMIN_TUNNEL,
        name: "fin-next-staging-admin",
        config_src: "local",
        remote_config: false,
        status: "healthy",
      },
    ],
    connections: {
      [PUBLIC_TUNNEL]: [connector("2026.11.1", net(10))],
      [ADMIN_TUNNEL]: [connector("2026.11.1", net(20))],
    },
    dns: HOST_ROLES.map((role) => ({
      id: `rec-${role}`,
      type: "CNAME",
      name: HOSTS[role],
      content: `${tunnelOf(role)}.cfargotunnel.com`,
      proxied: true,
    })).concat([
      {
        id: "rec-dmarc",
        type: "TXT",
        name: `_dmarc.${ZONE}`,
        content: '"v=DMARC1; p=none"',
        proxied: false,
      },
    ]),
    routes: settings.routes.map((r, i) => ({
      id: `route-${i}`,
      pattern: `${HOSTS[r.host]}${r.path}`,
      ...(r.script === null ? {} : { script: r.script }),
    })),
    scripts: [
      ...staticScripts,
      {
        id: "fin-next-staging-watcher",
        has_assets: false,
        has_modules: true,
        handlers: ["scheduled"],
      },
    ],
    scriptSettings: perScript(() => ({ bindings: [], compatibility_date: "2026-11-20" })),
    subdomains: perScript(() => ({ enabled: false, previews_enabled: false })),
    schedules: perScript(() => ({ schedules: [] })),
    domains: [],
    zoneSettings: [
      ["min_tls_version", "1.2"],
      ["tls_1_3", "on"],
      ["0rtt", "off"],
      ["always_use_https", "off"],
      ["ip_geolocation", "on"],
      ["rocket_loader", "off"],
      ["email_obfuscation", "off"],
      ["automatic_https_rewrites", "off"],
      ["polish", "off"],
      ["mirage", "off"],
      ["hotlink_protection", "off"],
      ["security_header", { strict_transport_security: { enabled: false, max_age: 0 } }],
      ["ssl", "strict"],
    ].map(([id, value]) => ({ id, value, editable: true })),
    universal: { enabled: true },
    bots: { fight_mode: false, enable_js: false },
    rulesets: settings.rulesetPhases
      .map((phase, i) => ({ id: `rs-${i}`, kind: "zone", phase, name: "default", version: "3" }))
      .concat([
        {
          id: "rs-managed",
          kind: "managed",
          phase: "http_request_firewall_managed",
          name: "managed",
          version: "1",
        },
      ]),
    entrypoints: Object.fromEntries(
      settings.rulesetPhases.map((phase) => [
        phase,
        [
          {
            id: `rule-${phase}`,
            version: "2",
            last_updated: "2026-11-21T10:00:00Z",
            expression: `(http.host eq "${HOSTS.api}")`,
            action: phase === "http_request_firewall_custom" ? "block" : "rewrite",
            description: `${phase} rule`,
            enabled: true,
          },
        ],
      ]),
    ),
    accessApps: [
      {
        id: "app-1",
        name: "fin-next-staging-admin",
        type: "self_hosted",
        domain: HOSTS.admin,
        session_duration: "8h",
        enable_binding_cookie: true,
        http_only_cookie_attribute: true,
        same_site_cookie_attribute: "lax",
        app_launcher_visible: false,
        mfa_config: { allowed_authenticators: ["totp", "security_key"], session_duration: "8h" },
        policies: [
          {
            id: "pol-1",
            name: "staff",
            decision: "allow",
            precedence: 1,
            include: [{ email_domain: { domain: "example.com" } }],
            require: [{ login_method: { id: "otp" } }],
            exclude: [],
          },
        ],
      },
    ],
    emailSubdomains: [
      { name: `auth.${ZONE}`, preview_enabled: false, drop_suppressed_recipients: false },
      { name: `notify.${ZONE}`, preview_enabled: false, drop_suppressed_recipients: false },
    ],
    failures: {},
  };
}

/** The settings the watcher would be deployed with for this world. */
export async function settingsFor(world: World): Promise<WatcherSettings> {
  const rulesetHashes: Record<string, string> = {};
  for (const [phase, rules] of Object.entries(world.entrypoints)) {
    rulesetHashes[phase] = await rulesetHash(rules ?? []);
  }
  const app = world.accessApps[0] as { policies: unknown[] };
  const { $comment: _c, ...publicPart } = PUBLIC_SETTINGS;
  return parseSettings({
    ...publicPart,
    accountId: ACCOUNT,
    zone: ZONE,
    hosts: HOSTS,
    egress: EGRESS,
    rulesetHashes,
    accessPolicyHash: await accessPolicyHash(app.policies),
    release: "e".repeat(40),
  });
}

function envelope(result: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      success: status < 400,
      errors: status < 400 ? [] : [{ code: 10000 }],
      result,
      result_info: { page: 1, total_pages: 1 },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

/** A fetch serving the world at api.cloudflare.com, recording every request. */
export function cloudflareFetch(world: World, recorded: Recorded[] = []) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    recorded.push({
      method: init?.method ?? "GET",
      url: input,
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    if (url.hostname !== "api.cloudflare.com") return new Response("not found", { status: 404 });
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const failing = world.failures[path];
    if (failing !== undefined) return envelope(null, failing);
    const q = url.searchParams;
    const acc = `/accounts/${ACCOUNT}`;
    const zone = `/zones/${ZONE_ID}`;
    const script = path.match(
      new RegExp(`^${acc}/workers/scripts/([^/]+)/(settings|subdomain|schedules)$`),
    );
    if (script !== null) {
      const name = decodeURIComponent(script[1] ?? "");
      const table = {
        settings: world.scriptSettings,
        subdomain: world.subdomains,
        schedules: world.schedules,
      }[script[2] as "settings" | "subdomain" | "schedules"];
      const value = table[name];
      return value === undefined ? envelope(null, 404) : envelope(value);
    }
    const connections = path.match(new RegExp(`^${acc}/cfd_tunnel/([^/]+)/connections$`));
    if (connections !== null) return envelope(world.connections[connections[1] ?? ""] ?? []);
    const entry = path.match(new RegExp(`^${zone}/rulesets/phases/([^/]+)/entrypoint$`));
    if (entry !== null) {
      const rules = world.entrypoints[entry[1] ?? ""];
      return rules === undefined
        ? envelope(null, 404)
        : envelope({ id: "ep", phase: entry[1], rules });
    }
    switch (path) {
      case "/zones":
        return envelope(q.get("name") === ZONE ? [{ id: ZONE_ID, name: ZONE }] : []);
      case `${acc}/cfd_tunnel`:
        return envelope(world.tunnels);
      case `${zone}/dns_records`:
        return envelope(
          world.dns.filter(
            (r) =>
              (q.get("name") === null || r.name === q.get("name")) &&
              (q.get("type") === null || r.type === q.get("type")),
          ),
        );
      case `${zone}/workers/routes`:
        return envelope(world.routes);
      case `${acc}/workers/scripts`:
        return envelope(world.scripts);
      case `${acc}/workers/domains`:
        return envelope(world.domains.filter((d) => d.service === q.get("service")));
      case `${zone}/settings`:
        return envelope(world.zoneSettings);
      case `${zone}/ssl/universal/settings`:
        return envelope(world.universal);
      case `${zone}/bot_management`:
        return envelope(world.bots);
      case `${zone}/rulesets`:
        return envelope(world.rulesets);
      case `${acc}/access/apps`:
        return envelope(world.accessApps);
      case `${zone}/email/sending/subdomains`:
        return envelope(world.emailSubdomains);
      default:
        return envelope(null, 404);
    }
  };
}
