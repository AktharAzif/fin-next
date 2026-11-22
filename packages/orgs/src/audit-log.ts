// The console's audit reads (spec 02 §14.5, §15.2.1, S2-43): the organisation's log for a member
// whose role holds `auditLog.read`, and the person's own activity. They read `audit.event` only
// through the two SECURITY DEFINER functions of `_orgs_views`, which re-check the session, the gate,
// the membership and the permission from the session's own row (the stand-in for `api`'s door until
// it exists, recorded). `target` and `targetKind` filter inside the organisation's own rows, and a
// filter label is resolved only for an object of this organisation, so another organisation's ID
// matches nothing and names nothing. Each row names its target and refs with their current labels,
// resolved the same way (the organisation's own objects; in the person's activity, the person's own),
// so a reader who may not list the team still reads who and what. A row the reader may not attribute
// (Fin staff in an organisation's log; another person's act in someone's activity) carries no actor
// ID, address, device or chip.
import { deviceSummary, type UnitTx } from "@fin/identity";
import { OrgRefusal } from "./errors.ts";
import type { Guarded, OrgActor } from "./guard.ts";

export type AuditRange = "today" | "7d" | "30d" | "90d" | "all";

export const ORGANISATION_CATEGORIES = [
  "organisation",
  "team",
  "api_keys",
  "customers",
  "going_live",
  "webhooks",
  "money",
] as const;
export type OrganisationCategory = (typeof ORGANISATION_CATEGORIES)[number];

export interface AuditLogQuery {
  q?: string | undefined;
  type?: OrganisationCategory | undefined;
  range: AuditRange;
  from?: Date | undefined;
  to?: Date | undefined;
  tz: string;
  page: number;
  size: number;
  target?: string | undefined;
  targetKind?: "role" | undefined;
}

export type Verification =
  | "passkey"
  | "totp"
  | "backup_code"
  | "session"
  | "email_otp"
  | "password"
  | "google";

/** An object a row names, with its current label where it still exists and may be shown (§14.5). */
export interface AuditObject {
  id: string;
  label: string | null;
}

export interface AuditLogRow {
  id: string;
  event: string;
  category: string;
  at: string;
  actor: {
    kind: string;
    id: string | null;
    via: string;
    name: string | null;
    email: string | null;
  };
  target: AuditObject;
  refs: AuditObject[];
  metadata: Record<string, unknown>;
  /** How the actor was verified; null when the actor is not one the reader may see (§14.5). */
  verification: Verification | null;
  address: string | null;
  device: string | null;
}

interface RawRow {
  id: string;
  event: string;
  category: string;
  recorded_at: Date;
  actor_kind: string;
  actor_id: string | null;
  actor_via: string;
  actor_name?: string | null;
  actor_email?: string | null;
  /** The person's activity only: whether the reader made the row (the rest is withheld). */
  actor_is_reader?: boolean;
  step_up_method: string | null;
  target_id: string;
  ref_ids: string[];
  metadata: Record<string, unknown>;
  client_ip: string | null;
  user_agent: string | null;
  total: string | number;
}

/** The furthest row a page may start at, as the two database reads bound it. */
export const AUDIT_MAX_OFFSET = 10_000;

/**
 * Refuses a page beyond what the reads serve (`400 invalid` on `query.page`), before the database
 * would refuse it as a failed statement: past the 10,000th row a list shows `totalCapped` instead.
 */
function checkPaging(page: { page: number; size: number }): void {
  const ok =
    Number.isSafeInteger(page.page) &&
    Number.isSafeInteger(page.size) &&
    page.page >= 1 &&
    page.size >= 1 &&
    page.size <= 100 &&
    (page.page - 1) * page.size <= AUDIT_MAX_OFFSET;
  if (!ok) {
    throw new OrgRefusal("invalid", "schema.invalid", {
      fields: [{ path: "query.page", code: "too_big" }],
    });
  }
}

const DAY = 24 * 60 * 60 * 1000;

/** The UTC instant of the last midnight in `tz` before `now` (for `range=today`). */
export function startOfDay(now: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const sinceMidnightMs =
    ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000 + now.getUTCMilliseconds();
  return new Date(now.getTime() - sinceMidnightMs);
}

/** The window a query reads: `from`/`to` when given, otherwise the range (30 days by default). */
export function windowOf(query: AuditLogQuery, now: Date): { from: Date | null; to: Date | null } {
  if (query.from !== undefined || query.to !== undefined) {
    return { from: query.from ?? null, to: query.to ?? null };
  }
  switch (query.range) {
    case "today":
      return { from: startOfDay(now, query.tz), to: null };
    case "7d":
      return { from: new Date(now.getTime() - 7 * DAY), to: null };
    case "30d":
      return { from: new Date(now.getTime() - 30 * DAY), to: null };
    case "90d":
      return { from: new Date(now.getTime() - 90 * DAY), to: null };
    case "all":
      return { from: null, to: null };
  }
}

const CHIPS: ReadonlySet<string> = new Set<Verification>([
  "passkey",
  "totp",
  "backup_code",
  "session",
  "email_otp",
  "password",
  "google",
]);

/**
 * The verification chip (§14.5): the proof of a stepped-up action; otherwise the method a sign-in
 * row records (`session.created`, `member.signed_in` and the like carry `method`); otherwise the
 * session the person acted in. A row of an actor who is not a person of the console has no chip.
 */
export function verificationOf(
  stepUpMethod: string | null,
  metadata: Record<string, unknown>,
  actorKind: string,
): Verification | null {
  if (stepUpMethod === "passkey" || stepUpMethod === "totp" || stepUpMethod === "backup_code") {
    return stepUpMethod;
  }
  const method = metadata.method;
  if (typeof method === "string" && CHIPS.has(method) && method !== "session") {
    return method as Verification;
  }
  return actorKind === "user" ? "session" : null;
}

/** A short device summary from a user agent ([BC-03]): the realm's own, never the raw string. */
export function deviceOf(userAgent: string | null): string | null {
  return userAgent === null || userAgent === "" ? null : deviceSummary(userAgent);
}

function toRow(row: RawRow, labels: ReadonlyMap<string, string>): AuditLogRow {
  // In the person's activity, a row someone else made keeps that actor's facts to itself.
  const withheld = row.actor_is_reader === false;
  const object = (id: string): AuditObject => ({ id, label: labels.get(id) ?? null });
  return {
    id: row.id,
    event: row.event,
    category: row.category,
    at: row.recorded_at.toISOString(),
    actor: {
      kind: row.actor_kind,
      id: withheld ? null : row.actor_id,
      via: row.actor_via,
      name: withheld ? null : (row.actor_name ?? null),
      email: withheld ? null : (row.actor_email ?? null),
    },
    target: object(row.target_id),
    refs: row.ref_ids.map(object),
    metadata: row.metadata,
    verification: withheld
      ? null
      : verificationOf(row.step_up_method, row.metadata, row.actor_kind),
    address: withheld ? null : row.client_ip,
    device: withheld ? null : deviceOf(row.user_agent),
  };
}

const LABELLED = /^(mem|usr|inv|rol|org|pky|tbr|ses)_[0-9a-hjkmnp-tv-z]{26}$/;

function idsOf(rows: readonly RawRow[], extra: readonly string[] = []): string[] {
  const ids = new Set<string>(extra);
  for (const row of rows) {
    ids.add(row.target_id);
    for (const ref of row.ref_ids) ids.add(ref);
  }
  return [...ids].filter((id) => LABELLED.test(id));
}

/**
 * The current labels of the organisation's own objects among `ids` (§14.5, §14.2's `filterLabel`):
 * a member or a person by their name or address while they are a member, an invitation by its
 * address, a role by its name, the organisation by its name. An object of another organisation, or
 * one that no longer exists, has none, so another organisation's ID is never named.
 */
async function labelsInOrganisation(
  tx: UnitTx,
  orgId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await tx.query<{ id: string; label: string | null }>(
    `SELECT m.id, coalesce(nullif(u.name, ''), u.email) AS label
       FROM identity.member m JOIN identity."user" u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.id = ANY($2::text[])
     UNION ALL
     SELECT u.id, coalesce(nullif(u.name, ''), u.email)
       FROM identity.member m JOIN identity."user" u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND u.id = ANY($2::text[])
     UNION ALL
     SELECT i.id, i.email FROM identity.invitation i
      WHERE i.organization_id = $1 AND i.id = ANY($2::text[])
     UNION ALL
     SELECT r.id, r.name FROM identity.role r
      WHERE r.organization_id = $1 AND r.id = ANY($2::text[])
     UNION ALL
     SELECT o.id, o.name FROM identity.organization o
      WHERE o.id = $1 AND o.id = ANY($2::text[])`,
    [orgId, [...ids]],
  );
  const labels = new Map<string, string>();
  for (const row of result.rows) {
    if (row.label !== null && row.label !== "") labels.set(row.id, row.label);
  }
  return labels;
}

/**
 * The current labels of the person's own objects among `ids`: themselves, their passkeys, trusted
 * browsers and sessions (a session by its device summary), and the organisations they belong to.
 * Nothing of anyone else's is named in a person's activity.
 */
async function labelsOfPerson(
  tx: UnitTx,
  userId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await tx.query<{ id: string; label: string | null; session: boolean }>(
    `SELECT u.id, coalesce(nullif(u.name, ''), u.email) AS label, false AS session
       FROM identity."user" u WHERE u.id = $1 AND u.id = ANY($2::text[])
     UNION ALL
     SELECT p.id, p.name, false FROM identity.passkey p
      WHERE p.user_id = $1 AND p.id = ANY($2::text[])
     UNION ALL
     SELECT t.id, t.label, false FROM identity.trusted_browser t
      WHERE t.user_id = $1 AND t.id = ANY($2::text[])
     UNION ALL
     SELECT s.id, s.user_agent, true FROM identity.session s
      WHERE s.user_id = $1 AND s.id = ANY($2::text[])
     UNION ALL
     SELECT o.id, o.name, false FROM identity.organization o
       JOIN identity.member m ON m.organization_id = o.id AND m.user_id = $1
      WHERE o.deleted_at IS NULL AND o.id = ANY($2::text[])`,
    [userId, [...ids]],
  );
  const labels = new Map<string, string>();
  for (const row of result.rows) {
    const label = row.session ? deviceOf(row.label) : row.label;
    if (label !== null && label !== "") labels.set(row.id, label);
  }
  return labels;
}

/** `GET /api/audit-log` (§14.2, §14.5). */
export async function organisationLog(
  tx: UnitTx,
  actor: OrgActor,
  query: AuditLogQuery,
  now: Date,
): Promise<{
  items: AuditLogRow[];
  total: number;
  totalCapped: boolean;
  filterLabel: string | null;
}> {
  checkPaging(query);
  const window = windowOf(query, now);
  const offset = (query.page - 1) * query.size;
  const result = await tx.query<RawRow>(
    `SELECT * FROM identity.organization_audit_log($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      actor.person.sessionId,
      actor.organization.id,
      query.type ?? null,
      window.from,
      window.to,
      query.target ?? null,
      query.targetKind ?? null,
      query.q ?? null,
      query.size,
      offset,
    ],
  );
  const total = Number(result.rows[0]?.total ?? 0);
  const filter = query.target === undefined ? [] : [query.target];
  const labels = await labelsInOrganisation(tx, actor.organization.id, idsOf(result.rows, filter));
  return {
    items: result.rows.map((row) => toRow(row, labels)),
    total: Math.min(total, 10_000),
    totalCapped: total > 10_000,
    filterLabel: query.target === undefined ? null : (labels.get(query.target) ?? null),
  };
}

/** `GET /api/account/activity` (§14.2, §14.5): the person-scope rows of §16.2 for this person. */
export async function personActivity(
  tx: UnitTx,
  who: Guarded,
  page: { page: number; size: number },
): Promise<{ items: AuditLogRow[]; total: number; totalCapped: boolean }> {
  checkPaging(page);
  const result = await tx.query<RawRow>("SELECT * FROM identity.person_activity($1, $2, $3)", [
    who.person.sessionId,
    page.size,
    (page.page - 1) * page.size,
  ]);
  const total = Number(result.rows[0]?.total ?? 0);
  const labels = await labelsOfPerson(tx, who.person.id, idsOf(result.rows));
  return {
    items: result.rows.map((row) => toRow(row, labels)),
    total: Math.min(total, 10_000),
    totalCapped: total > 10_000,
  };
}
