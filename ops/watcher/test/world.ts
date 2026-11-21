// A healthy staging front door as Cloudflare's API returns it (the shapes recorded from the API
// reference: { success, errors, result, result_info }), and a fetch that serves it. Each test
// changes one thing and expects exactly the matching failure. IDs and addresses are built at run
// time (documentation ranges, example.net), so no ID-shaped literal is committed.
//
// The account and the zone are shared with the old product's staging (FD-09), so the healthy
// world also holds the old product's own Worker, route, custom domain, Access application, DNS
// records (its apex _dmarc among them) and zone rules: none of them may fail a check.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accessPolicyHash, finRulesetHash } from "../src/hash.ts";
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
/** One of the old product's own hosts on the shared zone. */
export const OLD_HOST = `old.${ZONE}`;
export const OLD_SCRIPT = "legacy-app";

/** The phases fin-next's `rules apply` writes (spec 01 §7.6; EXECUTION §2.5 step 7). */
export const FIN_PHASES = [
  "http_request_late_transform",
  "http_request_dynamic_redirect",
  "http_request_firewall_custom",
  "http_ratelimit",
  "http_config_settings",
  "http_request_cache_settings",
  "http_response_headers_transform",
  "http_request_firewall_managed",
] as const;

export const PUBLIC_SETTINGS = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "settings", "staging.json"), "utf8"),
) as Record<string, unknown>;

type Json = Record<string, unknown>;

/** How a list endpoint pages its results (Cloudflare's lists differ). */
export type Paging = "total_pages" | "total_count" | "none" | "cursor" | "ignore";

export interface World {
  tunnels: Json[];
  connections: Record<string, Json[]>;
  dns: Json[];
  routes: Json[];
  scripts: Json[];
  scriptSettings: Record<string, Json>;
  subdomains: Record<string, Json>;
  schedules: Record<string, Json>;
  deployments: Record<string, Json>;
  domains: Json[];
  zoneSettings: Json[];
  universal: Json;
  bots: Json;
  rulesets: Json[];
  entrypoints: Record<string, Json[] | undefined>;
  /** Rules of the zone rule sets that are not a phase fin-next writes, by rule set ID. */
  otherRulesets: Record<string, Json[]>;
  accessApps: Json[];
  emailSubdomains: Json[];
  /** Paths that answer with this status instead (to test failing closed). */
  failures: Record<string, number>;
  /** How each list path pages (default: page numbers with total_pages). */
  paging: Record<string, Paging>;
  /** Zones the token can also read (a pending zone of the same name in another account). */
  otherZones: Json[];
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

const txt = (id: string, name: string, content: string): Json => ({
  id,
  type: "TXT",
  name,
  content,
  proxied: false,
});

/** The rule `rules apply` writes into a phase (one per phase is enough for the checks). */
function finRule(phase: string): Json {
  return {
    id: `rule-${phase}`,
    version: "2",
    last_updated: "2026-11-21T10:00:00Z",
    ref: `fin_next_${phase}`,
    expression: `(http.host eq "${HOSTS.api}")`,
    action:
      phase === "http_request_firewall_custom"
        ? "block"
        : phase === "http_request_firewall_managed"
          ? "execute"
          : "rewrite",
    description: `fin-next: ${phase} rule`,
    enabled: true,
  };
}

/** The old product's redirect rule, which the shared zone's redirect phase already holds. */
export function oldProductRule(): Json {
  return {
    id: "rule-legacy",
    version: "7",
    ref: "legacy_redirect",
    expression: `(http.host eq "${OLD_HOST}")`,
    action: "redirect",
    description: "the old product's redirect",
    enabled: true,
  };
}

export function healthyWorld(): World {
  const settings = PUBLIC_SETTINGS as {
    static: { name: string; host: string }[];
    routes: { host: keyof typeof HOSTS; path: string; script: string | null }[];
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
  const perScript = <T>(make: (name: string) => T) =>
    Object.fromEntries(settings.static.map((s) => [s.name, make(s.name)])) as Record<string, T>;
  const entrypoints: Record<string, Json[]> = Object.fromEntries(
    FIN_PHASES.map((phase) => [phase, [finRule(phase)]]),
  );
  entrypoints.http_request_dynamic_redirect = [
    oldProductRule(),
    ...(entrypoints.http_request_dynamic_redirect ?? []),
  ];
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
    dns: HOST_ROLES.map(
      (role): Json => ({
        id: `rec-${role}`,
        type: "CNAME",
        name: HOSTS[role],
        content: `${tunnelOf(role)}.cfargotunnel.com`,
        proxied: true,
      }),
    ).concat([
      // fin-next's DMARC records, which Email Sending wrote at p=reject (BD-17).
      txt("rec-dmarc-auth", `_dmarc.auth.${ZONE}`, '"v=DMARC1; p=reject; adkim=s; aspf=s"'),
      txt("rec-dmarc-notify", `_dmarc.notify.${ZONE}`, '"v=DMARC1; p=reject"'),
      // The old product's own apex record, which fin-next never touches (FD-09).
      txt("rec-dmarc-apex", `_dmarc.${ZONE}`, '"v=DMARC1; p=none"'),
      { id: "rec-old", type: "A", name: OLD_HOST, content: "192.0.2.10", proxied: true },
    ]),
    routes: settings.routes
      .map((r, i) => ({
        id: `route-${i}`,
        pattern: `${HOSTS[r.host]}${r.path}`,
        ...(r.script === null ? {} : { script: r.script }),
      }))
      .concat([{ id: "route-old", pattern: `${OLD_HOST}/*`, script: OLD_SCRIPT }]),
    scripts: [
      ...staticScripts,
      {
        id: "fin-next-staging-watcher",
        has_assets: false,
        has_modules: true,
        handlers: ["scheduled"],
      },
      { id: OLD_SCRIPT, has_assets: false, has_modules: true, handlers: ["fetch"] },
    ],
    scriptSettings: perScript(() => ({ bindings: [], compatibility_date: "2026-11-20" })),
    subdomains: perScript(() => ({ enabled: false, previews_enabled: false })),
    schedules: perScript(() => ({ schedules: [] })),
    deployments: perScript((name) => ({
      deployments: [
        {
          id: `dep-${name}-2`,
          source: "api",
          strategy: "percentage",
          created_on: "2026-11-21T10:00:00Z",
          versions: [{ version_id: `ver-${name}-2`, percentage: 100 }],
        },
        {
          id: `dep-${name}-1`,
          source: "api",
          strategy: "percentage",
          created_on: "2026-11-20T10:00:00Z",
          versions: [{ version_id: `ver-${name}-1`, percentage: 100 }],
        },
      ],
    })),
    domains: [{ id: "dom-old", hostname: `legacy.${ZONE}`, service: OLD_SCRIPT }],
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
    rulesets: FIN_PHASES.map(
      (phase, i): Json => ({
        id: `rs-${i}`,
        kind: "zone",
        phase,
        name: "default",
        version: "3",
      }),
    ).concat([
      {
        id: "rs-managed",
        kind: "managed",
        phase: "http_request_firewall_managed",
        name: "managed",
        version: "1",
      },
      // The old product's own rule set in a phase fin-next does not write.
      { id: "rs-old", kind: "zone", phase: "http_request_transform", name: "old", version: "4" },
    ]),
    entrypoints,
    otherRulesets: {
      "rs-old": [
        {
          id: "rule-old-rewrite",
          ref: "legacy_rewrite",
          expression: `(http.host eq "${OLD_HOST}")`,
          action: "rewrite",
        },
      ],
    },
    accessApps: [
      {
        id: "app-old",
        name: "old product staff",
        type: "self_hosted",
        domain: OLD_HOST,
        self_hosted_domains: [OLD_HOST],
        policies: [{ id: "pol-old", name: "old", decision: "allow", include: [] }],
      },
      {
        id: "app-1",
        name: "fin-next-staging-admin",
        type: "self_hosted",
        domain: HOSTS.admin,
        self_hosted_domains: [HOSTS.admin],
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
    paging: {},
    otherZones: [],
  };
}

/** The active version of each static deployment, as the registered static deploy recorded it. */
export function activeVersions(world: World): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(world.deployments)) {
    const [first] = (value.deployments ?? []) as { versions?: { version_id?: string }[] }[];
    const id = first?.versions?.[0]?.version_id;
    if (typeof id === "string") out[name] = id;
  }
  return out;
}

/** The settings the watcher would be deployed with for this world. */
export async function settingsFor(world: World): Promise<WatcherSettings> {
  const rulesetHashes: Record<string, string> = {};
  for (const [phase, rules] of Object.entries(world.entrypoints)) {
    rulesetHashes[phase] = await finRulesetHash(rules ?? []);
  }
  const app = world.accessApps.find((a) => a.name === "fin-next-staging-admin") as
    | { policies: unknown[] }
    | undefined;
  const { $comment: _c, ...publicPart } = PUBLIC_SETTINGS;
  return parseSettings({
    ...publicPart,
    accountId: ACCOUNT,
    zone: ZONE,
    hosts: HOSTS,
    egress: EGRESS,
    rulesetHashes,
    accessPolicyHash: await accessPolicyHash(app?.policies ?? []),
    staticVersions: activeVersions(world),
    release: "e".repeat(40),
  });
}

function envelope(result: unknown, status = 200, resultInfo?: unknown): Response {
  return new Response(
    JSON.stringify({
      success: status < 400,
      errors: status < 400 ? [] : [{ code: 10000 }],
      result,
      ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/** A list answer, paged the way `paging` says (no paging parameter: the whole list). */
function listEnvelope(items: readonly unknown[], q: URLSearchParams, paging: Paging): Response {
  const paged = q.has("page") || q.has("per_page") || q.has("cursor");
  if (!paged) return envelope(items, 200, { page: 1, total_pages: 1 });
  const perPage = Number(q.get("per_page") ?? "20");
  if (paging === "ignore") return envelope(items);
  if (paging === "cursor") {
    const offset = Number((q.get("cursor") ?? "c0").slice(1));
    const slice = items.slice(offset, offset + perPage);
    const next = offset + perPage < items.length ? `c${offset + perPage}` : "";
    return envelope(slice, 200, { per_page: perPage, count: slice.length, cursor: next });
  }
  const page = Number(q.get("page") ?? "1");
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const base = { page, per_page: perPage, count: slice.length };
  if (paging === "none") return envelope(slice);
  if (paging === "total_count") {
    return envelope(slice, 200, { ...base, total_count: items.length });
  }
  return envelope(slice, 200, {
    ...base,
    total_count: items.length,
    total_pages: Math.max(1, Math.ceil(items.length / perPage)),
  });
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
    const list = (items: readonly unknown[]) =>
      listEnvelope(items, q, world.paging[path] ?? "total_pages");
    const acc = `/accounts/${ACCOUNT}`;
    const zone = `/zones/${ZONE_ID}`;
    const script = path.match(
      new RegExp(`^${acc}/workers/scripts/([^/]+)/(settings|subdomain|schedules|deployments)$`),
    );
    if (script !== null) {
      const name = decodeURIComponent(script[1] ?? "");
      const table = {
        settings: world.scriptSettings,
        subdomain: world.subdomains,
        schedules: world.schedules,
        deployments: world.deployments,
      }[script[2] as "settings" | "subdomain" | "schedules" | "deployments"];
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
        : envelope({ id: "ep", kind: "zone", phase: entry[1], rules });
    }
    const ruleset = path.match(new RegExp(`^${zone}/rulesets/([^/]+)$`));
    if (ruleset !== null) {
      const id = decodeURIComponent(ruleset[1] ?? "");
      const listed = world.rulesets.find((r) => r.id === id);
      if (listed === undefined) return envelope(null, 404);
      const rules =
        world.otherRulesets[id] ??
        (listed.kind === "zone" ? world.entrypoints[String(listed.phase)] : undefined) ??
        [];
      return envelope({ ...listed, rules });
    }
    switch (path) {
      case "/zones":
        return list(
          [...world.otherZones, { id: ZONE_ID, name: ZONE, account: { id: ACCOUNT } }].filter(
            (z) => z.name === q.get("name"),
          ),
        );
      case `${acc}/cfd_tunnel`:
        return list(world.tunnels);
      case `${zone}/dns_records`:
        return list(
          world.dns.filter(
            (r) =>
              (q.get("name") === null || r.name === q.get("name")) &&
              (q.get("type") === null || r.type === q.get("type")),
          ),
        );
      case `${zone}/workers/routes`:
        return list(world.routes);
      case `${acc}/workers/scripts`:
        return list(world.scripts);
      case `${acc}/workers/domains`:
        return list(
          world.domains.filter((d) => q.get("service") === null || d.service === q.get("service")),
        );
      case `${zone}/settings`:
        return list(world.zoneSettings);
      case `${zone}/ssl/universal/settings`:
        return envelope(world.universal);
      case `${zone}/bot_management`:
        return envelope(world.bots);
      case `${zone}/rulesets`:
        return list(world.rulesets);
      case `${acc}/access/apps`:
        return list(world.accessApps);
      case `${zone}/email/sending/subdomains`:
        return list(world.emailSubdomains);
      default:
        return envelope(null, 404);
    }
  };
}
