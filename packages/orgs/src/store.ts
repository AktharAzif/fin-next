// The organisation tables, read and written in the request's unit of work (spec 02 §13.2). Every
// team change runs inside the team-change lock (§9.5): the organisation's row first, then member
// rows in ID order, so two concurrent demotions of the last two Super admins cannot both pass.
import {
  type CustomRoleRecord,
  type DashboardRoleKey,
  dashboardCatalogue,
  permissionsOf,
  type RoleLookup,
  resolveRole,
  roleLabel,
} from "@fin/access";
import type { UnitTx } from "@fin/identity";

export const CATALOGUE = dashboardCatalogue;
export const TOP_ROLE = dashboardCatalogue.topRoleKey;

export interface OrganizationRow {
  id: string;
  name: string;
  liveStatus: string;
  createdBy: string;
  createdAt: Date;
}

interface RawOrganization {
  id: string;
  name: string;
  live_status: string;
  created_by: string;
  created_at: Date;
}

function toOrganization(row: RawOrganization): OrganizationRow {
  return {
    id: row.id,
    name: row.name,
    liveStatus: row.live_status,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * The team-change lock (§9.5): the live organisation's row, locked for this transaction, or null
 * when it does not exist or was deleted. It is the first lock every team change takes.
 */
export async function lockOrganization(tx: UnitTx, orgId: string): Promise<OrganizationRow | null> {
  const result = await tx.query<RawOrganization>(
    `SELECT id, name, live_status, created_by, created_at FROM identity.organization
      WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [orgId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toOrganization(row);
}

/** The live organisation, unlocked (reads only). */
export async function organizationById(tx: UnitTx, orgId: string): Promise<OrganizationRow | null> {
  const result = await tx.query<RawOrganization>(
    `SELECT id, name, live_status, created_by, created_at FROM identity.organization
      WHERE id = $1 AND deleted_at IS NULL`,
    [orgId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toOrganization(row);
}

export interface MemberRow {
  id: string;
  organizationId: string;
  userId: string;
  roleKey: string;
  invitedBy: string | null;
  createdAt: Date;
  name: string;
  email: string;
}

interface RawMember {
  id: string;
  organization_id: string;
  user_id: string;
  role_key: string;
  invited_by: string | null;
  created_at: Date;
  name: string;
  email: string;
}

function toMember(row: RawMember): MemberRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    roleKey: row.role_key,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    name: row.name,
    email: row.email,
  };
}

const MEMBER_COLUMNS = `m.id, m.organization_id, m.user_id, m.role_key, m.invited_by, m.created_at,
  u.name, u.email`;

/** The person's membership of the organisation, or null. */
export async function membershipOf(
  tx: UnitTx,
  orgId: string,
  userId: string,
  options: { lock?: boolean } = {},
): Promise<MemberRow | null> {
  const result = await tx.query<RawMember>(
    `SELECT ${MEMBER_COLUMNS} FROM identity.member m JOIN identity."user" u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.user_id = $2${options.lock === true ? " FOR UPDATE OF m" : ""}`,
    [orgId, userId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toMember(row);
}

/** A member of this organisation by ID, or null (another organisation's member is not found). */
export async function memberById(
  tx: UnitTx,
  orgId: string,
  memberId: string,
): Promise<MemberRow | null> {
  const result = await tx.query<RawMember>(
    `SELECT ${MEMBER_COLUMNS} FROM identity.member m JOIN identity."user" u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.id = $2`,
    [orgId, memberId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toMember(row);
}

/**
 * Locks the named member rows of the organisation in ID order (§9.5's lock order) and reads them
 * again, so the roles a team change checks are the roles it changes.
 */
export async function lockMembers(
  tx: UnitTx,
  orgId: string,
  memberIds: readonly string[],
): Promise<Map<string, MemberRow>> {
  const ids = [...new Set(memberIds)].sort();
  const result = await tx.query<RawMember>(
    `SELECT ${MEMBER_COLUMNS} FROM identity.member m JOIN identity."user" u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.id = ANY($2::text[])
      ORDER BY m.id FOR UPDATE OF m`,
    [orgId, ids],
  );
  return new Map(result.rows.map((row) => [row.id, toMember(row)]));
}

export async function membersOf(tx: UnitTx, orgId: string): Promise<MemberRow[]> {
  const result = await tx.query<RawMember>(
    `SELECT ${MEMBER_COLUMNS} FROM identity.member m JOIN identity."user" u ON u.id = m.user_id
      WHERE m.organization_id = $1 ORDER BY m.created_at, m.id`,
    [orgId],
  );
  return result.rows.map(toMember);
}

/** How many members other than `exceptMemberId` hold the top role now (read inside the lock). */
export async function otherTopHolders(
  tx: UnitTx,
  orgId: string,
  exceptMemberId: string,
): Promise<number> {
  const result = await tx.query<{ n: number }>(
    `SELECT count(*)::integer AS n FROM identity.member
      WHERE organization_id = $1 AND role_key = $2 AND id <> $3`,
    [orgId, TOP_ROLE, exceptMemberId],
  );
  return Number(result.rows[0]?.n ?? Number.NaN);
}

export interface CustomRole extends CustomRoleRecord {
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The organisation's custom roles with their stored permissions, by ID. */
export async function customRolesOf(
  tx: UnitTx,
  orgId: string,
  options: { lock?: boolean } = {},
): Promise<Map<string, CustomRole>> {
  const result = await tx.query<{
    id: string;
    name: string;
    description: string;
    version: number;
    created_at: Date;
    updated_at: Date;
    permissions: string[] | null;
  }>(
    `SELECT r.id, r.name, r.description, r.version, r.created_at, r.updated_at,
            (SELECT array_agg(rp.permission ORDER BY rp.permission)
               FROM identity.role_permission rp WHERE rp.role_id = r.id) AS permissions
       FROM identity.role r WHERE r.organization_id = $1
      ORDER BY r.created_at, r.id${options.lock === true ? " FOR UPDATE OF r" : ""}`,
    [orgId],
  );
  return new Map(
    result.rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        description: row.description,
        permissions: row.permissions ?? [],
        version: Number(row.version),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    ]),
  );
}

/** Resolves a stored role key against the organisation's custom roles (fails closed). */
export function lookupRole(
  roles: ReadonlyMap<string, CustomRoleRecord>,
  roleKey: string,
): RoleLookup<DashboardRoleKey> {
  return resolveRole(CATALOGUE, roleKey, (id) => roles.get(id));
}

export function labelOf(role: RoleLookup): string {
  return roleLabel(CATALOGUE, role);
}

export function permissionsFor(role: RoleLookup) {
  return permissionsOf(CATALOGUE, role);
}

/** The addresses of the organisation's members holding one of the built-in roles given. */
export async function addressesOfRoles(
  tx: UnitTx,
  orgId: string,
  roleKeys: readonly string[],
): Promise<{ userId: string; email: string }[]> {
  const result = await tx.query<{ user_id: string; email: string }>(
    `SELECT m.user_id, u.email FROM identity.member m JOIN identity."user" u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.role_key = ANY($2::text[]) ORDER BY m.id`,
    [orgId, [...roleKeys]],
  );
  return result.rows.map((r) => ({ userId: r.user_id, email: r.email }));
}

/** A person's live memberships, with their organisations, oldest first. */
export async function membershipsOfPerson(
  tx: UnitTx,
  userId: string,
): Promise<
  {
    memberId: string;
    orgId: string;
    orgName: string;
    liveStatus: string;
    roleKey: string;
    createdAt: Date;
  }[]
> {
  const result = await tx.query<{
    member_id: string;
    org_id: string;
    org_name: string;
    live_status: string;
    role_key: string;
    created_at: Date;
  }>(
    `SELECT m.id AS member_id, o.id AS org_id, o.name AS org_name, o.live_status, m.role_key,
            m.created_at
       FROM identity.member m
       JOIN identity.organization o ON o.id = m.organization_id AND o.deleted_at IS NULL
      WHERE m.user_id = $1 ORDER BY m.created_at, m.id`,
    [userId],
  );
  return result.rows.map((r) => ({
    memberId: r.member_id,
    orgId: r.org_id,
    orgName: r.org_name,
    liveStatus: r.live_status,
    roleKey: r.role_key,
    createdAt: r.created_at,
  }));
}

/** The custom roles of several organisations at once, by organisation (the viewer's memberships). */
export async function customRolesOfMany(
  tx: UnitTx,
  orgIds: readonly string[],
): Promise<Map<string, Map<string, CustomRoleRecord>>> {
  const out = new Map<string, Map<string, CustomRoleRecord>>();
  if (orgIds.length === 0) return out;
  const result = await tx.query<{
    organization_id: string;
    id: string;
    name: string;
    description: string;
    permissions: string[] | null;
  }>(
    `SELECT r.organization_id, r.id, r.name, r.description,
            (SELECT array_agg(rp.permission ORDER BY rp.permission)
               FROM identity.role_permission rp WHERE rp.role_id = r.id) AS permissions
       FROM identity.role r WHERE r.organization_id = ANY($1::text[])`,
    [[...orgIds]],
  );
  for (const row of result.rows) {
    const roles = out.get(row.organization_id) ?? new Map<string, CustomRoleRecord>();
    roles.set(row.id, {
      id: row.id,
      name: row.name,
      description: row.description,
      permissions: row.permissions ?? [],
    });
    out.set(row.organization_id, roles);
  }
  return out;
}
