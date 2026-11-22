// Fin Admin's audit log reads (spec 02 §14.3, §14.5, §16.4; ARCHITECTURE §8.6; spec 08 §3.11): the
// staff-scope rows, newest first, for a member of staff whose role holds `audit.read`. They read
// `audit.event` only through the two SECURITY DEFINER functions of `_staff_audit_log`, which
// re-check the session, its Access `sub`, the member, the second factor and `audit.read` from the
// session's own row (the stand-in for `api`'s `audit.staff_log` door until it exists, recorded),
// and return nothing outside the staff scope. The re-check holds against a fault in requireStaff,
// not against someone holding the fin_admin login, who can read the session row it compares (the
// migration's header says why; the door closes it). Paging is by keyset on the time-ordered `aud_`
// ID: `cursor` reads the older rows, `before` the newer ones, and the count comes apart from the
// page's rows; a page with no rows leads back by its own cursor only while rows lie strictly past
// it. Each row names its actor as the staff table says now, its target and refs with their current
// labels where they are staff objects that still exist, how the actor was verified, and the
// address and device of the request ([BC-03]). Filters are IDs, event names, presets and UTC days:
// no typed text reaches the database or a line.
import { deviceSummary } from "@fin/identity";
import { StaffRefusal } from "../errors.ts";
import type { Clock, LineSink, UnitTx } from "../ports.ts";
import { sqlState } from "../ports.ts";

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_PAGE_MAX = 100;
/** The furthest a total counts before it says "10,000 or more" (`totalCapped`). */
export const AUDIT_TOTAL_CAP = 10_000;
export const AUDIT_MAX_ACTORS = 20;
export const AUDIT_MAX_ACTIONS = 50;
export const AUDIT_MAX_ORGS = 20;

/** The board's date presets (AdminAudit's Date filter), all in UTC. */
export const AUDIT_RANGES = ["today", "week", "7d", "30d", "month"] as const;
export type AuditRange = (typeof AUDIT_RANGES)[number];

/** The board's quick views beside All: "My actions" and "Rejections this week". */
export const AUDIT_SHOWS = ["mine", "rejections"] as const;
export type AuditShow = (typeof AUDIT_SHOWS)[number];

/**
 * What "Rejections this week" reads (spec 08 §3.4's staff-kyc names, Sunday's L-SUN-02): a
 * customer rejected by staff. Until that fragment lands no row carries it, and the view is empty.
 */
export const REJECTION_EVENTS: readonly string[] = ["staff.customer_rejected"];

export const AUDIT_ID = /^aud_[0-9a-hjkmnp-tv-z]{26}$/;
export const EVENT_NAME = /^[a-z][a-z_]*(\.[a-z][a-z_]*){1,2}$/;
export const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface StaffAuditQuery {
  show?: AuditShow | undefined;
  /** `stf_` IDs: the rows these members of staff made. */
  actors?: readonly string[] | undefined;
  /** Event names. */
  actions?: readonly string[] | undefined;
  /** `org_` IDs: the rows about these organisations. */
  orgs?: readonly string[] | undefined;
  range?: AuditRange | undefined;
  /** UTC days, `YYYY-MM-DD`, both included (the Date filter's Custom). */
  from?: string | undefined;
  to?: string | undefined;
  /** An `aud_` ID: the rows older than it. */
  cursor?: string | undefined;
  /** An `aud_` ID: the rows newer than it. */
  before?: string | undefined;
  limit: number;
}

/** Who reads: the session requireStaff read, and the Access identity the API half verified. */
export interface StaffAuditReader {
  staffId: string;
  sessionId: string;
  accessSub: string | null;
}

export type StaffVerification =
  | "passkey"
  | "totp"
  | "backup_code"
  | "session"
  | "email_otp"
  | "password"
  | "google";

/** An object a row names, with its current label where it is a staff object that still exists. */
export interface StaffAuditObject {
  id: string;
  label: string | null;
}

export interface StaffAuditEntry {
  id: string;
  event: string;
  category: string;
  at: string;
  actor: {
    kind: string;
    id: string | null;
    via: string;
    email: string | null;
    name: string | null;
  };
  target: StaffAuditObject;
  refs: StaffAuditObject[];
  organisationId: string | null;
  metadata: Record<string, unknown>;
  /** How the actor was verified; null for an actor who is not a member of staff. */
  verification: StaffVerification | null;
  address: string | null;
  device: string | null;
}

export interface StaffAuditPage {
  items: StaffAuditEntry[];
  /** The rows matching the query, whatever the page holds (counted up to the cap). */
  total: number;
  totalCapped: boolean;
  /**
   * The cursor of the next (older) page, or null when nothing older matches. On a page with no
   * rows it is the `before` cursor itself, the way back to the rows older than it, or null when
   * there are none (the cursor row is then the only one that may match, on the first page).
   */
  nextCursor: string | null;
  /**
   * The cursor of the previous (newer) page, or null on the first page. On a page with no rows it
   * is the `cursor` itself, the way back to the rows newer than it, or null when there are none
   * (the cursor row is then the only one that may match, on the first page).
   */
  previousCursor: string | null;
}

/** A row as both reads return it: `recorded_at` is ISO 8601 in UTC with milliseconds. */
interface RawRow {
  id: string;
  event: string;
  category: string;
  recorded_at: string;
  actor_kind: string;
  actor_id: string | null;
  actor_via: string;
  actor_email: string | null;
  actor_name: string | null;
  step_up_method: string | null;
  target_id: string;
  ref_ids: string[];
  metadata: Record<string, unknown>;
  organization_id: string | null;
  client_ip: string | null;
  user_agent: string | null;
}

/**
 * `staff.audit_log`'s one row: the page's rows, and apart from them the count, whether matching
 * rows lie on the cursor's other side (`beyond`, the cursor row among them) and whether any lies
 * strictly past the cursor (`past`, the cursor row left out).
 */
interface RawPage {
  items: RawRow[] | null;
  total: string | number | null;
  beyond: boolean | null;
  past: boolean | null;
}

export interface AuditReadDeps {
  clock: Clock;
  lines: LineSink;
}

const DAY = 24 * 60 * 60 * 1000;

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Monday 00:00 UTC of the week holding `now` (ISO weeks start on Monday). */
export function startOfUtcWeek(now: Date): Date {
  const midnight = utcMidnight(now);
  const sinceMonday = (midnight.getUTCDay() + 6) % 7;
  return new Date(midnight.getTime() - sinceMonday * DAY);
}

/** A `YYYY-MM-DD` UTC day as its midnight, or null when it is not a real day. */
export function utcDay(day: string): Date | null {
  if (!UTC_DAY.test(day)) return null;
  const at = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== day ? null : at;
}

/** The window a query reads, in UTC: the preset, or the custom days (`to` included). */
export function windowOf(
  query: Pick<StaffAuditQuery, "range" | "from" | "to" | "show">,
  now: Date,
): { from: Date | null; to: Date | null } {
  let from: Date | null = null;
  let to: Date | null = null;
  switch (query.range) {
    case "today":
      from = utcMidnight(now);
      break;
    case "week":
      from = startOfUtcWeek(now);
      break;
    case "7d":
      from = new Date(now.getTime() - 7 * DAY);
      break;
    case "30d":
      from = new Date(now.getTime() - 30 * DAY);
      break;
    case "month":
      from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      break;
    case undefined:
      if (query.from !== undefined) from = utcDay(query.from);
      if (query.to !== undefined) {
        const last = utcDay(query.to);
        to = last === null ? null : new Date(last.getTime() + DAY);
      }
      break;
  }
  if (query.show === "rejections") {
    const week = startOfUtcWeek(now);
    if (from === null || from < week) from = week;
  }
  return { from, to };
}

/** The event names a query reads: the Action filter, narrowed to rejections by that view. */
export function eventsOf(query: Pick<StaffAuditQuery, "actions" | "show">): string[] | null {
  const chosen = query.actions === undefined || query.actions.length === 0 ? null : query.actions;
  if (query.show !== "rejections") return chosen === null ? null : [...chosen];
  return chosen === null
    ? [...REJECTION_EVENTS]
    : chosen.filter((name) => REJECTION_EVENTS.includes(name));
}

const CHIPS: ReadonlySet<string> = new Set<StaffVerification>([
  "passkey",
  "totp",
  "backup_code",
  "email_otp",
  "password",
  "google",
]);

/**
 * The rows whose `method` is how the member proved who they are: a sign-in, and a step-up that
 * passed. Elsewhere `method` names something else (the factor added or removed, the one a failed
 * try used), and the member acted in their session.
 */
const PROVED_BY_METHOD: ReadonlySet<string> = new Set(["staff.signed_in", "staff.step_up_passed"]);

/**
 * The rows that prove nothing about the member they name: a failed sign-in names the member whose
 * address was tried, often with no session at all (a wrong emailed code, or the address typed under
 * another Access identity), and never says the member was verified.
 */
const PROVES_NOTHING: ReadonlySet<string> = new Set(["staff.sign_in_failed"]);

/**
 * The verification chip (§14.5): the proof of a stepped-up action; otherwise the method a sign-in
 * or a passed step-up records; otherwise the session the member acted in. An actor who is not a
 * member of staff (the operator, the system, a provider) has none, and neither has a row that
 * proves nothing about its actor (a failed sign-in).
 */
export function verificationOf(
  event: string,
  stepUpMethod: string | null,
  metadata: Record<string, unknown>,
  actorKind: string,
): StaffVerification | null {
  if (PROVES_NOTHING.has(event)) return null;
  if (stepUpMethod === "passkey" || stepUpMethod === "totp" || stepUpMethod === "backup_code") {
    return stepUpMethod;
  }
  if (actorKind !== "staff") return null;
  const method = metadata.method;
  if (PROVED_BY_METHOD.has(event) && typeof method === "string" && CHIPS.has(method)) {
    return method as StaffVerification;
  }
  return "session";
}

const LABELLED = /^(stf|srl|sts|pky)_[0-9a-hjkmnp-tv-z]{26}$/;

function idsOf(rows: readonly RawRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.target_id);
    for (const ref of row.ref_ids) ids.add(ref);
  }
  return [...ids].filter((id) => LABELLED.test(id));
}

/**
 * The current labels of the staff objects among `ids`: a member by their address, a custom staff
 * role by its name, a staff session by its device, a passkey by its name. Nothing outside the
 * staff schema is named here (an organisation's name is not Fin Admin's to read yet).
 */
async function staffLabels(tx: UnitTx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await tx.query<{ id: string; label: string | null; session: boolean }>(
    `SELECT m.id, m.email AS label, false AS session FROM staff.member m WHERE m.id = ANY($1::text[])
     UNION ALL
     SELECT r.id, r.name, false FROM staff.role r WHERE r.id = ANY($1::text[])
     UNION ALL
     SELECT s.id, s.user_agent, true FROM staff.session s WHERE s.id = ANY($1::text[])
     UNION ALL
     SELECT p.id, p.name, false FROM staff.passkey p WHERE p.id = ANY($1::text[])`,
    [[...ids]],
  );
  const labels = new Map<string, string>();
  for (const row of result.rows) {
    const label = row.session ? deviceSummary(row.label) : row.label;
    if (label !== null && label !== "") labels.set(row.id, label);
  }
  return labels;
}

function toEntry(row: RawRow, labels: ReadonlyMap<string, string>): StaffAuditEntry {
  const object = (id: string): StaffAuditObject => ({ id, label: labels.get(id) ?? null });
  return {
    id: row.id,
    event: row.event,
    category: row.category,
    at: row.recorded_at,
    actor: {
      kind: row.actor_kind,
      id: row.actor_id,
      via: row.actor_via,
      email: row.actor_email,
      name: row.actor_name,
    },
    target: object(row.target_id),
    refs: row.ref_ids.map(object),
    organisationId: row.organization_id,
    metadata: row.metadata,
    verification: verificationOf(row.event, row.step_up_method, row.metadata, row.actor_kind),
    address: row.client_ip,
    device: row.user_agent === null || row.user_agent === "" ? null : deviceSummary(row.user_agent),
  };
}

/**
 * Runs one of the two reads. The database refusing a reader requireStaff let through (42501) means
 * the guard and the door's re-check disagree: the line `staff.audit_read_refused` says so and the
 * answer is `403 forbidden`. A paging or filter shape it refuses (22023) is `400 invalid`.
 */
async function read<R extends object>(
  deps: AuditReadDeps,
  tx: UnitTx,
  reader: StaffAuditReader,
  text: string,
  values: readonly unknown[],
): Promise<R[]> {
  try {
    return (await tx.query<R>(text, values)).rows;
  } catch (error) {
    const state = sqlState(error);
    if (state === "42501") {
      deps.lines.write("staff.audit_read_refused", "warn", { staffId: reader.staffId });
      throw new StaffRefusal("forbidden", "audit.door_refused", { permission: "audit.read" });
    }
    if (state === "22023") {
      throw new StaffRefusal("invalid", "audit.query", {
        fields: [{ path: "query", code: "invalid" }],
      });
    }
    throw error;
  }
}

function refuseQuery(path: string): never {
  throw new StaffRefusal("invalid", "audit.query", { fields: [{ path, code: "invalid" }] });
}

/** The shape checks the route's schema makes, again here, so no caller can skip them. */
export function checkQuery(query: StaffAuditQuery): void {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > AUDIT_PAGE_MAX) {
    refuseQuery("query.limit");
  }
  if (query.cursor !== undefined && query.before !== undefined) refuseQuery("query.before");
  for (const [field, value] of [
    ["query.cursor", query.cursor],
    ["query.before", query.before],
  ] as const) {
    if (value !== undefined && !AUDIT_ID.test(value)) refuseQuery(field);
  }
  const lists = [
    ["query.actor", query.actors, /^stf_[0-9a-hjkmnp-tv-z]{26}$/, AUDIT_MAX_ACTORS],
    ["query.action", query.actions, EVENT_NAME, AUDIT_MAX_ACTIONS],
    ["query.org", query.orgs, /^org_[0-9a-hjkmnp-tv-z]{26}$/, AUDIT_MAX_ORGS],
  ] as const;
  for (const [field, list, shape, max] of lists) {
    if (list === undefined) continue;
    if (list.length > max || list.some((item) => !shape.test(item))) refuseQuery(field);
  }
  if (query.range !== undefined && (query.from !== undefined || query.to !== undefined)) {
    refuseQuery("query.range");
  }
  const from = query.from === undefined ? undefined : utcDay(query.from);
  const to = query.to === undefined ? undefined : utcDay(query.to);
  if (from === null) refuseQuery("query.from");
  if (to === null) refuseQuery("query.to");
  if (from !== undefined && to !== undefined && from > to) refuseQuery("query.to");
}

const nonEmpty = (list: readonly string[] | undefined): string[] | null =>
  list === undefined || list.length === 0 ? null : [...list];

/** `GET /api/audit` (§14.3): one page of the staff log. */
export async function staffAuditLog(
  deps: AuditReadDeps,
  tx: UnitTx,
  reader: StaffAuditReader,
  query: StaffAuditQuery,
): Promise<StaffAuditPage> {
  checkQuery(query);
  const window = windowOf(query, deps.clock.now());
  const [summary] = await read<RawPage>(
    deps,
    tx,
    reader,
    "SELECT items, total, beyond, past FROM staff.audit_log($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    [
      reader.sessionId,
      reader.accessSub,
      query.show === "mine",
      nonEmpty(query.actors),
      eventsOf(query),
      nonEmpty(query.orgs),
      window.from,
      window.to,
      query.cursor ?? null,
      query.before ?? null,
      query.limit,
    ],
  );
  // The count, `beyond` and `past` come with the one summary row, never with the page's own rows,
  // so a page with no rows still carries them.
  const rows = summary?.items ?? [];
  const total = Number(summary?.total ?? 0);
  const extra = rows.length > query.limit;
  let page = rows;
  if (extra) {
    // Newest first, the extra row is the oldest one, past the page's end; read upwards from
    // `before`, it is the newest one, past the page's start.
    page =
      query.before === undefined
        ? rows.slice(0, query.limit)
        : rows.slice(rows.length - query.limit);
  }
  // The way back to the cursor's other side. A page with rows takes it by its own first or last
  // row, whose read takes in the cursor row (`beyond`). A page with none (a cursor past either
  // end, or rows that left a rolling window) can take it only by the cursor itself, whose read
  // leaves the cursor row out (`past`). With nothing strictly past it, the cursor row is the only
  // one that may match: no cursor reaches it from here, and the empty state's way to the newest
  // rows does.
  const back = page.length > 0 ? summary?.beyond === true : summary?.past === true;
  const hasNewer = query.before === undefined ? query.cursor !== undefined && back : extra;
  const hasOlder = query.before === undefined ? extra : back;
  const labels = await staffLabels(tx, idsOf(page));
  const items = page.map((row) => toEntry(row, labels));
  // On a page with no rows, `before=<cursor>` reads the rows just newer than the cursor, and
  // `cursor=<before>` the rows just older.
  return {
    items,
    total: Math.min(total, AUDIT_TOTAL_CAP),
    totalCapped: total > AUDIT_TOTAL_CAP,
    nextCursor: hasOlder ? (items.at(-1)?.id ?? query.before ?? null) : null,
    previousCursor: hasNewer ? (items[0]?.id ?? query.cursor ?? null) : null,
  };
}

/** `GET /api/audit/:eventId`: one staff-scope entry, or `404 not_found` for any other ID. */
export async function staffAuditEntry(
  deps: AuditReadDeps,
  tx: UnitTx,
  reader: StaffAuditReader,
  eventId: string,
): Promise<StaffAuditEntry> {
  if (!AUDIT_ID.test(eventId)) throw new StaffRefusal("not_found", "audit.not_found");
  const rows = await read<RawRow>(deps, tx, reader, "SELECT * FROM staff.audit_entry($1, $2, $3)", [
    reader.sessionId,
    reader.accessSub,
    eventId,
  ]);
  const row = rows[0];
  if (row === undefined) throw new StaffRefusal("not_found", "audit.not_found");
  return toEntry(row, await staffLabels(tx, idsOf([row])));
}

/**
 * The members of staff the Staff member filter offers (removed ones too: they may have acted),
 * by address. Only for a reader who may see staff (`staff.read`); everyone else is offered
 * "Me" and the people on the page.
 */
export async function auditPeople(tx: UnitTx): Promise<{ id: string; email: string }[]> {
  const result = await tx.query<{ id: string; email: string }>(
    "SELECT id, email FROM staff.member ORDER BY email, id LIMIT 500",
  );
  return result.rows.map((row) => ({ id: row.id, email: row.email }));
}
