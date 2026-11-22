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
// strings, never a request body, a header or a token. A call that gets no answer (a dropped
// connection, the timeout) is a BetterStackError too, with status 0; a read is tried twice.
//
// A client made without a token sends no Authorization header: its fetch authenticates each call
// itself. That is how `pnpm fin monitoring apply` runs this code (apply-cli.ts): pnpm fin holds the
// team tokens and adds the right one to each call it forwards, so they never reach this process.

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

const PATH_WORDS = new Set([
  "api",
  "v1",
  "v2",
  "v3",
  "sources",
  "metrics",
  "explorations",
  "alerts",
  "applications",
  "urgencies",
  "policies",
  "monitors",
  "heartbeats",
]);

/** A path with every object ID replaced by `<id>`, so an error never prints an identifier. */
export function redactPath(path: string): string {
  return (
    path
      .split("?")[0]
      ?.split("/")
      .map((part) => (part === "" || PATH_WORDS.has(part) ? part : "<id>"))
      .join("/") ?? ""
  );
}

/** How much of Better Stack's error text an error keeps, in whole parts. */
const ERROR_TEXT_BUDGET = 2000;

/**
 * Better Stack's error strings from a failed response. They can echo a submitted value (a URL with
 * its hostname), so nothing here cuts one: each part is kept whole or left out, and the caller
 * masks the text before it shortens it for printing.
 */
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
  const kept: string[] = [];
  let length = 0;
  for (const part of parts) {
    if (length + part.length > ERROR_TEXT_BUDGET) {
      kept.push(`(${parts.length - kept.length} more not shown)`);
      break;
    }
    kept.push(part);
    length += part.length + 2;
  }
  return kept.join("; ");
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
  /** The team token, or undefined when the fetch authenticates every call itself. */
  readonly #token: string | undefined;
  readonly #fetch: Fetch;
  readonly #base: string;

  constructor(product: Product, token: string | undefined, fetchImpl: Fetch = fetch) {
    if (token !== undefined && (token.trim() === "" || /\s/.test(token.trim()))) {
      throw new BetterStackError(`the ${product} token is empty or malformed`, 0);
    }
    this.#token = token?.trim();
    this.#fetch = fetchImpl;
    this.#base = HOSTS[product];
  }

  async #send(method: string, url: string, body?: unknown): Promise<unknown> {
    const parsed = new URL(url);
    const where = `${method} ${redactPath(parsed.pathname)}`;
    if (parsed.origin !== this.#base) {
      // Never send the token to another origin, whatever a pagination link says.
      throw new BetterStackError(`refused to call another origin (${where})`, 0);
    }
    // A dropped connection or the timeout becomes a BetterStackError like any refusal, so the
    // apply stops the same way (and delivers what it made). Its own text is never kept: it can
    // name the URL, which holds IDs.
    const noAnswer = (error: unknown) =>
      new BetterStackError(
        `${where} ${isRecord(error) && error.name === "TimeoutError" ? "timed out" : "got no answer"}`,
        0,
      );
    const attempt = async (): Promise<Response | BetterStackError> => {
      try {
        return await this.#fetch(url, {
          method,
          headers: {
            ...(this.#token === undefined ? {} : { Authorization: `Bearer ${this.#token}` }),
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: "error",
        });
      } catch (error) {
        return noAnswer(error);
      }
    };
    // A read is tried twice; a write never is, since one that got no answer may have been made.
    let response = await attempt();
    if (
      method === "GET" &&
      (response instanceof BetterStackError || response.status === 429 || response.status >= 500)
    ) {
      response = await attempt();
    }
    if (response instanceof BetterStackError) throw response;
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw noAnswer(error);
    }
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const detail = errorText(json);
      throw new BetterStackError(
        `${where} answered ${response.status}${detail === "" ? "" : `: ${detail}`}`,
        response.status,
      );
    }
    return json;
  }

  /**
   * Every item of a paginated list. The list ends only where a page says so (`pagination.next`
   * null): an answer without its pagination, or a next link that comes back, fails the read, so
   * the plan is never made from part of a list.
   */
  async list(path: string): Promise<Resource[]> {
    const out: Resource[] = [];
    const where = `GET ${redactPath(path)}`;
    const visited = new Set<string>();
    let url: string | null = `${this.#base}${path}${path.includes("?") ? "&" : "?"}per_page=250`;
    for (let page = 0; url !== null; page += 1) {
      if (page >= MAX_PAGES) throw new BetterStackError(`${where}: too many pages`, 0);
      visited.add(url);
      const body = await this.#send("GET", url);
      if (!isRecord(body) || !Array.isArray(body.data)) {
        throw new BetterStackError(`${where}: not a list`, 0);
      }
      for (const item of body.data) out.push(toResource(item));
      const next = isRecord(body.pagination) ? body.pagination.next : undefined;
      if (next === null || next === "") url = null;
      else if (typeof next !== "string") {
        throw new BetterStackError(`${where}: a page that does not say where the list ends`, 0);
      } else if (visited.has(next)) {
        throw new BetterStackError(`${where}: a next page that comes back`, 0);
      } else url = next;
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
