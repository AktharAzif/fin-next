// A read-only Cloudflare API reader: GET only, plain fetch, one bearer token (the watcher's
// read-only token, CR-18). Lists are read page by page. Responses are memoised for the length of
// one run, so the checks can share the tunnel list and the zone ID.
//
// Every answer must be Cloudflare's envelope with `success: true`, and every page of a list must
// hold a list: a body that cannot be read (cut off, not JSON, a proxy's page) or a `result` that is
// not a list fails the read, never stands for an empty one. A 404 means "not found" only when
// Cloudflare's own envelope says so.
//
// Cloudflare's lists page in different ways: page numbers with `total_pages`, page numbers with
// only `total_count`, a cursor, or no `result_info` at all, and some answer the whole list whatever
// the paging parameters say. A list is read to its end whichever it is, and a read that cannot
// prove it reached the end fails, so a "nothing extra" check never passes on part of a list:
//   - with totals, every total the list gives must be reached, and a page that adds nothing new
//     before then (an empty page, or page 1 again from a list that ignores the page number) fails;
//   - with a cursor, the list ends at an empty or missing cursor once every total it gives is
//     reached, and a cursor that comes back fails;
//   - with neither, a short page is not the end (a list may answer fewer items than asked for):
//     the list is read on until a page adds nothing new, and a page that repeats is accepted only
//     once a smaller per_page, asking for fewer items than it holds, still gets all of them back,
//     which shows the list ignores the page size and answered whole.
// A list whose documentation pages it by cursor alone is read that way, declared by its caller
// (`list(path, query, "cursor")`): no page number is sent, and a page without a next cursor is the
// end, once every total it gives is reached. The rule sets list is one (Cloudflare's API reference:
// `cursor` and `per_page` up to 50, `result_info.cursors.after` only while more remain); read by
// the rules above, a list of it that fits on one page would answer a page number with page 1
// again and honour a smaller page size, which proves nothing, so the read would always fail.

export const API_BASE = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 50;
const PER_PAGE = 50;
/** The page size that tells a list answering whole from one that pages by size alone. */
const PROBE_PER_PAGE = 10;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * How a list pages: `cursor` when its documentation pages it by cursor alone (no page number),
 * `auto` (the default) to learn it from what the list answers.
 */
export type ListPaging = "auto" | "cursor";

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
    const path = pathWithQuery.split("?")[0] ?? pathWithQuery;
    // A body that cannot be read (cut off by the timeout, not JSON) is no answer at all.
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    const body: Envelope | undefined =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Envelope)
        : undefined;
    const codes = (Array.isArray(body?.errors) ? body.errors : [])
      .map((e) => Number(e?.code))
      .filter(Number.isFinite);
    if (!response.ok) {
      // Only Cloudflare's own refusal is a refusal: a 404 from anything else is not "not found".
      const status = response.status === 404 && body?.success !== false ? 0 : response.status;
      throw new CloudflareError(path, status, codes);
    }
    if (body?.success === false) throw new CloudflareError(path, response.status, codes);
    if (body?.success !== true) throw new CloudflareError(path, 0, []);
    return body;
  }

  /**
   * One object (the `result`), or undefined when Cloudflare answers 404. An answer with no result
   * (missing or null) fails: it is not an object with nothing in it.
   */
  get(path: string): Promise<unknown> {
    const key = `get ${path}`;
    let pending = this.#memo.get(key);
    if (pending === undefined) {
      pending = this.#request(path).then(
        (b) => {
          if (b.result === undefined || b.result === null) throw new CloudflareError(path, 0, []);
          return b.result;
        },
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
    // A page whose result is not a list (missing, null or an object) is not an empty page.
    if (!Array.isArray(body.result)) throw new CloudflareError(path, 0, []);
    return { items: body.result, info: body.result_info };
  }

  /** Every item of a list, across pages. Fails when the end of the list cannot be proven. */
  list(
    path: string,
    query: Readonly<Record<string, string>> = {},
    paging: ListPaging = "auto",
  ): Promise<unknown[]> {
    const key = `list ${paging} ${path} ${JSON.stringify(query)}`;
    let pending = this.#memo.get(key) as Promise<unknown[]> | undefined;
    if (pending === undefined) {
      pending = this.#readAll(path, query, paging);
      this.#memo.set(key, pending);
    }
    return pending;
  }

  async #readAll(
    path: string,
    query: Readonly<Record<string, string>>,
    paging: ListPaging,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    const ended = () => new CloudflareError(path, 0, []);
    let cursor: string | undefined;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const perPage = { per_page: String(PER_PAGE) };
      const { items, info } = await this.#page(
        path,
        query,
        cursor !== undefined
          ? { ...perPage, cursor }
          : paging === "cursor"
            ? perPage
            : { ...perPage, page: String(page) },
      );
      let fresh = 0;
      for (const item of items) {
        const id = JSON.stringify(item);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(item);
        fresh += 1;
      }
      const totalPages = typeof info?.total_pages === "number" ? info.total_pages : undefined;
      const totalCount = typeof info?.total_count === "number" ? info.total_count : undefined;
      const totalsReached =
        (totalPages === undefined || page >= totalPages) &&
        (totalCount === undefined || out.length >= totalCount);
      const next = nextCursor(info);
      if (next !== undefined && next !== "") {
        if (cursors.has(next)) throw ended();
        cursors.add(next);
        cursor = next;
        continue;
      }
      // A cursor-paged list (declared so, or one that gave a cursor) ends at an empty or missing
      // cursor, once its totals are reached.
      if (paging === "cursor" || next === "" || cursor !== undefined) {
        if (totalsReached) return out;
        throw ended();
      }
      if (totalPages !== undefined || totalCount !== undefined) {
        if (totalsReached) return out;
        if (fresh === 0) throw ended();
        continue;
      }
      if (fresh > 0) continue;
      if (items.length === 0) return out;
      // The same items again: the list ignores the page number. It answered whole only if it
      // ignores the page size too, which a smaller per_page than the page holds shows (0 for a
      // single item); a list that caps its pages would answer that smaller page instead.
      const smaller = Math.min(PROBE_PER_PAGE, items.length - 1);
      const probe = await this.#page(path, query, { per_page: String(smaller), page: "1" });
      const known = probe.items.every((item) => seen.has(JSON.stringify(item)));
      if (probe.items.length > smaller && known) return out;
      throw ended();
    }
    throw ended();
  }
}
