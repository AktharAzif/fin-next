// Cloudflare's v4 API: reads, and the one guarded path for writes.
//
// CloudflareApi only reads in public. Its raw send is keyed by a symbol this module keeps, so only
// CloudflareWriter.write() can send a write. CloudflareApi also keeps, privately, every object its
// reads and write answers showed (by collection and ID, with its name, pattern or ref), so the
// writer can tie the IDs a write carries to objects as Cloudflare showed them, not to the caller's
// label. Before it sends anything, write() refuses outside a registered run and in every dry run,
// and check() refuses unless all of these hold (BD-11, EX-27):
//
//   - the target passes the allow-list guard (hostnames, rule refs, Fin's own names);
//   - the path is the one endpoint that kind of write may use, on the overlay's own account and
//     zone: a POST goes to the collection itself (never a bulk endpoint such as `dns_records/batch`),
//     and any other method to `<collection>/<id>`, where `<id>` was read in that collection under
//     the target's name, pattern or ref, so a write cannot change an object other than the one it
//     names; a rule is written only into a rule set read (or created) as a phase entrypoint;
//   - the body names what the target names: a record's name, a route's pattern, a rule's ref and
//     the hostnames in its expression, every domain of an Access application;
//   - every ID the body carries was read: a CNAME's tunnel (one of Fin's own), an Access
//     application's one policy (read or created under the policy's name) and its login methods
//     (read as the type the public settings name), a token's permission groups (read under the
//     names they are declared with);
//   - a token is for this account only, its client IP filter (required for the groups that need
//     it) holds single IPv4 addresses of the token's own service (the one the public settings tie
//     it to): that service's static egress addresses when the overlay lists them, and otherwise
//     (read back from Railway) single addresses alone; and it expires within MAX_TOKEN_DAYS;
//   - no PUT replaces a rule set (a whole-phase replace would remove another product's rules).
//
// The body checks read the request the writer is about to send, not a label beside it. They are a
// lint against mistakes, not a parser: a deliberately obfuscated expression is a review finding.
//
// A provider's error names neither a private value nor an object ID: its text is masked before it
// is cut (a value cut in two would no longer match the masker), a value only one write carries (the
// rate rule's threshold, a short number the masker must never hold) is redacted from that write's
// error alone, and every ID-shaped segment of the path is replaced by `<id>` (spec 01 §9.2: names,
// never IDs). Context.applyPlan records each change as a run step once its writes have succeeded.

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

/** The objects reads showed. Not exported: only CloudflareWriter, in this module, looks. */
const SEEN = Symbol("cloudflare reads");

/**
 * A path whose answer is one whole rule set: a phase entrypoint (group 2 names the phase), the
 * rule sets collection (a create), or one rule of a set (a rule's create, update or delete answers
 * the whole set). Group 1 is the zone's rule sets collection.
 */
const RULESET_ANSWER =
  /^(\/zones\/[^/]+\/rulesets)(?:\/phases\/([a-z_]+)\/entrypoint|\/([0-9a-fA-F]{32})\/rules(?:\/[0-9a-fA-F]{32})?)?$/;

/** Where the phase entrypoints read or created are kept, by rule set ID, under a zone. */
function entrypointsOf(zonePath: string): string {
  return `${zonePath}/rulesets/phases`;
}

/** The longest a token pnpm fin mints may live (spec 01 §7.8: at most 180 days). */
export const MAX_TOKEN_DAYS = 180;

const DAY_MS = 86_400_000;

/** One IPv4 address. */
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** A tunnel's CNAME target: `<tunnel ID>.cfargotunnel.com`. */
const TUNNEL_TARGET =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.cfargotunnel\.com$/i;

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
  /** Every object a read or a write's answer showed: collection path, then ID (or tag). */
  readonly #seen = new Map<string, Map<string, Readonly<Record<string, unknown>>>>();

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

  #keep(collection: string, id: unknown, object: Record<string, unknown>): void {
    if (typeof id !== "string" || id === "") return;
    let objects = this.#seen.get(collection);
    if (objects === undefined) {
      objects = new Map();
      this.#seen.set(collection, objects);
    }
    objects.set(id, Object.freeze(structuredClone(object)));
  }

  /**
   * Keeps what an answer showed, so the writer can tie a write's IDs to objects as read: each
   * object under the collection it was read from (by `id`, and by `tag` where it has one); a rule
   * set's rules under `<sets>/<set id>/rules`, replacing the earlier ones (the answer is the set as
   * it stands); a phase entrypoint, read as one or created, under entrypointsOf(); and a deleted
   * object is forgotten.
   */
  #remember(method: "GET" | WriteMethod, path: string, result: unknown): void {
    const bare = path.split("?")[0] ?? path;
    const set = RULESET_ANSWER.exec(bare);
    if (set !== null) {
      if (!isRecord(result) || typeof result.id !== "string") return;
      const [, sets = "", phase, setId] = set;
      const entrypoints = `${sets}/phases`;
      if (phase !== undefined) this.#keep(entrypoints, result.id, { ...result, phase });
      else if (setId === undefined && method === "POST") this.#keep(entrypoints, result.id, result);
      const rules = `${sets}/${result.id}/rules`;
      this.#seen.delete(rules);
      for (const rule of Array.isArray(result.rules) ? result.rules : []) {
        if (isRecord(rule)) this.#keep(rules, rule.id, rule);
      }
      return;
    }
    if (method === "DELETE") {
      const id = bare.slice(bare.lastIndexOf("/") + 1);
      this.#seen.get(bare.slice(0, bare.lastIndexOf("/")))?.delete(id);
      return;
    }
    for (const item of Array.isArray(result) ? result : [result]) {
      if (!isRecord(item)) continue;
      for (const id of [item.id, item.tag]) {
        if (typeof id !== "string" || id === "") continue;
        this.#keep(bare.endsWith(`/${id}`) ? bare.slice(0, -(id.length + 1)) : bare, id, item);
      }
    }
  }

  /** The object a read or a write's answer showed in `collection` under `id`, if any. */
  [SEEN](collection: string, id: string): Readonly<Record<string, unknown>> | undefined {
    return this.#seen.get(collection)?.get(id);
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    const full = withQuery(path, query);
    const { status, envelope } = await this.#call<T>("GET", full);
    if (status >= 300 || envelope === undefined || envelope.success === false) {
      this.#fail("GET", full, status, envelope);
    }
    this.#remember("GET", full, envelope.result);
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
    this.#remember("GET", full, envelope.result);
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
      this.#remember("GET", path, result);
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
    this.#remember(method, path, envelope.result);
    return envelope.result;
  }
}

/**
 * What a write touches, for the guard. A write addressed to one object (any method but POST)
 * carries that object's `id`, which the writer accepts only when a read showed it in the write's
 * collection under the same name, pattern or ref.
 */
export type WriteTarget =
  | { kind: "dns"; name: string; id?: string }
  | { kind: "route"; pattern: string; id?: string }
  | { kind: "rule"; ref: string; hosts: readonly string[]; rulesetId: string; id?: string }
  | { kind: "ruleset"; phase: string; refs: readonly string[]; hosts: readonly string[] }
  | { kind: "setting"; id: string }
  | {
      kind: "access-app";
      name: string;
      host: string;
      /** The name of the one Access policy the application holds. */
      policy: string;
      id?: string;
    }
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

export interface WriterOptions {
  /** The zone settings the public settings list: the only ones a write may change. */
  settings?: Iterable<string>;
  /** The run's clock (a token's expiry is bounded from it). */
  now: () => Date;
  /**
   * The Railway service each token's client IP filter belongs to, by token name (from the public
   * settings). A token without one is never minted with a filter.
   */
  tokenServices?: Readonly<Record<string, string>>;
  /** The type of the one login method Fin's Access application allows (from the public settings). */
  identityProvider?: string;
}

type Seen = Readonly<Record<string, unknown>>;

export class CloudflareWriter {
  readonly #api: CloudflareApi;
  readonly #guard: Guard;
  readonly #run: Run;
  readonly #account: string;
  readonly #zone: string;
  readonly #settings: ReadonlySet<string>;
  readonly #now: () => Date;
  /** The static egress addresses the overlay lists, by service. */
  readonly #egress: ReadonlyMap<string, readonly string[]>;
  /** The service each token's client IP filter belongs to, by token name. */
  readonly #tokenServices: ReadonlyMap<string, string>;
  /** The login method type Fin's Access application allows. */
  readonly #identityProvider: string | undefined;
  /** Objects a checked (not yet sent) POST will create, as `<kind>:<name>`, for check() alone. */
  readonly #planned = new Set<string>();

  constructor(
    api: CloudflareApi,
    guard: Guard,
    run: Run,
    overlay: Overlay,
    options: WriterOptions,
  ) {
    this.#api = api;
    this.#guard = guard;
    this.#run = run;
    this.#account = overlay.cloudflare.accountId;
    this.#zone = overlay.cloudflare.zoneId;
    this.#settings = new Set(options.settings ?? []);
    this.#now = options.now;
    this.#egress = new Map(Object.entries(overlay.staticEgress));
    this.#tokenServices = new Map(Object.entries(options.tokenServices ?? {}));
    this.#identityProvider = options.identityProvider;
  }

  /** The object a read (or a write's answer) showed in `collection` under `id`. */
  #seen(collection: string, id: unknown): Seen | undefined {
    return typeof id === "string" && id !== "" ? this.#api[SEEN](collection, id) : undefined;
  }

  /** Whether a name read from Cloudflare is one Fin gives its own objects. */
  #ownName(name: unknown): boolean {
    try {
      this.#guard.checkOwnName(String(name ?? ""), "object");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Checks a write without sending it: the guard on the target, the endpoint and the object it
   * names, and the body against the target and the objects read. Context.applyPlan's preflight
   * calls it for every pending change before the run registers, and write() again, strictly, just
   * before it sends.
   */
  check(target: WriteTarget, method: WriteMethod, path: string, body?: unknown): void {
    this.#check(target, method, path, body, false);
  }

  /**
   * `sending` is false in the preflight: there, and only there, an Access application may name the
   * policy a POST checked just before will create (its ID is not known until that POST answers;
   * write() checks the application again with the ID it answered).
   */
  #check(
    target: WriteTarget,
    method: WriteMethod,
    path: string,
    body: unknown,
    sending: boolean,
  ): void {
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
    /**
     * A POST goes to the collection; any other method to `<collection>/<id>`, where `<id>` was read
     * in that collection as the object the target names (`readAs` compares its name, pattern or
     * ref with the target's).
     */
    const addressed = (
      collection: string,
      id: string | undefined,
      endpoint: string,
      readAs: (seen: Seen) => boolean,
    ): void => {
      if (method === "POST") {
        if (path !== collection) refuse(`not ${endpoint}`);
        return;
      }
      if (!path.startsWith(`${collection}/`)) refuse(`not ${endpoint}`);
      if (id === undefined || !OBJECT_ID.test(id) || path !== `${collection}/${id}`) {
        refuse("the path is not the ID of the object it names, as that object was read");
      }
      const seen = this.#seen(collection, id);
      if (seen === undefined || !readAs(seen)) {
        refuse("the ID was not read as the object the write names");
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
        addressed(
          `${zone}/dns_records`,
          target.id,
          "the zone's DNS records endpoint",
          (seen) => lowerName(seen.name) === lowerName(target.name),
        );
        if (method === "DELETE") {
          noBody();
          return;
        }
        const b = object();
        bodyNames("the record", b.name, target.name);
        if (!RECORD_TYPES.has(String(b.type)))
          refuse(`pnpm fin writes no ${String(b.type)} record`);
        if (b.type === "CNAME") {
          // A host's record points at one of Fin's own tunnels, as read, and is proxied.
          const tunnel = this.#seen(
            `${account}/cfd_tunnel`,
            TUNNEL_TARGET.exec(String(b.content ?? ""))?.[1],
          );
          if (tunnel === undefined || !this.#ownName(tunnel.name) || tunnel.deleted_at) {
            refuse("a CNAME points only at one of Fin's own tunnels, as read");
          }
          if (b.proxied !== true) refuse("a tunnel's CNAME is proxied");
        } else if (
          !lowerName(target.name).startsWith("_dmarc.") ||
          !String(b.content ?? "").startsWith("v=DMARC1;")
        ) {
          refuse("a TXT record is only a sending subdomain's own DMARC record");
        }
        return;
      }
      case "route": {
        // A stale route is deleted by its host alone, whatever its path (even `/api*`); a route
        // that is written must have the exact shape the guard allows.
        if (method === "DELETE") {
          this.#guard.checkName(patternHost(target.pattern), `route ${target.pattern}`);
        } else this.#guard.checkRoutePattern(target.pattern);
        addressed(
          `${zone}/workers/routes`,
          target.id,
          "the zone's Workers routes endpoint",
          (seen) => seen.pattern === target.pattern,
        );
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
        if (this.#seen(entrypointsOf(zone), target.rulesetId) === undefined) {
          refuse("the rule set was not read (or created) as one of this zone's phase entrypoints");
        }
        addressed(
          `${zone}/rulesets/${target.rulesetId}/rules`,
          target.id,
          "a per-rule endpoint",
          (seen) => seen.ref === target.ref,
        );
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
        this.#guard.checkOwnName(target.policy, "Access policy");
        if (method === "DELETE") refuse("an Access application is never deleted by pnpm fin");
        addressed(
          `${account}/access/apps`,
          target.id,
          "the Access applications endpoint",
          (seen) => seen.name === target.name,
        );
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
        // Exactly one policy, the one read (or created) under the policy's name: any other
        // policy attached here (an Everyone allow, a bypass) would open the application.
        const policies = Array.isArray(b.policies) ? b.policies : [];
        const attached =
          policies.length === 1 && isRecord(policies[0]) ? policies[0].id : undefined;
        const policy = this.#seen(`${account}/access/policies`, attached);
        const planned =
          !sending && attached === "" && this.#planned.has(`access-policy:${target.policy}`);
        if (!planned && (policy === undefined || policy.name !== target.policy)) {
          refuse(`the application holds exactly one policy, ${target.policy}, as read`);
        }
        // Only login methods read from this account as the type the public settings name (an empty
        // list would allow every method; the shared account also holds another product's).
        const idps = Array.isArray(b.allowed_idps) ? b.allowed_idps : [];
        const loginType = this.#identityProvider;
        if (
          loginType === undefined ||
          idps.length === 0 ||
          idps.some(
            (idp) => this.#seen(`${account}/access/identity_providers`, idp)?.type !== loginType,
          )
        ) {
          refuse(
            `the application allows only login methods read from this account as ${loginType ?? "the configured type"}`,
          );
        }
        return;
      }
      case "access-policy": {
        this.#guard.checkOwnName(target.name, "Access policy");
        if (method === "DELETE") refuse("an Access policy is never deleted by pnpm fin");
        addressed(
          `${account}/access/policies`,
          target.id,
          "the Access policies endpoint",
          (seen) => seen.name === target.name,
        );
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
        if (method === "POST" && !sending) this.#planned.add(`access-policy:${target.name}`);
        return;
      }
      case "email-domain": {
        this.#guard.checkName(target.name, "Email Sending domain");
        if (method === "DELETE")
          refuse("a sending domain is never removed by pnpm fin (DMARC first)");
        addressed(
          `${zone}/email/sending/subdomains`,
          target.id,
          "the Email Sending endpoint",
          (seen) => lowerName(seen.name) === lowerName(target.name),
        );
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
        addressed(
          `${account}/tokens`,
          target.id,
          "the account tokens endpoint",
          (seen) => seen.name === target.name,
        );
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

  /**
   * A token mint: this account only; exactly the declared groups, each read from the account's
   * permission groups under the name it is declared with (so a group's name, which decides whether
   * the IP filter is required, is Cloudflare's, not a label); a client IP filter, required where
   * the group needs it, of single IPv4 addresses of the token's own service (the public settings
   * tie each token to one): the overlay's `staticEgress.<service>` when it lists that service, and
   * otherwise single addresses alone, as the command reads them back from Railway (another
   * service's addresses never stand in for the token's own); and an expiry within MAX_TOKEN_DAYS
   * of now.
   */
  #checkToken(
    b: Record<string, unknown>,
    target: Extract<WriteTarget, { kind: "token" }>,
    refuse: (why: string) => never,
  ): void {
    const groups = `/accounts/${this.#account}/tokens/permission_groups`;
    for (const group of target.permissionGroups) {
      if (this.#seen(groups, group.id)?.name !== group.name) {
        refuse(`the permission group ${group.name} is not the one read under that name`);
      }
    }
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
    if (b.condition !== undefined) {
      const condition = isRecord(b.condition) ? b.condition : {};
      const ip = isRecord(condition.request_ip) ? condition.request_ip : {};
      if (Object.keys(condition).join(",") !== "request_ip" || Object.keys(ip).join(",") !== "in") {
        refuse("a token's only condition is its client IP filter (request_ip.in)");
      }
      const entries = Array.isArray(ip.in) ? ip.in : [];
      if (entries.length === 0) refuse("a client IP filter lists at least one address");
      const service = this.#tokenServices.get(target.name);
      if (service === undefined) {
        refuse(
          "a client IP filter is the static egress of the token's own service, and the public settings tie this token to no service",
        );
      }
      // Only the token's own service's addresses; none listed means they were read back from
      // Railway, so single addresses alone are checked here.
      const listed = this.#egress.get(service) ?? [];
      for (const entry of entries) {
        const address = /^(.+)\/32$/.exec(String(entry))?.[1] ?? "";
        if (!IPV4.test(address)) {
          refuse("each client IP filter entry is one IPv4 address (/32), never a range");
        }
        if (listed.length > 0 && !listed.includes(address)) {
          refuse(
            `each client IP filter entry is one of ${service}'s static egress addresses (the overlay's staticEgress.${service})`,
          );
        }
      }
    } else if (target.permissionGroups.some((g) => IP_FILTERED_GROUPS.has(g.name))) {
      refuse("this token is never minted without its client IP filter");
    }
    const now = this.#now().getTime();
    const expires = typeof b.expires_on === "string" ? Date.parse(b.expires_on) : Number.NaN;
    if (!Number.isFinite(expires)) refuse("a token is minted with an expiry");
    if (expires <= now || expires > now + MAX_TOKEN_DAYS * DAY_MS) {
      refuse(`a token is minted to expire within ${MAX_TOKEN_DAYS} days`);
    }
    if (b.not_before !== undefined) {
      const notBefore = Date.parse(String(b.not_before));
      if (!Number.isFinite(notBefore) || notBefore >= expires) {
        refuse("a token's not_before comes before its expiry");
      }
    }
  }

  async write<T>(
    target: WriteTarget,
    method: WriteMethod,
    path: string,
    body?: unknown,
    options: WriteOptions = {},
  ): Promise<T> {
    this.#run.assertWritable(`${method} ${target.kind}`);
    this.#check(target, method, path, body, true);
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
