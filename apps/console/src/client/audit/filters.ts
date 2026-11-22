// The audit log's filters, kept in the URL so Back returns to the page that opened them (spec 02
// §15.2.1): search, type, range, page, one object (`target`, or `targetKind=role`) and the entry
// open in the drawer (`view`). Anything else in the URL is dropped.
import { AUDIT_RANGES, type AuditRange } from "../api/contracts/audit.ts";

export const AUDIT_TYPES = [
  { value: "sign_in", label: "Sign-ins" },
  { value: "security", label: "Security" },
  { value: "team", label: "Team" },
  { value: "api_keys", label: "API keys" },
  { value: "organisation", label: "Organisation" },
] as const;

export const RANGE_LABELS: Readonly<Record<AuditRange, string>> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

export const DEFAULT_RANGE: AuditRange = "30d";
export const PAGE_SIZE = 25;

export interface AuditSearch {
  q?: string;
  type?: string;
  range?: AuditRange;
  page?: number;
  target?: string;
  targetKind?: "role";
  view?: string;
}

const ID = /^[a-z]{2,8}_[A-Za-z0-9_-]{1,64}$/;

export function readAuditSearch(search: Record<string, unknown>): AuditSearch {
  const out: AuditSearch = {};
  if (typeof search.q === "string" && search.q.trim() !== "") out.q = search.q.slice(0, 200);
  if (typeof search.type === "string" && AUDIT_TYPES.some((t) => t.value === search.type)) {
    out.type = search.type;
  }
  if (
    typeof search.range === "string" &&
    (AUDIT_RANGES as readonly string[]).includes(search.range)
  ) {
    out.range = search.range as AuditRange;
  }
  const page = Number(search.page);
  if (Number.isInteger(page) && page > 1 && page <= 400) out.page = page;
  if (typeof search.target === "string" && ID.test(search.target)) out.target = search.target;
  if (search.targetKind === "role") out.targetKind = "role";
  if (typeof search.view === "string" && ID.test(search.view)) out.view = search.view;
  return out;
}

/** The API's query for the page's filters (the drawer's entry is the page's own). */
export function auditQuery(search: AuditSearch, timeZone: string) {
  return {
    ...(search.q === undefined ? {} : { q: search.q }),
    ...(search.type === undefined ? {} : { type: search.type }),
    range: search.range ?? DEFAULT_RANGE,
    tz: timeZone,
    page: search.page ?? 1,
    size: PAGE_SIZE,
    ...(search.target === undefined ? {} : { target: search.target }),
    ...(search.targetKind === undefined ? {} : { targetKind: search.targetKind }),
  };
}

/** Which of the board's three empty states an empty answer draws. */
export function emptyKind(search: AuditSearch): "noMatch" | "range" | "ever" {
  if (
    search.q !== undefined ||
    search.type !== undefined ||
    search.target !== undefined ||
    search.targetKind !== undefined
  ) {
    return "noMatch";
  }
  return (search.range ?? DEFAULT_RANGE) === "all" ? "ever" : "range";
}

/**
 * The title of the empty state for a range with no events: "No events today", "No events in the
 * last 30 days". All time has its own empty state; its title is given for completeness.
 */
export function rangeEmptyTitle(range: AuditRange): string {
  if (range === "today") return "No events today";
  if (range === "all") return "No events yet";
  return `No events in the ${RANGE_LABELS[range].toLowerCase()}`;
}

/** The chip that names the one object the log is filtered to. */
export function objectChip(
  search: AuditSearch,
  filterLabel: string | null | undefined,
): string | null {
  if (search.target !== undefined) return filterLabel ?? search.target;
  if (search.targetKind === "role") return "Roles";
  return null;
}
