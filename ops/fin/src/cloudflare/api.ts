// Cloudflare's v4 API: reads, and the one guarded path for writes.
//
// CloudflareApi only reads in public. Its raw send is keyed by a symbol this module keeps, so only
// CloudflareWriter.write() can send a write. Before it sends anything, write() refuses outside a
// registered run and in every dry run, and check() refuses unless all of these hold (BD-11, EX-27):
//
//   - the target passes the allow-list guard (hostnames, rule refs, Fin's own names);
//   - the path is the one endpoint that kind of write may use, on the overlay's own account and
//     zone: a POST goes to the collection itself (never a bulk endpoint such as `dns_records/batch`),
//     and any other method to `<collection>/<id>` where `<id>` is the ID of the object the target
//     was read as, so a write cannot change an object other than the one it names;
//   - the body names what the target names: a record's name, a route's pattern, a rule's ref and
//     the hostnames in its expression, every domain of an Access application, a token's account,
//     permission groups and IP filter, an assets-only script upload;
//   - no PUT replaces a rule set (a whole-phase replace would remove another product's rules).
//
// The body checks read the request the writer is about to send, not a label beside it. They are a
// lint against mistakes, not a parser: a deliberately obfuscated expression is a review finding.
//
// A provider's error names neither a private value nor an object ID: its text is masked before it
// is cut (a value cut in two would no longer match the masker), a value only one write carries (the
// rate rule's threshold, a short number the masker must never hold) is redacted from that write's
// error alone, and every ID-shaped segment of the path is replaced by `<id>` (spec 01 §9.2: names,
// never IDs). Context.applyPlan records each change
// as a run step once its writes have succeeded.

import { ProviderError, RefusedError } from "../core/errors.ts";
import { type Guard, RULE_REF_PREFIX } from "../core/guard.ts";
import { send } from "../core/http.ts";
import type { Masker } from "../core/mask.ts";
import type { Overlay } from "../core/overlay.ts";
import type { Run } from "../core/run.ts";
import type { Runtime } from "../core/runtime.ts";
import type { Secret } from "../core/secret.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** The longest provider error detail kept, counted after masking. */
const MAX_DETAIL = 400;

/** An object ID as Cloudflare writes them: 32 hex digits, or a UUID. */
export const OBJECT_ID =
  /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** The raw send. Not exported: only CloudflareWriter, in this module, can call it. */
const SEND = Symbol("cloudflare write");

interface Envelope<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
  result_info?: { page?: number; total_pages?: number };
}

type Query = Record<string, string | number | boolean>;
type WriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";

function withQuery(path: string, query?: Query): string {
  if (query === undefined) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, String(value));
  return `${path}?${params.toString()}`;
}

/**
 * A private value only one write's request carries (the rate rule's threshold), kept out of that
 * write's provider error. A short number is never registered with the masker: the masker runs over
 * every line and record, where such a number would rewrite the run's own numbers (a log seq, a
 * count, a timestamp) and show where it stood. Here only a provider's error text is touched.
 */
export interface Redaction {
  value: string;
  placeholder: string;
}

/** Options for one write. */
export interface WriteOptions {
  /** Values replaced in this write's provider error, before the cut (see Redaction). */
  redact?: readonly Redaction[];
}

/** Replaces each value where it stands as a token of its own (not inside a word or a number). */
function redacted(text: string, redact: readonly Redaction[]): string {
  let out = text;
  for (const { value, placeholder } of redact) {
    if (value === "") continue;
    const body = value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
    const token = new RegExp(
      `(?<![0-9A-Za-z_])(?<![0-9][.:-])${body}(?![0-9A-Za-z_])(?![.:-][0-9])`,
      "g",
    );
    out = out.replace(token, placeholder);
  }
  return out;
}

/**
 * A provider's text, masked (and redacted) first and only then cut, so no part of a private value
 * survives.
 */
export function maskedDetail(
  masker: Masker,
  text: string,
  max = MAX_DETAIL,
  redact: readonly Redaction[] = [],
): string {
  const masked = redacted(masker.mask(text), redact);
  return masked.length <= max ? masked : `${masked.slice(0, max)}...`;
}

/** A request path as an error may print it: no query, masked, and every object ID as `<id>`. */
export function printablePath(masker: Masker, path: string): string {
  return masker
    .mask(path.split("?")[0] ?? path)
    .split("/")
    .map((segment) => (OBJECT_ID.test(segment) ? "<id>" : segment))
    .join("/");
}

export class CloudflareApi {
  readonly #token: Secret;
  readonly #runtime: Pick<Runtime, "fetch" | "sleep">;
  readonly #masker: Masker;
  readonly #base: string;

  constructor(
    token: Secret,
    runtime: Pick<Runtime, "fetch" | "sleep">,
    masker: Masker,
    base = CLOUDFLARE_API,
  ) {
    this.#token = token;
    this.#runtime = runtime;
    this.#masker = masker;
    this.#base = base;
  }

  async #call<T>(
    method: "GET" | WriteMethod,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; envelope: Envelope<T> | undefined }> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token.reveal()}` };
    let payload: string | FormData | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await send(
      "cloudflare",
      {
        method,
        url: `${this.#base}${path}`,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        idempotent: method === "GET",
      },
      this.#runtime,
    );
    let envelope: Envelope<T> | undefined;
    try {
      envelope = JSON.parse(response.text) as Envelope<T>;
    } catch {
      envelope = undefined;
    }
    return { status: response.status, envelope };
  }

  #fail(
    method: string,
    path: string,
    status: number,
    envelope: Envelope<unknown> | undefined,
    redact: readonly Redaction[] = [],
  ): never {
    const errors = envelope?.errors ?? [];
    const codes = errors.map((e) => e.code ?? 0);
    const detail = maskedDetail(
      this.#masker,
      errors.map((e) => `${e.code ?? "?"} ${e.message ?? ""}`.trim()).join("; "),
      MAX_DETAIL,
      redact,
    );
    throw new ProviderError(
      "cloudflare",
      `cloudflare ${method} ${printablePath(this.#masker, path)} answered ${status}${
        detail === "" ? "" : `: ${detail}`
      }`,
      status,
      codes,
    );
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    const full = withQuery(path, query);
    const { status, envelope } = await this.#call<T>("GET", full);
    if (status >= 300 || envelope === undefined || envelope.success === false) {
      this.#fail("GET", full, status, envelope);
    }
    return envelope.result;
  }

  /** A read that answers undefined for a 404 (an object or phase entrypoint that does not exist). */
  async getOptional<T>(path: string, query?: Query): Promise<T | undefined> {
    const full = withQuery(path, query);
    const { status, envelope } = await this.#call<T>("GET", full);
    if (status === 404) return undefined;
    if (status >= 300 || envelope === undefined || envelope.success === false) {
      this.#fail("GET", full, status, envelope);
    }
    return envelope.result;
  }

  /** Reads every page of a list endpoint. */
  async list<T>(path: string, query: Query = {}): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const full = withQuery(path, { per_page: 50, ...query, page });
      const { status, envelope } = await this.#call<T[]>("GET", full);
      if (status >= 300 || envelope === undefined || envelope.success === false) {
        this.#fail("GET", full, status, envelope);
      }
      const result = Array.isArray(envelope.result) ? envelope.result : [];
      all.push(...result);
      const total = envelope.result_info?.total_pages;
      if (total === undefined || page >= total || result.length === 0) return all;
    }
    throw new ProviderError(
      "cloudflare",
      `cloudflare GET ${printablePath(this.#masker, path)}: more than 100 pages`,
      0,
    );
  }

  /** Sends a write. Keyed by a symbol this module keeps: only CloudflareWriter calls it. */
  async [SEND]<T>(
    method: WriteMethod,
    path: string,
    body: unknown,
    redact: readonly Redaction[],
  ): Promise<T> {
    const { status, envelope } = await this.#call<T>(method, path, body);
    if (status >= 300 || envelope === undefined || envelope.success === false) {
      this.#fail(method, path, status, envelope, redact);
    }
    return envelope.result;
  }
}

/**
 * What a write touches, for the guard. A write addressed to one object (any method but POST)
 * carries that object's `id` as it was read, with the name, pattern or ref it was read with.
 */
export type WriteTarget =
  | { kind: "dns"; name: string; id?: string }
  | { kind: "route"; pattern: string; id?: string }
  | { kind: "rule"; ref: string; hosts: readonly string[]; rulesetId: string; id?: string }
  | { kind: "ruleset"; phase: string; refs: readonly string[]; hosts: readonly string[] }
  | { kind: "setting"; id: string }
  | { kind: "access-app"; name: string; host: string; id?: string }
  | { kind: "access-policy"; name: string; id?: string }
  | { kind: "email-domain"; name: string; id?: string }
  | { kind: "tunnel"; name: string }
  | {
      kind: "token";
      name: string;
      permissionGroups: ReadonlyArray<{ name: string; id: string }>;
      id?: string;
    }
  | { kind: "script"; name: string };

/** Permission groups a token minted by `pnpm fin` may hold, by token kind. */
export const MINTABLE_PERMISSION_GROUPS: ReadonlySet<string> = new Set([
  "Email Sending Write",
  "Workers Scripts Write",
]);

/** Groups a token may hold only with a client IP filter (spec 01 §7.8: worker's static egress). */
const IP_FILTERED_GROUPS: ReadonlySet<string> = new Set(["Email Sending Write"]);

/** The record types `pnpm fin` writes: the tunnels' CNAMEs and the DMARC TXT records. */
const RECORD_TYPES: ReadonlySet<string> = new Set(["CNAME", "TXT"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lowerName(name: unknown): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

/** The host of a Workers route pattern (`<host>/<path>`). */
export function patternHost(pattern: string): string {
  return lowerName(pattern.replace(/^[a-z]+:\/\//i, "").split("/")[0]);
}

/** An Access domain without its scheme and without a trailing `/` or `/*`, lowercased. */
export function accessDomain(domain: string): string {
  return lowerName(domain.replace(/^[a-z]+:\/\//i, "").replace(/\/\*?$/, ""));
}

/** Every domain an Access application names: its domain, self-hosted domains and destinations. */
export function appDomains(app: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof app.domain === "string") out.push(app.domain);
  if (Array.isArray(app.self_hosted_domains)) {
    for (const d of app.self_hosted_domains) if (typeof d === "string") out.push(d);
  }
  if (Array.isArray(app.destinations)) {
    for (const d of app.destinations) {
      if (!isRecord(d)) continue;
      if (typeof d.uri === "string") out.push(d.uri);
      if (typeof d.hostname === "string") out.push(d.hostname);
    }
  }
  return out;
}

/** The hostnames a rule expression compares `http.host` with (`eq "x"` and `in {"x" "y"}`). */
export function expressionHosts(expression: string): string[] {
  const hosts: string[] = [];
  for (const m of expression.matchAll(/http\.host\s+(?:eq|==)\s+"([^"]*)"/g))
    hosts.push(m[1] ?? "");
  for (const m of expression.matchAll(/http\.host\s+in\s+\{([^}]*)\}/g)) {
    for (const q of (m[1] ?? "").matchAll(/"([^"]*)"/g)) hosts.push(q[1] ?? "");
  }
  return hosts.map(lowerName);
}

/** A host comparison that would widen a rule to hosts it does not name. */
const WIDENING_HOST_TEST =
  /not\s+http\.host|http\.host\s+(?:ne|!=|contains|matches|~|wildcard|strict)\b|lower\(\s*http\.host/;

export class CloudflareWriter {
  readonly #api: CloudflareApi;
  readonly #guard: Guard;
  readonly #run: Run;
  readonly #account: string;
  readonly #zone: string;
  readonly #settings: ReadonlySet<string>;

  constructor(
    api: CloudflareApi,
    guard: Guard,
    run: Run,
    overlay: Overlay,
    settings: Iterable<string> = [],
  ) {
    this.#api = api;
    this.#guard = guard;
    this.#run = run;
    this.#account = overlay.cloudflare.accountId;
    this.#zone = overlay.cloudflare.zoneId;
    this.#settings = new Set(settings);
  }

  /**
   * Checks a write without sending it: the guard on the target, the endpoint and the object it
   * names, and the body against the target. Context.applyPlan's preflight calls it for every
   * pending change before the run registers, and write() again just before it sends.
   */
  check(target: WriteTarget, method: WriteMethod, path: string, body?: unknown): void {
    const zone = `/zones/${this.#zone}`;
    const account = `/accounts/${this.#account}`;
    const refuse = (why: string): never => {
      throw new RefusedError(`${method} ${target.kind}: ${why}`);
    };
    const object = (): Record<string, unknown> => {
      if (!isRecord(body)) refuse("the write sends no body the writer can check");
      return body as Record<string, unknown>;
    };
    const noBody = (): void => {
      if (body !== undefined) refuse("a delete sends no body");
    };
    /** A POST goes to the collection; any other method to `<collection>/<the object's id>`. */
    const addressed = (collection: string, id: string | undefined, endpoint: string): void => {
      if (method === "POST") {
        if (path !== collection) refuse(`not ${endpoint}`);
        return;
      }
      if (!path.startsWith(`${collection}/`)) refuse(`not ${endpoint}`);
      if (id === undefined || !OBJECT_ID.test(id) || path !== `${collection}/${id}`) {
        refuse("the path is not the ID of the object it names, as that object was read");
      }
    };
    const bodyNames = (field: string, sent: unknown, want: string): void => {
      if (lowerName(sent) !== lowerName(want)) {
        refuse(`the body names ${field} ${String(sent)}, not the one the write is for`);
      }
    };

    if (path.includes("/rulesets") && method === "PUT") {
      refuse("a rule set is never replaced whole; rules are written one at a time");
    }
    switch (target.kind) {
      case "dns": {
        this.#guard.checkName(target.name, "dns record");
        addressed(`${zone}/dns_records`, target.id, "the zone's DNS records endpoint");
        if (method === "DELETE") {
          noBody();
          return;
        }
        const b = object();
        bodyNames("the record", b.name, target.name);
        if (!RECORD_TYPES.has(String(b.type)))
          refuse(`pnpm fin writes no ${String(b.type)} record`);
        return;
      }
      case "route": {
        // A stale route is deleted by its host alone, whatever its path (even `/api*`); a route
        // that is written must have the exact shape the guard allows.
        if (method === "DELETE") {
          this.#guard.checkName(patternHost(target.pattern), `route ${target.pattern}`);
        } else this.#guard.checkRoutePattern(target.pattern);
        addressed(`${zone}/workers/routes`, target.id, "the zone's Workers routes endpoint");
        if (method === "DELETE") {
          noBody();
          return;
        }
        const b = object();
        if (Object.keys(b).some((k) => k !== "pattern" && k !== "script")) {
          refuse("a route write sends only its pattern and its Worker");
        }
        if (b.pattern !== target.pattern) bodyNames("the pattern", b.pattern, target.pattern);
        if (b.script !== undefined && b.script !== null) {
          this.#guard.checkOwnName(String(b.script), "Workers script");
        }
        return;
      }
      case "rule": {
        if (method === "DELETE") {
          // A stale rule of Fin's is deleted by its prefix, whatever else its ref holds.
          if (!target.ref.startsWith(RULE_REF_PREFIX)) {
            refuse(`only rules whose ref starts with ${RULE_REF_PREFIX} are deleted`);
          }
        } else this.#guard.checkRuleRef(target.ref, "zone rule");
        for (const host of target.hosts) this.#guard.checkName(host, `zone rule ${target.ref}`);
        if (!OBJECT_ID.test(target.rulesetId)) refuse("not a per-rule endpoint");
        addressed(`${zone}/rulesets/${target.rulesetId}/rules`, target.id, "a per-rule endpoint");
        if (method === "DELETE") {
          noBody();
          return;
        }
        this.#checkRule(object(), target.ref, target.hosts, refuse);
        return;
      }
      case "ruleset": {
        if (method !== "POST" || path !== `${zone}/rulesets`) {
          refuse("a phase entrypoint is only ever created");
        }
        for (const ref of target.refs) this.#guard.checkRuleRef(ref, `phase ${target.phase}`);
        for (const host of target.hosts) this.#guard.checkName(host, `phase ${target.phase}`);
        const b = object();
        if (b.kind !== "zone" || b.phase !== target.phase) {
          refuse("a phase entrypoint is created for its own phase of this zone");
        }
        const rules = Array.isArray(b.rules) ? b.rules : [];
        if (rules.length === 0) refuse("a phase entrypoint is created with Fin's rules in it");
        for (const rule of rules) {
          const r = isRecord(rule) ? rule : {};
          const ref = String(r.ref ?? "");
          if (!target.refs.includes(ref))
            refuse(`the body holds rule ${ref}, which it does not declare`);
          this.#checkRule(r, ref, target.hosts, refuse);
        }
        return;
      }
      case "setting": {
        if (!this.#settings.has(target.id)) {
          refuse(`${target.id} is not a setting the public settings list`);
        }
        if (method !== "PATCH" || path !== `${zone}/settings/${target.id}`) {
          refuse("not the setting's endpoint");
        }
        const keys = Object.keys(object());
        if (keys.length !== 1 || keys[0] !== "value")
          refuse("a setting write sends only its value");
        return;
      }
      case "access-app": {
        this.#guard.checkOwnName(target.name, "Access application");
        this.#guard.checkName(target.host, "Access application");
        if (method === "DELETE") refuse("an Access application is never deleted by pnpm fin");
        addressed(`${account}/access/apps`, target.id, "the Access applications endpoint");
        const b = object();
        if (b.name !== target.name) bodyNames("the application", b.name, target.name);
        if (b.type !== "self_hosted") refuse("Fin's Access application is self-hosted");
        const domains = appDomains(b);
        if (domains.length === 0) refuse("an Access application names its domain");
        for (const domain of domains) {
          if (accessDomain(domain) !== lowerName(target.host)) {
            refuse(`the body names ${domain}, a domain other than the staff host (the whole host)`);
          }
        }
        if (b.options_preflight_bypass === true) refuse("OPTIONS is never let past Access");
        if (b.allow_authenticate_via_warp === true)
          refuse("a WARP session never stands in for the sign-in");
        if (b.cors_headers !== undefined && b.cors_headers !== null) {
          refuse("Access sends no CORS headers for Fin's application");
        }
        return;
      }
      case "access-policy": {
        this.#guard.checkOwnName(target.name, "Access policy");
        if (method === "DELETE") refuse("an Access policy is never deleted by pnpm fin");
        addressed(`${account}/access/policies`, target.id, "the Access policies endpoint");
        const b = object();
        if (b.name !== target.name) bodyNames("the policy", b.name, target.name);
        if (b.decision !== "allow") refuse("the policy's decision is allow, nothing else");
        const include = Array.isArray(b.include) ? b.include : [];
        const listed = (rule: unknown) => {
          const keys = isRecord(rule) ? Object.keys(rule) : [];
          return keys.length === 1 && (keys[0] === "email" || keys[0] === "email_domain");
        };
        if (include.length === 0 || !include.every(listed)) {
          refuse(
            "the policy includes only staff addresses and email domains, never Everyone or a bare login method",
          );
        }
        return;
      }
      case "email-domain": {
        this.#guard.checkName(target.name, "Email Sending domain");
        if (method === "DELETE")
          refuse("a sending domain is never removed by pnpm fin (DMARC first)");
        addressed(`${zone}/email/sending/subdomains`, target.id, "the Email Sending endpoint");
        const b = object();
        if (method === "POST") {
          if (Object.keys(b).join(",") !== "name") refuse("onboarding sends only the name");
          bodyNames("the sending domain", b.name, target.name);
          return;
        }
        for (const [key, value] of Object.entries(b)) {
          if (key !== "preview_enabled" && key !== "drop_suppressed_recipients") {
            refuse(`pnpm fin does not change a sending domain's ${key}`);
          }
          if (value !== false) refuse(`pnpm fin only turns a sending domain's ${key} off`);
        }
        return;
      }
      case "tunnel": {
        this.#guard.checkOwnName(target.name, "tunnel");
        if (method !== "POST" || path !== `${account}/cfd_tunnel`) {
          refuse("a tunnel is only ever created here");
        }
        const b = object();
        if (b.name !== target.name) bodyNames("the tunnel", b.name, target.name);
        if (b.config_src !== "local") refuse("a tunnel is locally managed (SP-04a)");
        return;
      }
      case "token": {
        this.#guard.checkOwnName(target.name, "API token");
        for (const group of target.permissionGroups) {
          if (!MINTABLE_PERMISSION_GROUPS.has(group.name)) {
            refuse(`the permission group ${group.name} is not mintable`);
          }
        }
        if (method === "PUT" || method === "PATCH")
          refuse("tokens are minted and revoked, never edited");
        addressed(`${account}/tokens`, target.id, "the account tokens endpoint");
        if (method === "DELETE") {
          noBody();
          return;
        }
        this.#checkToken(object(), target, refuse);
        return;
      }
      case "script": {
        this.#guard.checkOwnName(target.name, "Workers script");
        const base = `${account}/workers/scripts/${target.name}`;
        if (method === "DELETE") refuse("a Workers script is never deleted by pnpm fin");
        if (path === `${base}/subdomain`) {
          const b = object();
          if (
            method !== "POST" ||
            Object.keys(b).length !== 2 ||
            b.enabled !== false ||
            b.previews_enabled !== false
          ) {
            refuse("a static deployment keeps workers.dev and previews off");
          }
          return;
        }
        if (path === `${base}/assets-upload-session`) {
          if (method !== "POST") refuse("an upload session is only ever opened");
          object();
          return;
        }
        if (path !== base) refuse("not the script's own endpoint");
        if (method !== "PUT") refuse("a script is only ever uploaded whole");
        checkAssetsOnly(body, refuse);
        return;
      }
    }
  }

  /** A rule body: its ref is the target's, and its expression names hosts, all declared ones. */
  #checkRule(
    b: Record<string, unknown>,
    ref: string,
    hosts: readonly string[],
    refuse: (why: string) => never,
  ): void {
    if (b.ref !== ref) refuse(`the body names rule ${String(b.ref)}, not ${ref}`);
    const expression = typeof b.expression === "string" ? b.expression : "";
    if (WIDENING_HOST_TEST.test(expression)) {
      refuse(`rule ${ref}: a host test other than eq or in would reach hosts it does not name`);
    }
    const named = expressionHosts(expression);
    if (named.length === 0) {
      refuse(
        `rule ${ref}: the expression names no host; on a shared zone it would match every host`,
      );
    }
    const declared = new Set(hosts.map(lowerName));
    for (const host of named) {
      if (!declared.has(host))
        refuse(`rule ${ref}: the expression names a host the write does not declare`);
      this.#guard.checkName(host, `zone rule ${ref}`);
    }
  }

  /** A token mint: this account only, exactly the declared groups, and an IP filter where needed. */
  #checkToken(
    b: Record<string, unknown>,
    target: Extract<WriteTarget, { kind: "token" }>,
    refuse: (why: string) => never,
  ): void {
    if (b.name !== target.name)
      refuse(`the body names token ${String(b.name)}, not ${target.name}`);
    const policies = Array.isArray(b.policies) ? b.policies : [];
    if (policies.length === 0) refuse("a token holds one policy");
    const resource = `com.cloudflare.api.account.${this.#account}`;
    const sent = new Set<string>();
    for (const policy of policies) {
      const p = isRecord(policy) ? policy : {};
      const resources = isRecord(p.resources) ? p.resources : {};
      const keys = Object.keys(resources);
      if (
        p.effect !== "allow" ||
        keys.length !== 1 ||
        keys[0] !== resource ||
        resources[resource] !== "*"
      ) {
        refuse("a token is for this account only");
      }
      for (const group of Array.isArray(p.permission_groups) ? p.permission_groups : []) {
        sent.add(String(isRecord(group) ? group.id : ""));
      }
    }
    const declared = new Set(target.permissionGroups.map((g) => g.id));
    if (sent.size !== declared.size || [...sent].some((id) => !declared.has(id))) {
      refuse("the body's permission groups are not the ones the write declares");
    }
    if (target.permissionGroups.some((g) => IP_FILTERED_GROUPS.has(g.name))) {
      const condition = isRecord(b.condition) ? b.condition : {};
      const ip = isRecord(condition.request_ip) ? condition.request_ip : {};
      if (!Array.isArray(ip.in) || ip.in.length === 0) {
        refuse("this token is never minted without its client IP filter");
      }
    }
    if (typeof b.expires_on !== "string") refuse("a token is minted with an expiry");
  }

  async write<T>(
    target: WriteTarget,
    method: WriteMethod,
    path: string,
    body?: unknown,
    options: WriteOptions = {},
  ): Promise<T> {
    this.#run.assertWritable(`${method} ${target.kind}`);
    this.check(target, method, path, body);
    return this.#api[SEND]<T>(method, path, body, options.redact ?? []);
  }
}

/** An assets-only upload: one `metadata` part, with no module, no main module and no binding. */
function checkAssetsOnly(body: unknown, refuse: (why: string) => never): void {
  const why = "a script write is assets only: one metadata part, no module, no binding";
  if (!(body instanceof FormData)) refuse(why);
  const form = body as FormData;
  let metadata: unknown;
  for (const [name, value] of form.entries()) {
    if (name !== "metadata" || typeof value !== "string" || metadata !== undefined) refuse(why);
    try {
      metadata = JSON.parse(value as string);
    } catch {
      refuse(why);
    }
  }
  if (!isRecord(metadata)) refuse(why);
  const m = metadata as Record<string, unknown>;
  if (m.main_module !== undefined || m.body_part !== undefined) refuse(why);
  if (m.bindings !== undefined && !(Array.isArray(m.bindings) && m.bindings.length === 0))
    refuse(why);
  if (!isRecord(m.assets)) refuse(why);
}
