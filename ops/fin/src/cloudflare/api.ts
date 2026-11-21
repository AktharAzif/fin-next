// Cloudflare's v4 API: reads, and the one guarded path for writes.
//
// CloudflareApi only reads. Every write goes through CloudflareWriter.write(), which, before it
// sends anything: refuses outside a registered run and in every dry run; checks the target with the
// allow-list guard (BD-11); checks that the path is the endpoint that kind of write may use and that
// it names the overlay's own account and zone; and refuses any PUT to a rule set (a whole-phase
// replace would remove another product's rules). Context.applyPlan records each change as a run
// step once its writes have succeeded.

import { ProviderError, RefusedError } from "../core/errors.ts";
import type { Guard } from "../core/guard.ts";
import { send } from "../core/http.ts";
import type { Overlay } from "../core/overlay.ts";
import type { Run } from "../core/run.ts";
import type { Runtime } from "../core/runtime.ts";
import type { Secret } from "../core/secret.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
  result_info?: { page?: number; total_pages?: number };
}

type Query = Record<string, string | number | boolean>;

function withQuery(path: string, query?: Query): string {
  if (query === undefined) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, String(value));
  return `${path}?${params.toString()}`;
}

export class CloudflareApi {
  readonly #token: Secret;
  readonly #runtime: Pick<Runtime, "fetch" | "sleep">;
  readonly #base: string;

  constructor(token: Secret, runtime: Pick<Runtime, "fetch" | "sleep">, base = CLOUDFLARE_API) {
    this.#token = token;
    this.#runtime = runtime;
    this.#base = base;
  }

  async #call<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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
  ): never {
    const errors = envelope?.errors ?? [];
    const codes = errors.map((e) => e.code ?? 0);
    const detail = errors
      .map((e) => `${e.code ?? "?"} ${e.message ?? ""}`.trim())
      .join("; ")
      .slice(0, 400);
    const where = path.split("?")[0] ?? path;
    throw new ProviderError(
      "cloudflare",
      `cloudflare ${method} ${where} answered ${status}${detail === "" ? "" : `: ${detail}`}`,
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
    throw new ProviderError("cloudflare", `cloudflare GET ${path}: more than 100 pages`, 0);
  }

  /** Sends a write. Only CloudflareWriter calls this. */
  async sendWrite<T>(
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { status, envelope } = await this.#call<T>(method, path, body);
    if (status >= 300 || envelope === undefined || envelope.success === false) {
      this.#fail(method, path, status, envelope);
    }
    return envelope.result;
  }
}

/** What a write touches, for the guard. */
export type WriteTarget =
  | { kind: "dns"; name: string }
  | { kind: "route"; pattern: string }
  | { kind: "rule"; ref: string; hosts: readonly string[] }
  | { kind: "ruleset"; phase: string; refs: readonly string[]; hosts: readonly string[] }
  | { kind: "setting"; id: string }
  | { kind: "access-app"; name: string; host: string }
  | { kind: "access-policy"; name: string }
  | { kind: "email-domain"; name: string }
  | { kind: "tunnel"; name: string }
  | { kind: "token"; name: string; permissionGroups: readonly string[] }
  | { kind: "script"; name: string };

const ID = "[A-Za-z0-9-]{1,64}";

/** Permission groups a token minted by `pnpm fin` may hold, by token kind. */
export const MINTABLE_PERMISSION_GROUPS: ReadonlySet<string> = new Set([
  "Email Sending Write",
  "Workers Scripts Write",
]);

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

  /** Checks a write without sending it: the guard, the endpoint and the method. */
  check(target: WriteTarget, method: "POST" | "PUT" | "PATCH" | "DELETE", path: string): void {
    const zone = `/zones/${this.#zone}`;
    const account = `/accounts/${this.#account}`;
    const endpoint = (pattern: string) => new RegExp(`^${pattern}$`).test(path);
    const refuse = (why: string): never => {
      throw new RefusedError(`${method} ${target.kind}: ${why}`);
    };
    if (path.includes("/rulesets") && method === "PUT") {
      refuse("a rule set is never replaced whole; rules are written one at a time");
    }
    switch (target.kind) {
      case "dns":
        this.#guard.checkName(target.name, "dns record");
        if (!endpoint(`${zone}/dns_records(/${ID})?`))
          refuse("not the zone's DNS records endpoint");
        break;
      case "route":
        this.#guard.checkRoutePattern(target.pattern);
        if (!endpoint(`${zone}/workers/routes(/${ID})?`))
          refuse("not the zone's Workers routes endpoint");
        break;
      case "rule":
        this.#guard.checkRuleRef(target.ref, "zone rule");
        for (const host of target.hosts) this.#guard.checkName(host, `zone rule ${target.ref}`);
        if (method === "POST" && !endpoint(`${zone}/rulesets/${ID}/rules`))
          refuse("not a per-rule endpoint");
        if (method !== "POST" && !endpoint(`${zone}/rulesets/${ID}/rules/${ID}`))
          refuse("not a per-rule endpoint");
        break;
      case "ruleset":
        if (method !== "POST" || !endpoint(`${zone}/rulesets`))
          refuse("a phase entrypoint is only ever created");
        for (const ref of target.refs) this.#guard.checkRuleRef(ref, `phase ${target.phase}`);
        for (const host of target.hosts) this.#guard.checkName(host, `phase ${target.phase}`);
        break;
      case "setting":
        if (!this.#settings.has(target.id))
          refuse(`${target.id} is not a setting the public settings list`);
        if (method !== "PATCH" || !endpoint(`${zone}/settings/${target.id}`))
          refuse("not the setting's endpoint");
        break;
      case "access-app":
        this.#guard.checkOwnName(target.name, "Access application");
        this.#guard.checkName(target.host, "Access application");
        if (method === "DELETE") refuse("an Access application is never deleted by pnpm fin");
        if (!endpoint(`${account}/access/apps(/${ID})?`))
          refuse("not the Access applications endpoint");
        break;
      case "access-policy":
        this.#guard.checkOwnName(target.name, "Access policy");
        if (method === "DELETE") refuse("an Access policy is never deleted by pnpm fin");
        if (!endpoint(`${account}/access/policies(/${ID})?`))
          refuse("not the Access policies endpoint");
        break;
      case "email-domain":
        this.#guard.checkName(target.name, "Email Sending domain");
        if (method === "DELETE")
          refuse("a sending domain is never removed by pnpm fin (DMARC first)");
        if (!endpoint(`${zone}/email/sending/subdomains(/${ID})?`))
          refuse("not the Email Sending endpoint");
        break;
      case "tunnel":
        this.#guard.checkOwnName(target.name, "tunnel");
        if (method !== "POST" || !endpoint(`${account}/cfd_tunnel`))
          refuse("a tunnel is only ever created here");
        break;
      case "token":
        this.#guard.checkOwnName(target.name, "API token");
        for (const group of target.permissionGroups) {
          if (!MINTABLE_PERMISSION_GROUPS.has(group))
            refuse(`the permission group ${group} is not mintable`);
        }
        if (method === "POST" && !endpoint(`${account}/tokens`))
          refuse("not the account tokens endpoint");
        if (method === "DELETE" && !endpoint(`${account}/tokens/${ID}`))
          refuse("not an account token");
        if (method === "PUT" || method === "PATCH")
          refuse("tokens are minted and revoked, never edited");
        break;
      case "script":
        this.#guard.checkOwnName(target.name, "Workers script");
        if (
          !endpoint(`${account}/workers/scripts/${target.name}(/subdomain|/assets-upload-session)?`)
        ) {
          refuse("not the script's own endpoint");
        }
        break;
    }
  }

  async write<T>(
    target: WriteTarget,
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    this.#run.assertWritable(`${method} ${target.kind}`);
    this.check(target, method, path);
    return this.#api.sendWrite<T>(method, path, body);
  }
}
