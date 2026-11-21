// A read-only Cloudflare API reader: GET only, plain fetch, one bearer token (the watcher's
// read-only token, CR-18). Lists are read page by page. Responses are memoised for the length of
// one run, so the checks can share the tunnel list and the zone ID.
//
// Cloudflare's lists page in different ways: page numbers with `total_pages`, page numbers with
// only `total_count`, a cursor, or no `result_info` at all, and some answer the whole list whatever
// the paging parameters say. A list is read to its end whichever it is, and a read that cannot
// prove it reached the end fails, so a "nothing extra" check never passes on part of a list:
//   - with totals, every total the list gives must be reached, and a page that adds nothing new
//     before then (an empty page, or page 1 again from a list that ignores the page number) fails;
//   - with a cursor, the list ends at an empty cursor, and a cursor that comes back fails;
//   - with neither, a short page is not the end (a list may answer fewer items than asked for):
//     the list is read on until a page adds nothing new, and a repeated answer exactly one full
//     page long is accepted only once a smaller per_page shows the list ignores the page size.

export const API_BASE = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 50;
const PER_PAGE = 50;
/** The page size that tells a list answering whole from one that pages by size alone. */
const PROBE_PER_PAGE = 10;

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

  /** One page of a list: its items and its result_info. */
  async #page(
    path: string,
    query: Readonly<Record<string, string>>,
    paging: Readonly<Record<string, string>>,
  ): Promise<{ items: unknown[]; info: Envelope["result_info"] }> {
    const params = new URLSearchParams({ ...query, ...paging });
    const body = await this.#request(`${path}?${params.toString()}`);
    return { items: Array.isArray(body.result) ? body.result : [], info: body.result_info };
  }

  /** Every item of a list, across pages. Fails when the end of the list cannot be proven. */
  list(path: string, query: Readonly<Record<string, string>> = {}): Promise<unknown[]> {
    const key = `list ${path} ${JSON.stringify(query)}`;
    let pending = this.#memo.get(key) as Promise<unknown[]> | undefined;
    if (pending === undefined) {
      pending = this.#readAll(path, query);
      this.#memo.set(key, pending);
    }
    return pending;
  }

  async #readAll(path: string, query: Readonly<Record<string, string>>): Promise<unknown[]> {
    const out: unknown[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    const ended = () => new CloudflareError(path, 0, []);
    let cursor: string | undefined;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { items, info } = await this.#page(
        path,
        query,
        cursor === undefined
          ? { per_page: String(PER_PAGE), page: String(page) }
          : { per_page: String(PER_PAGE), cursor },
      );
      let fresh = 0;
      for (const item of items) {
        const id = JSON.stringify(item);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(item);
        fresh += 1;
      }
      const next = nextCursor(info);
      if (next !== undefined) {
        if (next === "") return out;
        if (cursors.has(next)) throw ended();
        cursors.add(next);
        cursor = next;
        continue;
      }
      // A cursor-paged list that gives no next cursor has ended.
      if (cursor !== undefined) return out;
      const totalPages = typeof info?.total_pages === "number" ? info.total_pages : undefined;
      const totalCount = typeof info?.total_count === "number" ? info.total_count : undefined;
      if (totalPages !== undefined || totalCount !== undefined) {
        const pagesRead = totalPages === undefined || page >= totalPages;
        const itemsRead = totalCount === undefined || out.length >= totalCount;
        if (pagesRead && itemsRead) return out;
        if (fresh === 0) throw ended();
        continue;
      }
      if (fresh > 0) continue;
      if (items.length === 0) return out;
      // The same items again: the list ignores the page number and answered whole, unless it
      // answered exactly one full page, which a list that pages by size alone would also do.
      if (items.length !== PER_PAGE) return out;
      const probe = await this.#page(path, query, {
        per_page: String(PROBE_PER_PAGE),
        page: "1",
      });
      if (probe.items.length > PROBE_PER_PAGE) return out;
      throw ended();
    }
    throw ended();
  }
}
