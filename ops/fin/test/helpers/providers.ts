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

/**
 * What a rendered reference reads as: a superuser URL with the template's password in it (built at
 * run time, so no source line holds a URL with a password).
 */
export const RENDERED_SECRET = ["postgresql:", "", `postgres:${"R".repeat(24)}@pg-host`, "db"].join(
  "/",
);

export interface RailwayPatch {
  environmentId: string;
  serviceId: string;
  variables: Record<string, { value: string; isSealed?: boolean }>;
}

export interface FakeInstance {
  region: string;
  numReplicas: number;
  restartPolicyType: string;
  sleepApplication: boolean;
  ipv6EgressEnabled: boolean;
  image: string | null;
  domains: string[];
  tcpProxies: number;
  healthcheckPath: string | null;
  healthcheckTimeout: number | null;
  overlapSeconds: number;
  drainingSeconds: number;
  startCommand: string | null;
  cronSchedule: string | null;
  variables: Record<string, string>;
  sealed: Set<string>;
  latestDeployment: { id: string; status: string } | null;
}

interface ProvisionSettings {
  region: string;
  services: Record<
    string,
    {
      template?: boolean;
      replicas: number;
      restart?: string;
      healthcheck?: string | null;
      overlapSeconds?: number;
      drainingSeconds?: number;
      startCommand?: string;
      cron?: string;
      staticEgress: boolean;
    }
  >;
}

export class FakeRailway {
  readonly token: string;
  readonly services = new Map<string, string>();
  readonly patches: RailwayPatch[] = [];
  readonly operations: string[] = [];
  egress = new Map<string, string[]>();
  readonly instances = new Map<string, FakeInstance>();
  readonly deployments = new Map<
    string,
    { service: string; statuses: string[]; logs: string[]; reads: number }
  >();
  readonly updates: Array<{ service: string; input: Json }> = [];
  environmentId = "";
  /** The statuses each new deployment reports, in turn; the last one repeats. */
  deployStatuses = ["DEPLOYING", "SUCCESS"];
  /** The log lines a migrate deployment writes, for a release. */
  migrateLogs = (release: string) => [
    JSON.stringify({ event: "migrate.started" }),
    JSON.stringify({ event: "migrate.done", release }),
  ];
  /**
   * How many log reads of a migrate deployment see only its first line, as when Railway's log
   * ingestion lags the container (the rest of the lines arrive after that many reads).
   */
  migrateLogReadsBehind = 0;
  /** The variables migrate's container started with, per migrate deployment. */
  readonly migrateEnvironments: Array<Record<string, string>> = [];
  readonly variableDeletes: Array<{ service: string; name: string }> = [];
  extendedRefused = false;
  variablesRefused = false;
  /**
   * Reads that answer 200 with a GraphQL error that is no refusal (Railway's own failure), by
   * operation (`finVariables`) or operation and service (`finVariables:migrate`).
   */
  readonly transient = new Set<string>();
  /** A variableDelete that Railway accepts without removing anything. */
  variableDeleteNoop = false;
  /** Called after each serviceInstanceUpdate, to change an instance the way Railway might. */
  onUpdate: ((service: string, instance: FakeInstance) => void) | undefined;
  /** How the egress read answers: normally, a GraphQL refusal, or a 503 every time. */
  egressAnswer: "ok" | "refused" | "unavailable" = "ok";
  /** Instances of a service in another environment of the project, with their domains. */
  readonly otherEnvironment = new Map<string, string[]>();

  constructor(token: string, names: readonly string[]) {
    this.token = token;
    for (const name of names) this.addService(name);
  }

  /** Adds a service to the project (with no instance until one is set or provisioned). */
  addService(name: string, instance?: Partial<FakeInstance>): void {
    const i = this.services.size;
    this.services.set(
      name,
      uuid(String.fromCharCode(97 + (i % 6))).replace(/^.{2}/, String(i).padStart(2, "0")),
    );
    if (instance !== undefined) {
      this.instances.set(name, {
        region: "us-east4-eqdc4a",
        numReplicas: 1,
        restartPolicyType: "ALWAYS",
        sleepApplication: false,
        ipv6EgressEnabled: false,
        image: null,
        domains: [],
        tcpProxies: 0,
        healthcheckPath: null,
        healthcheckTimeout: null,
        overlapSeconds: 0,
        drainingSeconds: 0,
        startCommand: null,
        cronSchedule: null,
        variables: {},
        sealed: new Set(),
        latestDeployment: null,
        ...instance,
      });
    }
  }

  nameOf(id: string): string | undefined {
    return [...this.services.entries()].find(([, v]) => v === id)?.[0];
  }

  /** Provisions every service exactly as the settings say (spec 01 §6.2), with no image yet. */
  provision(
    settings: ProvisionSettings,
    environmentId: string,
    egress: Record<string, readonly string[]> = {},
  ): void {
    this.environmentId = environmentId;
    let n = 0;
    for (const [name, want] of Object.entries(settings.services)) {
      n++;
      this.instances.set(name, {
        region: settings.region,
        numReplicas: want.replicas,
        restartPolicyType: want.restart ?? "ALWAYS",
        sleepApplication: false,
        ipv6EgressEnabled: false,
        image: null,
        domains: [],
        tcpProxies: 0,
        healthcheckPath: want.healthcheck ?? null,
        healthcheckTimeout: want.healthcheck ? 60 : null,
        overlapSeconds: want.overlapSeconds ?? 0,
        drainingSeconds: want.drainingSeconds ?? 0,
        startCommand: want.startCommand ?? null,
        cronSchedule: want.cron ?? null,
        // The checklist sets PORT=8080 on every service it provisions (spec 01 §6.2).
        variables: want.template === true ? {} : { PORT: "8080" },
        sealed: new Set(),
        latestDeployment: null,
      });
      if (want.staticEgress) this.egress.set(name, [...(egress[name] ?? [`198.51.100.${n}`])]);
    }
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
        const instance = this.instances.get(this.nameOf(serviceId) ?? "");
        for (const [name, v] of Object.entries(s.variables)) {
          if (instance === undefined) continue;
          if (v.isSealed === true) {
            instance.sealed.add(name);
            delete instance.variables[name];
          } else instance.variables[name] = v.value;
        }
      }
      return ok({ environmentPatchCommit: "commit" });
    }
    const service = this.nameOf(String(variables.serviceId ?? "")) ?? "";
    const refused = (what: string) =>
      new Response(JSON.stringify({ errors: [{ message: `Cannot query field ${what}` }] }), {
        status: 200,
      });
    if (this.transient.has(op) || this.transient.has(`${op}:${service}`)) {
      return new Response(
        JSON.stringify({ data: null, errors: [{ message: "Problem processing request" }] }),
        { status: 200 },
      );
    }
    if (op === "finStatus" || op === "finStatusExtended") {
      if (op === "finStatusExtended" && this.extendedRefused) return refused("healthcheckPath");
      return ok({
        project: {
          services: {
            edges: [...this.services].map(([name, id]) => {
              const i = this.instances.get(name);
              const node =
                i === undefined
                  ? undefined
                  : op === "finStatus"
                    ? {
                        environmentId: this.environmentId,
                        region: i.region,
                        numReplicas: i.numReplicas,
                        restartPolicyType: i.restartPolicyType,
                        sleepApplication: i.sleepApplication,
                        ipv6EgressEnabled: i.ipv6EgressEnabled,
                        source: { image: i.image },
                        domains: {
                          serviceDomains: i.domains.map((domain) => ({ domain })),
                          customDomains: [],
                        },
                        latestDeployment: i.latestDeployment,
                      }
                    : {
                        environmentId: this.environmentId,
                        healthcheckPath: i.healthcheckPath,
                        healthcheckTimeout: i.healthcheckTimeout,
                        overlapSeconds: i.overlapSeconds,
                        drainingSeconds: i.drainingSeconds,
                        startCommand: i.startCommand,
                        cronSchedule: i.cronSchedule,
                      };
              const other = this.otherEnvironment.get(name);
              const otherEdge =
                other === undefined
                  ? []
                  : [
                      {
                        node:
                          op === "finStatus"
                            ? {
                                environmentId: "other-environment",
                                source: { image: null },
                                domains: {
                                  serviceDomains: other.map((domain) => ({ domain })),
                                  customDomains: [],
                                },
                              }
                            : { environmentId: "other-environment" },
                      },
                    ];
              return {
                node: {
                  id,
                  name,
                  serviceInstances: {
                    edges: [...(node === undefined ? [] : [{ node }]), ...otherEdge],
                  },
                },
              };
            }),
          },
        },
      });
    }
    if (op === "finTcp") {
      return ok({
        tcpProxies: Array.from(
          { length: this.instances.get(service)?.tcpProxies ?? 0 },
          (_, i) => ({ id: String(i) }),
        ),
      });
    }
    if (op === "finVariables") {
      if (this.variablesRefused) return refused("variables");
      const raw = this.instances.get(service)?.variables ?? {};
      // Railway renders a reference (`${{service.VAR}}`) into its value unless asked for the
      // unrendered form; a rendered database reference carries the template's password.
      const unrendered = /\bunrendered:\s*true\b/.test(query);
      return ok({
        variables: Object.fromEntries(
          Object.entries(raw).map(([name, value]) => [
            name,
            unrendered ? value : value.replace(/\$\{\{[^}]*\}\}/g, RENDERED_SECRET),
          ]),
        ),
      });
    }
    if (op === "finInstanceUpdate") {
      const input = variables.input as Json;
      this.updates.push({ service, input });
      const instance = this.instances.get(service);
      const source = input.source as { image?: string } | undefined;
      if (instance !== undefined && source?.image !== undefined) instance.image = source.image;
      if (instance !== undefined && typeof input.startCommand === "string")
        instance.startCommand = input.startCommand;
      if (instance !== undefined) this.onUpdate?.(service, instance);
      return ok({ serviceInstanceUpdate: true });
    }
    if (op === "finVariableDelete") {
      const input = variables.input as { serviceId?: string; name?: string };
      const target = this.nameOf(String(input.serviceId ?? "")) ?? "";
      this.variableDeletes.push({ service: target, name: String(input.name) });
      const instance = this.instances.get(target);
      if (instance !== undefined && !this.variableDeleteNoop)
        delete instance.variables[String(input.name)];
      return ok({ variableDelete: true });
    }
    if (op === "finDeploy") {
      const id = `dep-${this.deployments.size + 1}`;
      const release = this.instances.get(service)?.variables.FIN_RELEASE ?? "";
      if (service === "migrate")
        this.migrateEnvironments.push({ ...(this.instances.get(service)?.variables ?? {}) });
      this.deployments.set(id, {
        service,
        statuses: [...this.deployStatuses],
        logs: service === "migrate" ? this.migrateLogs(release) : [],
        reads: 0,
      });
      const instance = this.instances.get(service);
      if (instance !== undefined) instance.latestDeployment = { id, status: "DEPLOYING" };
      return ok({ serviceInstanceDeployV2: id });
    }
    if (op === "finDeployment") {
      const d = this.deployments.get(String(variables.id));
      if (d === undefined) return refused("deployment");
      const status =
        d.statuses.length > 1 ? (d.statuses.shift() ?? "SUCCESS") : (d.statuses[0] ?? "SUCCESS");
      const instance = this.instances.get(d.service);
      if (instance !== undefined && instance.latestDeployment?.id === variables.id) {
        instance.latestDeployment = { id: String(variables.id), status };
      }
      return ok({ deployment: { id: variables.id, status } });
    }
    if (op === "finLogs") {
      const d = this.deployments.get(String(variables.deploymentId));
      if (d === undefined) return ok({ deploymentLogs: [] });
      d.reads++;
      const lines = d.reads <= this.migrateLogReadsBehind ? d.logs.slice(0, 1) : d.logs;
      return ok({ deploymentLogs: lines.map((message) => ({ message })) });
    }
    if (op === "finEgress") {
      if (this.egressAnswer === "refused") return refused("egressGateways");
      if (this.egressAnswer === "unavailable")
        return new Response(JSON.stringify({ errors: [{ message: "unavailable" }] }), {
          status: 503,
        });
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
