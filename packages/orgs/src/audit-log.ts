// The console's audit reads (spec 02 §14.5, §15.2.1, S2-43): the organisation's log for a member
// whose role holds `auditLog.read`, and the person's own activity. They read `audit.event` only
// through the two SECURITY DEFINER functions of `_orgs_views`, which re-check the session, the gate,
// the membership and the permission from the session's own row (the stand-in for `api`'s door until
// it exists, recorded). `target` and `targetKind` filter inside the organisation's own rows, and a
// filter label is resolved only for an object of this organisation, so another organisation's ID
// matches nothing and names nothing.
import { deviceSummary, type UnitTx } from "@fin/identity";
import type { Guarded, OrgActor } from "./guard.ts";
import { isId } from "./ids.ts";

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
  target: string;
  refs: string[];
  metadata: Record<string, unknown>;
  verification: Verification;
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
  step_up_method: string | null;
  target_id: string;
  ref_ids: string[];
  metadata: Record<string, unknown>;
  client_ip: string | null;
  user_agent: string | null;
  total: string | number;
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

function verificationOf(method: string | null): Verification {
  return method === "passkey" || method === "totp" || method === "backup_code" ? method : "session";
}

/** A short device summary from a user agent ([BC-03]): the realm's own, never the raw string. */
export function deviceOf(userAgent: string | null): string | null {
  return userAgent === null || userAgent === "" ? null : deviceSummary(userAgent);
}

function toRow(row: RawRow): AuditLogRow {
  return {
    id: row.id,
    event: row.event,
    category: row.category,
    at: row.recorded_at.toISOString(),
    actor: {
      kind: row.actor_kind,
      id: row.actor_id,
      via: row.actor_via,
      name: row.actor_name ?? null,
      email: row.actor_email ?? null,
    },
    target: row.target_id,
    refs: row.ref_ids,
    metadata: row.metadata,
    verification: verificationOf(row.step_up_method),
    address: row.client_ip,
    device: deviceOf(row.user_agent),
  };
}

/** The current label of an object of this organisation, or null (§14.2's `filterLabel`). */
async function labelInOrganisation(
  tx: UnitTx,
  orgId: string,
  target: string,
): Promise<string | null> {
  const one = async (sql: string): Promise<string | null> => {
    const result = await tx.query<{ label: string | null }>(sql, [orgId, target]);
    const label = result.rows[0]?.label;
    return label === undefined || label === null || label === "" ? null : label;
  };
  if (isId(target, "mem")) {
    return one(`SELECT coalesce(nullif(u.name, ''), u.email) AS label FROM identity.member m
      JOIN identity."user" u ON u.id = m.user_id WHERE m.organization_id = $1 AND m.id = $2`);
  }
  if (isId(target, "inv")) {
    return one(
      "SELECT email AS label FROM identity.invitation WHERE organization_id = $1 AND id = $2",
    );
  }
  if (isId(target, "rol")) {
    return one("SELECT name AS label FROM identity.role WHERE organization_id = $1 AND id = $2");
  }
  if (isId(target, "org")) {
    return one("SELECT name AS label FROM identity.organization WHERE id = $1 AND id = $2");
  }
  if (/^usr_[0-9a-hjkmnp-tv-z]{26}$/.test(target)) {
    return one(`SELECT coalesce(nullif(u.name, ''), u.email) AS label FROM identity.member m
      JOIN identity."user" u ON u.id = m.user_id WHERE m.organization_id = $1 AND u.id = $2`);
  }
  return null;
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
  return {
    items: result.rows.map(toRow),
    total: Math.min(total, 10_000),
    totalCapped: total > 10_000,
    filterLabel:
      query.target === undefined
        ? null
        : await labelInOrganisation(tx, actor.organization.id, query.target),
  };
}

/** `GET /api/account/activity` (§14.2, §14.5): the person-scope rows of §16.2 for this person. */
export async function personActivity(
  tx: UnitTx,
  who: Guarded,
  page: { page: number; size: number },
): Promise<{ items: AuditLogRow[]; total: number; totalCapped: boolean }> {
  const result = await tx.query<RawRow>("SELECT * FROM identity.person_activity($1, $2, $3)", [
    who.person.sessionId,
    page.size,
    (page.page - 1) * page.size,
  ]);
  const total = Number(result.rows[0]?.total ?? 0);
  return {
    items: result.rows.map(toRow),
    total: Math.min(total, 10_000),
    totalCapped: total > 10_000,
  };
}
