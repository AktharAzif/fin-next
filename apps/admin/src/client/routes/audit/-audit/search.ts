// AdminAudit's state in the URL (spec 06 S6-03): the quick view (`show`), the filters (`actor`,
// `action`, `org`, `date`, or custom `from` and `to` days), the page's cursor (`cursor` for older,
// `before` for newer) and the open entry (`view=<aud_…>`). Lists are comma-separated IDs or event
// names, as the API takes them. A hand-edited value that is not one of these, in exactly the
// shape the API takes, is dropped, never sent: the list then reads as if it were not there. A list
// keeps its first items, as many as the API takes (by count and by length), and no more.
import type { AuditListInput } from "./contract.ts";
import { AUDIT_ID, ORG_ID, STAFF_ID } from "./ids.ts";

export const AUDIT_PAGE_SIZE = 50;

export const DATE_PRESETS = ["today", "week", "7d", "30d", "month"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const DATE_LABELS: Readonly<Record<DatePreset, string>> = {
  today: "Today",
  week: "This week",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "This month",
};

export type QuickView = "mine" | "rejections";

export interface AuditSearch {
  show?: QuickView;
  /** Comma-separated `stf_` IDs. */
  actor?: string;
  /** Comma-separated event names. */
  action?: string;
  /** Comma-separated `org_` IDs. */
  org?: string;
  date?: DatePreset;
  /** UTC days, `YYYY-MM-DD`, both included. */
  from?: string;
  to?: string;
  cursor?: string;
  before?: string;
  /** The open entry's `aud_` ID. */
  view?: string;
}

const EVENT = /^[a-z][a-z_]*(\.[a-z][a-z_]*){1,2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** At most this many of each list, as the API takes them. */
const MAX = { actor: 20, action: 50, org: 20 } as const;
/** The longest a list may run, commas included, as the API takes it. */
const LIST_CHARS = 2_000;

function realDay(value: unknown): string | undefined {
  if (typeof value !== "string" || !DAY.test(value)) return undefined;
  const at = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value ? value : undefined;
}

function idOf(value: unknown, shape: RegExp): string | undefined {
  return typeof value === "string" && shape.test(value) ? value : undefined;
}

/**
 * The items a list keeps, in order and without repeats: as many as the API takes, and only while
 * the list stays within the API's length; undefined when none is left.
 */
function fit(items: readonly string[], max: number): string | undefined {
  const kept: string[] = [];
  let length = -1;
  for (const item of new Set(items)) {
    if (kept.length === max || length + 1 + item.length > LIST_CHARS) break;
    kept.push(item);
    length += 1 + item.length;
  }
  return kept.length === 0 ? undefined : kept.join(",");
}

/** A comma list of one shape, without repeats or wrong items; undefined when nothing is left. */
function listOf(value: unknown, shape: RegExp, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return fit(
    value.split(",").filter((item) => shape.test(item)),
    max,
  );
}

/** The route's `validateSearch`. */
export function readAuditSearch(raw: Record<string, unknown>): AuditSearch {
  const search: AuditSearch = {};
  if (raw.show === "mine" || raw.show === "rejections") search.show = raw.show;
  const actor = listOf(raw.actor, STAFF_ID, MAX.actor);
  if (actor !== undefined) search.actor = actor;
  const action = listOf(raw.action, EVENT, MAX.action);
  if (action !== undefined) search.action = action;
  const org = listOf(raw.org, ORG_ID, MAX.org);
  if (org !== undefined) search.org = org;
  if ((DATE_PRESETS as readonly unknown[]).includes(raw.date)) {
    search.date = raw.date as DatePreset;
  } else {
    const from = realDay(raw.from);
    const to = realDay(raw.to);
    if (from !== undefined && to !== undefined && from > to) {
      search.from = to;
      search.to = from;
    } else {
      if (from !== undefined) search.from = from;
      if (to !== undefined) search.to = to;
    }
  }
  const cursor = idOf(raw.cursor, AUDIT_ID);
  const before = idOf(raw.before, AUDIT_ID);
  if (cursor !== undefined) search.cursor = cursor;
  else if (before !== undefined) search.before = before;
  const view = idOf(raw.view, AUDIT_ID);
  if (view !== undefined) search.view = view;
  return search;
}

/** The items of a comma list. */
export function items(value: string | undefined): string[] {
  return value === undefined || value === "" ? [] : value.split(",");
}

/** The list loader's dependencies: everything but the open entry, so opening one reads nothing. */
export function listDeps(search: AuditSearch): Omit<AuditSearch, "view"> {
  const { view: _view, ...rest } = search;
  return rest;
}

/** What `GET /api/audit` is asked for this search. */
export function apiQuery(search: AuditSearch, limit = AUDIT_PAGE_SIZE): AuditListInput {
  const query: AuditListInput = { limit };
  if (search.show !== undefined) query.show = search.show;
  if (search.actor !== undefined) query.actor = search.actor;
  if (search.action !== undefined) query.action = search.action;
  if (search.org !== undefined) query.org = search.org;
  if (search.date !== undefined) query.date = search.date;
  if (search.from !== undefined) query.from = search.from;
  if (search.to !== undefined) query.to = search.to;
  if (search.cursor !== undefined) query.cursor = search.cursor;
  if (search.before !== undefined) query.before = search.before;
  return query;
}

/** Whether a filter (not a quick view) narrows the list. */
export function hasFilters(search: AuditSearch): boolean {
  return (
    search.actor !== undefined ||
    search.action !== undefined ||
    search.org !== undefined ||
    search.date !== undefined ||
    search.from !== undefined ||
    search.to !== undefined
  );
}

/**
 * Which empty state an empty answer draws (the board's empty, rejections and noResults). A page
 * reached by a cursor is never the first use, whatever it holds: it is a page past the end of the
 * list (a stale or hand-edited link, or rows that left a rolling date window), which offers the
 * way back.
 */
export function emptyKind(
  search: AuditSearch,
): "firstUse" | "viewEmpty" | "noResults" | "pageEmpty" {
  if (search.cursor !== undefined || search.before !== undefined) return "pageEmpty";
  if (hasFilters(search)) return "noResults";
  if (search.show !== undefined) return "viewEmpty";
  return "firstUse";
}

/** A change to a search: a key set to undefined leaves the URL. */
export type SearchChange = { [K in keyof AuditSearch]?: AuditSearch[K] | undefined };

/**
 * A search with filters changed: the cursor and the open entry go (a new list starts at its
 * newest row), and a filter set to undefined leaves the URL.
 */
export function withFilter(search: AuditSearch, change: SearchChange): AuditSearch {
  const next = { ...search, ...change } as AuditSearch;
  delete next.cursor;
  delete next.before;
  delete next.view;
  for (const key of Object.keys(next) as (keyof AuditSearch)[]) {
    if (next[key] === undefined) delete next[key];
  }
  return next;
}

/** A search with a list's item added or taken away, back on the first page. */
export function toggled(
  search: AuditSearch,
  key: "actor" | "action" | "org",
  value: string,
): AuditSearch {
  const current = items(search[key]);
  const next = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value];
  return withFilter(search, { [key]: fit(next, MAX[key]) });
}

/** A search with no filter, keeping its quick view ("Clear filters"). */
export function withoutFilters(search: AuditSearch): AuditSearch {
  return withFilter(search, {
    actor: undefined,
    action: undefined,
    org: undefined,
    date: undefined,
    from: undefined,
    to: undefined,
  });
}

/** The same list from its newest row: no cursor and no open entry. */
export function firstPage(search: AuditSearch): AuditSearch {
  return withFilter(search, {});
}

/** A search that opens another page of the same list. */
export function paged(
  search: AuditSearch,
  page: { cursor: string } | { before: string },
): AuditSearch {
  const next: AuditSearch = { ...search };
  delete next.cursor;
  delete next.before;
  delete next.view;
  return { ...next, ...page };
}

/** The app path of a search: `/audit?…`, every parameter as the URL holds it. */
export function hrefOf(search: AuditSearch): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  return `/audit${query === "" ? "" : `?${query}`}`;
}
