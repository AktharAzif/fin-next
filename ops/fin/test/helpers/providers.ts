// In-memory fakes of the Cloudflare v4 API and Railway's GraphQL API, shaped like the answers the
// spikes recorded (S-01, SP-26 and the hand provisioning of 21 Nov). They check the bearer token,
// keep every call in order, and answer 404 for anything they do not know, so a test fails when a
// command calls an endpoint it should not.

import type { FetchFn } from "../../src/core/runtime.ts";
import { ACCOUNT_ID, hex, uuid, ZONE_ID } from "./fixtures.ts";

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export interface Rule {
  id: string;
  ref?: string;
  expression?: string;
  action?: string;
  description?: string;
  action_parameters?: Record<string, unknown>;
  ratelimit?: Record<string, unknown>;
  enabled?: boolean;
}

type Json = Record<string, unknown>;

let counter = 0;
function newId(): string {
  counter++;
  return `${hex(26, "f")}${String(counter).padStart(6, "0")}`;
}

function envelope(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 300, errors: [], messages: [], result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function failure(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ success: false, errors: [{ code, message }], result: null }),
    { status },
  );
}

export class FakeCloudflare {
  readonly token: string;
  readonly calls: Call[] = [];
  settings = new Map<string, { id: string; value: unknown; editable: boolean }>();
  rulesets = new Map<string, { id: string; phase: string; rules: Rule[] }>();
  routes: Array<{ id: string; pattern: string; script?: string }> = [];
  dns: Array<{
    id: string;
    type: string;
    name: string;
    content: string;
    proxied?: boolean;
    meta?: Json;
  }> = [];
  tunnels: Array<{ id: string; name: string; config_src: string; deleted_at: null }> = [];
  idps: Array<{ id: string; type: string; name: string }> = [
    { id: uuid("1"), type: "onetimepin", name: "PIN" },
  ];
  policies: Array<Json & { id: string; name: string }> = [];
  apps: Array<Json & { id: string; name: string }> = [];
  sending: Array<{
    tag: string;
    name: string;
    preview_enabled: boolean;
    drop_suppressed_recipients: boolean;
  }> = [];
  tokens: Array<{ id: string; name: string; status: string }> = [];
  groups = [
    { id: hex(32, "6"), name: "Email Sending Write" },
    { id: hex(32, "7"), name: "Email Sending Read" },
    { id: hex(32, "8"), name: "Account Settings Write" },
  ];

  constructor(token: string) {
    this.token = token;
    for (const [id, value] of Object.entries({
      min_tls_version: "1.0",
      tls_1_3: "on",
      "0rtt": "on",
      always_use_https: "on",
      ssl_automatic_mode: "auto",
      ip_geolocation: "on",
      rocket_loader: "off",
      email_obfuscation: "on",
      automatic_https_rewrites: "on",
      hotlink_protection: "off",
      polish: "off",
      mirage: "off",
      security_header: {
        strict_transport_security: {
          enabled: false,
          max_age: 0,
          include_subdomains: false,
          preload: false,
          nosniff: false,
        },
      },
    })) {
      this.settings.set(id, { id, value, editable: true });
    }
  }

  /** Writes only: every call that is not a GET. */
  writes(): Call[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  readonly fetch: FetchFn = async (url, init) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const auth = new Headers(init.headers).get("authorization");
    let body: unknown;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    else if (init.body instanceof FormData) body = init.body;
    const path = u.pathname.replace(/^\/client\/v4/, "");
    this.calls.push({ method, path: `${path}${u.search}`, body });
    if (auth !== `Bearer ${this.token}`) return failure(403, 10000, "Authentication error");
    return this.route(method, path, u.searchParams, body as Json);
  };

  private route(method: string, path: string, query: URLSearchParams, body: Json): Response {
    const zone = `/zones/${ZONE_ID}`;
    const account = `/accounts/${ACCOUNT_ID}`;
    const hit: { m: RegExpExecArray | null } = { m: null };
    const at = (pattern: string): RegExpExecArray | null => {
      hit.m = new RegExp(pattern).exec(path);
      return hit.m;
    };
    // Zone settings.
    if (method === "GET" && path === `${zone}/settings`)
      return envelope([...this.settings.values()]);
    if (at(`^${zone}/settings/([a-z0-9_]+)$`) && method === "PATCH") {
      const s = this.settings.get(hit.m?.[1] ?? "");
      if (s === undefined) return failure(404, 1000, "no such setting");
      s.value = body.value;
      return envelope(s);
    }
    // Rule sets.
    if (at(`^${zone}/rulesets/phases/([a-z_]+)/entrypoint$`) && method === "GET") {
      const rs = [...this.rulesets.values()].find((r) => r.phase === hit.m?.[1]);
      return rs === undefined ? failure(404, 10003, "not found") : envelope(rs);
    }
    if (path === `${zone}/rulesets` && method === "POST") {
      const phase = String(body.phase);
      if ([...this.rulesets.values()].some((r) => r.phase === phase))
        return failure(400, 20217, "exists");
      const rs = {
        id: newId(),
        phase,
        rules: ((body.rules as Rule[]) ?? []).map((r) => ({ ...r, id: newId() })),
      };
      this.rulesets.set(rs.id, rs);
      return envelope(rs);
    }
    if (at(`^${zone}/rulesets/([a-z0-9]+)/rules$`) && method === "POST") {
      const rs = this.rulesets.get(hit.m?.[1] ?? "");
      if (rs === undefined) return failure(404, 10003, "not found");
      rs.rules.push({ ...(body as unknown as Rule), id: newId() });
      return envelope(rs);
    }
    if (at(`^${zone}/rulesets/([a-z0-9]+)/rules/([a-z0-9]+)$`)) {
      const rs = this.rulesets.get(hit.m?.[1] ?? "");
      const i = rs?.rules.findIndex((r) => r.id === hit.m?.[2]) ?? -1;
      if (rs === undefined || i < 0) return failure(404, 10003, "not found");
      if (method === "PATCH")
        rs.rules[i] = { ...(body as unknown as Rule), id: rs.rules[i]?.id ?? "" };
      else if (method === "DELETE") rs.rules.splice(i, 1);
      return envelope(rs);
    }
    // Workers routes.
    if (path === `${zone}/workers/routes`) {
      if (method === "GET") return envelope(this.routes);
      if (method === "POST") {
        const r = {
          id: newId(),
          pattern: String(body.pattern),
          ...(body.script ? { script: String(body.script) } : {}),
        };
        this.routes.push(r);
        return envelope(r);
      }
    }
    if (at(`^${zone}/workers/routes/([a-z0-9]+)$`)) {
      const i = this.routes.findIndex((r) => r.id === hit.m?.[1]);
      if (i < 0) return failure(404, 10000, "not found");
      if (method === "DELETE") this.routes.splice(i, 1);
      if (method === "PUT")
        this.routes[i] = {
          id: hit.m?.[1] ?? "",
          pattern: String(body.pattern),
          ...(body.script ? { script: String(body.script) } : {}),
        };
      return envelope(this.routes[i] ?? { id: hit.m?.[1] });
    }
    // DNS.
    if (path === `${zone}/dns_records`) {
      if (method === "GET") {
        return envelope(
          this.dns.filter(
            (r) =>
              (!query.get("name") || r.name === query.get("name")) &&
              (!query.get("type") || r.type === query.get("type")),
          ),
        );
      }
      if (method === "POST") {
        const r = {
          id: newId(),
          type: String(body.type),
          name: String(body.name),
          content: String(body.content),
          proxied: body.proxied === true,
        };
        this.dns.push(r);
        return envelope(r);
      }
    }
    if (at(`^${zone}/dns_records/([a-z0-9]+)$`) && method === "PATCH") {
      const r = this.dns.find((d) => d.id === hit.m?.[1]);
      if (r === undefined) return failure(404, 81044, "not found");
      if (r.meta?.read_only === true) return failure(400, 1000, "read only");
      Object.assign(r, { content: body.content, proxied: body.proxied });
      return envelope(r);
    }
    // Email Sending.
    if (path === `${zone}/email/sending/subdomains`) {
      if (method === "GET") return envelope(this.sending);
      if (method === "POST") {
        const d = {
          tag: newId(),
          name: String(body.name),
          preview_enabled: true,
          drop_suppressed_recipients: true,
        };
        this.sending.push(d);
        return envelope(d);
      }
    }
    if (at(`^${zone}/email/sending/subdomains/([a-z0-9]+)$`) && method === "PATCH") {
      const d = this.sending.find((s) => s.tag === hit.m?.[1]);
      if (d === undefined) return failure(404, 1000, "not found");
      Object.assign(d, body);
      return envelope(d);
    }
    // Tunnels.
    if (path === `${account}/cfd_tunnel`) {
      if (method === "GET")
        return envelope(this.tunnels.filter((t) => t.name === query.get("name")));
      if (method === "POST") {
        const t = {
          id: uuid(String((this.tunnels.length + 3) % 10)),
          name: String(body.name),
          config_src: String(body.config_src),
          deleted_at: null,
        };
        this.tunnels.push(t);
        return envelope(t);
      }
    }
    if (at(`^${account}/cfd_tunnel/([a-f0-9-]+)/token$`) && method === "GET") {
      return envelope(`eyJ${"T".repeat(30)}${hit.m?.[1]?.slice(0, 4)}`);
    }
    // Access.
    if (path === `${account}/access/identity_providers` && method === "GET")
      return envelope(this.idps);
    if (path === `${account}/access/policies`) {
      if (method === "GET") return envelope(this.policies);
      if (method === "POST") {
        const p = { ...body, id: uuid("9") } as unknown as Json & { id: string; name: string };
        this.policies.push(p);
        return envelope(p);
      }
    }
    if (at(`^${account}/access/policies/([a-f0-9-]+)$`) && method === "PUT") {
      const i = this.policies.findIndex((p) => p.id === hit.m?.[1]);
      this.policies[i] = { ...body, id: hit.m?.[1] ?? "" } as unknown as Json & {
        id: string;
        name: string;
      };
      return envelope(this.policies[i]);
    }
    if (path === `${account}/access/apps`) {
      if (method === "GET") return envelope(this.apps);
      if (method === "POST") {
        const a = { ...body, id: uuid("a"), aud: hex(64, "5") } as unknown as Json & {
          id: string;
          name: string;
        };
        this.apps.push(a);
        return envelope(a);
      }
    }
    if (at(`^${account}/access/apps/([a-f0-9-]+)$`) && method === "GET") {
      const a = this.apps.find((x) => x.id === hit.m?.[1]);
      if (a === undefined) return failure(404, 12130, "not found");
      const ids = Array.isArray(a.policies)
        ? (a.policies as Array<{ id: string; precedence: number }>)
        : [];
      return envelope({
        ...a,
        policies: ids.map((p) => ({
          ...this.policies.find((q) => q.id === p.id),
          precedence: p.precedence,
        })),
      });
    }
    if (at(`^${account}/access/apps/([a-f0-9-]+)$`) && method === "PUT") {
      const i = this.apps.findIndex((a) => a.id === hit.m?.[1]);
      this.apps[i] = { ...body, id: hit.m?.[1] ?? "", aud: hex(64, "5") } as unknown as Json & {
        id: string;
        name: string;
      };
      return envelope(this.apps[i]);
    }
    // Tokens.
    if (path === `${account}/tokens/permission_groups` && method === "GET")
      return envelope(this.groups);
    if (path === `${account}/tokens`) {
      if (method === "GET") return envelope(this.tokens);
      if (method === "POST") {
        const t = { id: newId(), name: String(body.name), status: "active" };
        this.tokens.push(t);
        return envelope({ ...t, value: `mintedvalue${"Q".repeat(30)}${this.tokens.length}` });
      }
    }
    if (at(`^${account}/tokens/([a-z0-9]+)$`) && method === "DELETE") {
      this.tokens = this.tokens.filter((t) => t.id !== hit.m?.[1]);
      return envelope({ id: hit.m?.[1] });
    }
    return failure(404, 7003, `no route for ${method} ${path}`);
  }
}

export interface RailwayPatch {
  environmentId: string;
  serviceId: string;
  variables: Record<string, { value: string; isSealed?: boolean }>;
}

export class FakeRailway {
  readonly token: string;
  readonly services = new Map<string, string>();
  readonly patches: RailwayPatch[] = [];
  readonly operations: string[] = [];
  egress = new Map<string, string[]>();

  constructor(token: string, names: readonly string[]) {
    this.token = token;
    names.forEach((name, i) => {
      this.services.set(
        name,
        uuid(String.fromCharCode(97 + (i % 6))).replace(/^.{2}/, String(i).padStart(2, "0")),
      );
    });
  }

  nameOf(id: string): string | undefined {
    return [...this.services.entries()].find(([, v]) => v === id)?.[0];
  }

  readonly fetch: FetchFn = async (_url, init) => {
    if (new Headers(init.headers).get("project-access-token") !== this.token) {
      return new Response(JSON.stringify({ errors: [{ message: "Not Authorized" }] }), {
        status: 200,
      });
    }
    const { query, variables } = JSON.parse(String(init.body)) as {
      query: string;
      variables: Json;
    };
    const op = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "";
    this.operations.push(op);
    const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (op === "finServices") {
      return ok({
        project: {
          services: { edges: [...this.services].map(([name, id]) => ({ node: { id, name } })) },
        },
      });
    }
    if (op === "finPatch") {
      const patch = variables.patch as {
        services: Record<string, { variables: RailwayPatch["variables"] }>;
      };
      for (const [serviceId, s] of Object.entries(patch.services)) {
        this.patches.push({
          environmentId: String(variables.environmentId),
          serviceId,
          variables: s.variables,
        });
      }
      return ok({ environmentPatchCommit: "commit" });
    }
    if (op === "finEgress") {
      const name = this.nameOf(String(variables.serviceId)) ?? "";
      return ok({ egressGateways: (this.egress.get(name) ?? []).map((ipv4) => ({ ipv4 })) });
    }
    return new Response(JSON.stringify({ errors: [{ message: `unknown operation ${op}` }] }), {
      status: 200,
    });
  };
}

/**
 * One fetch that sends Cloudflare calls to one fake and Railway calls to the other, and records
 * the order of every call across both in `sequence` ("cf POST /zones/..." or "rw finPatch").
 */
export function providers(cf: FakeCloudflare, rw: FakeRailway, sequence: string[] = []): FetchFn {
  return async (url, init) => {
    if (url.startsWith("https://backboard.railway.com/")) {
      const op = /^\s*(?:query|mutation)\s+(\w+)/.exec(JSON.parse(String(init.body)).query)?.[1];
      sequence.push(`rw ${op}`);
      return rw.fetch(url, init);
    }
    sequence.push(
      `cf ${init.method ?? "GET"} ${new URL(url).pathname.replace(/^\/client\/v4/, "")}`,
    );
    return cf.fetch(url, init);
  };
}
