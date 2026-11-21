// A read-only Cloudflare API reader: GET only, plain fetch, one bearer token (the watcher's
// read-only token, CR-18). Lists are read page by page. Responses are memoised for the length of
// one run, so the checks can share the tunnel list and the zone ID.

export const API_BASE = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 50;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class CloudflareError extends Error {
  override readonly name = "CloudflareError";
  readonly status: number;
  /** Cloudflare's error codes, never its messages (they can echo names). */
  readonly codes: readonly number[];
  constructor(path: string, status: number, codes: readonly number[]) {
    super(`GET ${path} answered ${status}${codes.length > 0 ? ` (${codes.join(",")})` : ""}`);
    this.status = status;
    this.codes = codes;
  }
}

interface Envelope {
  success?: boolean;
  result?: unknown;
  errors?: { code?: number }[];
  result_info?: { page?: number; total_pages?: number };
}

export class CloudflareReader {
  readonly #token: string;
  readonly #fetch: Fetch;
  readonly #memo = new Map<string, Promise<unknown>>();

  constructor(token: string, fetchImpl: Fetch) {
    if (token === "" || /\s/.test(token)) throw new CloudflareError("(token)", 0, []);
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async #request(pathWithQuery: string): Promise<Envelope> {
    const response = await this.#fetch(`${API_BASE}${pathWithQuery}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.#token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
    let body: Envelope = {};
    try {
      body = (await response.json()) as Envelope;
    } catch {
      body = {};
    }
    const path = pathWithQuery.split("?")[0] ?? pathWithQuery;
    if (!response.ok || body.success === false) {
      const codes = (body.errors ?? []).map((e) => Number(e.code)).filter(Number.isFinite);
      throw new CloudflareError(path, response.status, codes);
    }
    return body;
  }

  /** One object (the `result`), or undefined when Cloudflare answers 404. */
  get(path: string): Promise<unknown> {
    const key = `get ${path}`;
    let pending = this.#memo.get(key);
    if (pending === undefined) {
      pending = this.#request(path).then(
        (b) => b.result,
        (error: unknown) => {
          if (error instanceof CloudflareError && error.status === 404) return undefined;
          throw error;
        },
      );
      this.#memo.set(key, pending);
    }
    return pending;
  }

  /** Every item of a list, across pages. */
  list(path: string, query: Readonly<Record<string, string>> = {}): Promise<unknown[]> {
    const key = `list ${path} ${JSON.stringify(query)}`;
    let pending = this.#memo.get(key) as Promise<unknown[]> | undefined;
    if (pending === undefined) {
      pending = (async () => {
        const out: unknown[] = [];
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const params = new URLSearchParams({ ...query, page: String(page), per_page: "50" });
          const body = await this.#request(`${path}?${params.toString()}`);
          const items = Array.isArray(body.result) ? body.result : [];
          out.push(...items);
          const total = body.result_info?.total_pages;
          if (typeof total !== "number" || page >= total || items.length === 0) return out;
        }
        throw new CloudflareError(path, 0, []);
      })();
      this.#memo.set(key, pending);
    }
    return pending;
  }
}
