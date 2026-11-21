// A read-only Cloudflare API reader: GET only, plain fetch, one bearer token (the watcher's
// read-only token, CR-18). Lists are read page by page. Responses are memoised for the length of
// one run, so the checks can share the tunnel list and the zone ID.
//
// Cloudflare's lists page in different ways: page numbers with `total_pages`, page numbers with
// only `total_count`, a cursor, or no `result_info` at all. A list is read to its end whichever it
// is, and a read that cannot reach the end fails, so a "nothing extra" check never passes on the
// first page alone.

export const API_BASE = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 50;
const PER_PAGE = 50;

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
  result_info?: {
    page?: number;
    per_page?: number;
    total_pages?: number;
    total_count?: number;
    cursor?: string;
    cursors?: { after?: string };
  };
}

/** The next cursor of a cursor-paged list ("" at its end), or undefined if it pages otherwise. */
function nextCursor(info: Envelope["result_info"]): string | undefined {
  if (typeof info?.cursor === "string") return info.cursor;
  if (typeof info?.cursors?.after === "string") return info.cursors.after;
  return undefined;
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

  /** Every item of a list, across pages. Fails when the end of the list cannot be reached. */
  list(path: string, query: Readonly<Record<string, string>> = {}): Promise<unknown[]> {
    const key = `list ${path} ${JSON.stringify(query)}`;
    let pending = this.#memo.get(key) as Promise<unknown[]> | undefined;
    if (pending === undefined) {
      pending = (async () => {
        const out: unknown[] = [];
        const seen = new Set<string>();
        const ended = () => new CloudflareError(path, 0, []);
        let cursor: string | undefined;
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const params = new URLSearchParams({ ...query, per_page: String(PER_PAGE) });
          if (cursor === undefined) params.set("page", String(page));
          else params.set("cursor", cursor);
          const body = await this.#request(`${path}?${params.toString()}`);
          const items = Array.isArray(body.result) ? body.result : [];
          const fresh = items.filter((item) => {
            const id = JSON.stringify(item);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          });
          out.push(...fresh);
          const info = body.result_info;
          const next = nextCursor(info);
          if (next !== undefined) {
            if (next === "" || items.length === 0) return out;
            cursor = next;
            continue;
          }
          // A list that ignores the page number answers the same items again: it is all there.
          if (page > 1 && items.length > 0 && fresh.length === 0) return out;
          if (typeof info?.total_pages === "number") {
            if (page >= info.total_pages) return out;
            if (items.length === 0) throw ended();
            continue;
          }
          if (typeof info?.total_count === "number") {
            if (out.length >= info.total_count) return out;
            if (items.length === 0) throw ended();
            continue;
          }
          if (items.length < PER_PAGE) return out;
        }
        throw ended();
      })();
      this.#memo.set(key, pending);
    }
    return pending;
  }
}
