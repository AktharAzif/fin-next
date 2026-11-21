// A small client for Better Stack's APIs (Node built-ins and fetch only). Endpoints as Better
// Stack's API reference gave them on 21 Nov 2026:
//   Telemetry  https://telemetry.betterstack.com  sources (v3), metrics, explorations and alerts (v2)
//   Errors     https://errors.betterstack.com     applications (v3)
//   Uptime     https://incidents.betterstack.com  monitors, heartbeats, urgencies (v2), policies (v3)
// Every response is JSON:API ({ data: { id, type, attributes } }), and lists are paginated with
// `pagination.next`. A team token per product authenticates (spec 01 §8.1): the Telemetry token
// also serves Errors.
//
// Nothing here prints. Errors carry the method, the path, the status and Better Stack's own error
// strings, never a request body, a header or a token.

export const HOSTS = {
  telemetry: "https://telemetry.betterstack.com",
  errors: "https://errors.betterstack.com",
  uptime: "https://incidents.betterstack.com",
} as const;

export type Product = keyof typeof HOSTS;

export const PATHS = {
  sources: "/api/v3/sources",
  metrics: (sourceId: string) => `/api/v2/sources/${encodeURIComponent(sourceId)}/metrics`,
  explorations: "/api/v2/explorations",
  explorationAlerts: (explorationId: string) =>
    `/api/v2/explorations/${encodeURIComponent(explorationId)}/alerts`,
  alerts: "/api/v2/alerts",
  applications: "/api/v3/applications",
  urgencies: "/api/v2/urgencies",
  policies: "/api/v3/policies",
  monitors: "/api/v2/monitors",
  heartbeats: "/api/v2/heartbeats",
} as const;

export interface Resource {
  readonly id: string;
  readonly type?: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export class BetterStackError extends Error {
  override readonly name = "BetterStackError";
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 20_000;
const MAX_PAGES = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Better Stack's error strings from a failed response, without echoing any submitted value. */
function errorText(body: unknown): string {
  if (!isRecord(body)) return "";
  const parts: string[] = [];
  const errors = body.errors;
  if (typeof errors === "string") parts.push(errors);
  if (Array.isArray(errors)) {
    for (const e of errors) parts.push(typeof e === "string" ? e : JSON.stringify(e));
  }
  if (isRecord(errors)) {
    for (const [key, value] of Object.entries(errors)) parts.push(`${key}: ${String(value)}`);
  }
  if (Array.isArray(body.invalid_attributes)) {
    parts.push(`invalid: ${body.invalid_attributes.map(String).join(", ")}`);
  }
  return parts.join("; ").slice(0, 400);
}

function toResource(value: unknown): Resource {
  if (!isRecord(value) || (typeof value.id !== "string" && typeof value.id !== "number")) {
    throw new BetterStackError("a response item without an id", 0);
  }
  return {
    id: String(value.id),
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    attributes: isRecord(value.attributes) ? value.attributes : {},
  };
}

export class BetterStackClient {
  readonly #token: string;
  readonly #fetch: Fetch;
  readonly #base: string;

  constructor(product: Product, token: string, fetchImpl: Fetch = fetch) {
    if (token.trim() === "" || /\s/.test(token.trim())) {
      throw new BetterStackError(`the ${product} token is empty or malformed`, 0);
    }
    this.#token = token.trim();
    this.#fetch = fetchImpl;
    this.#base = HOSTS[product];
  }

  async #send(method: string, url: string, body?: unknown): Promise<unknown> {
    const parsed = new URL(url);
    if (parsed.origin !== this.#base) {
      // Never send the token to another origin, whatever a pagination link says.
      throw new BetterStackError(
        `refused to call another origin (${method} ${parsed.pathname})`,
        0,
      );
    }
    const attempt = async (): Promise<Response> =>
      this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    let response = await attempt();
    if (method === "GET" && (response.status === 429 || response.status >= 500)) {
      response = await attempt();
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const detail = errorText(json);
      throw new BetterStackError(
        `${method} ${parsed.pathname} answered ${response.status}${detail === "" ? "" : `: ${detail}`}`,
        response.status,
      );
    }
    return json;
  }

  /** Every item of a paginated list. */
  async list(path: string): Promise<Resource[]> {
    const out: Resource[] = [];
    let url: string | null = `${this.#base}${path}${path.includes("?") ? "&" : "?"}per_page=250`;
    for (let page = 0; url !== null; page += 1) {
      if (page >= MAX_PAGES) throw new BetterStackError(`GET ${path}: too many pages`, 0);
      const body = await this.#send("GET", url);
      if (!isRecord(body) || !Array.isArray(body.data)) {
        throw new BetterStackError(`GET ${path}: not a list`, 0);
      }
      for (const item of body.data) out.push(toResource(item));
      const pagination = isRecord(body.pagination) ? body.pagination : {};
      url = typeof pagination.next === "string" && pagination.next !== "" ? pagination.next : null;
    }
    return out;
  }

  async get(path: string): Promise<Resource> {
    const body = await this.#send("GET", `${this.#base}${path}`);
    return toResource(isRecord(body) ? body.data : undefined);
  }

  async create(path: string, attributes: unknown): Promise<Resource> {
    const body = await this.#send("POST", `${this.#base}${path}`, attributes);
    return toResource(isRecord(body) ? body.data : undefined);
  }

  async update(path: string, attributes: unknown): Promise<Resource | undefined> {
    const body = await this.#send("PATCH", `${this.#base}${path}`, attributes);
    return isRecord(body) && body.data !== undefined ? toResource(body.data) : undefined;
  }

  async remove(path: string): Promise<void> {
    await this.#send("DELETE", `${this.#base}${path}`);
  }
}
