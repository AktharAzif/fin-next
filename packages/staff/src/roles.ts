// `GET /api/staff-roles` and `GET /api/staff-roles/:roleKey` (spec 02 §10.7, must-have): the four
// prebuilt roles and the custom staff roles (stretch 3), with what each allows, its summary, how
// many members hold it and, for a custom role, its description and the `version` a save names
// (§8.4), for the Staff page's Roles card, the role picker, AdminRoles and AdminRoleEditor.
import type { StaffPermission } from "@fin/access";
import {
  PREBUILT_ROLE_KEYS,
  resolveStaffRole,
  STAFF_CATALOGUE,
  type StaffRoleLookup,
  staffPermissionsOf,
  staffRoleLabel,
  staffRoleSummary,
} from "./catalogue.ts";
import { StaffRefusal } from "./errors.ts";
import type { Queryable, UnitTx } from "./ports.ts";

export interface StaffRoleView {
  key: string;
  kind: "prebuilt" | "custom";
  /** A prebuilt role: an immutable row in code, which no editor changes. */
  builtIn: boolean;
  label: string;
  /** A custom role's own description ('' when it has none); '' for a prebuilt role. */
  description: string;
  summary: string;
  topRole: boolean;
  holders: number;
  permissions: StaffPermission[];
  permissionCount: number;
  /** A custom role's version, which a save names (a stale one is `409 conflict`); null if prebuilt. */
  version: number | null;
}

export interface StaffRoleDetail extends StaffRoleView {
  groups: {
    key: string;
    label: string;
    permissions: { key: StaffPermission; label: string; held: boolean }[];
  }[];
}

/** A custom staff role's row as its table holds it, with its stored permission names. */
export interface CustomStaffRoleRow {
  id: string;
  name: string;
  description: string;
  version: number;
  /** As stored: names the catalogue may not know, which allow nothing (`permissionsOf`). */
  permissions: string[];
}

/**
 * Every custom staff role, or the one named, with its stored permissions, in name order. Inside
 * the staff-change lock a change reads them `FOR UPDATE`.
 */
export async function customStaffRoleRows(
  db: Queryable,
  options: { id?: string; forUpdate?: boolean } = {},
): Promise<CustomStaffRoleRow[]> {
  const result = await db.query<{
    id: string;
    name: string;
    description: string;
    version: number;
    permissions: string[] | null;
  }>(
    `SELECT r.id, r.name, r.description, r.version,
            ARRAY(SELECT p.permission FROM staff.role_permission p
                   WHERE p.role_id = r.id ORDER BY p.permission) AS permissions
       FROM staff.role r
      WHERE ($1::text IS NULL OR r.id = $1)
      ORDER BY lower(r.name), r.id
      ${options.forUpdate === true ? "FOR UPDATE OF r" : ""}`,
    [options.id ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    version: Number(row.version),
    permissions: row.permissions ?? [],
  }));
}

/** How many members (pending or active) hold each role key now. */
export async function holderCounts(db: Queryable): Promise<Map<string, number>> {
  const result = await db.query<{ role_key: string; n: number }>(
    "SELECT role_key, count(*)::integer AS n FROM staff.member WHERE status <> 'removed' GROUP BY role_key",
  );
  return new Map(result.rows.map((r) => [r.role_key, Number(r.n)]));
}

function view(
  key: string,
  role: StaffRoleLookup,
  held: number,
  custom: CustomStaffRoleRow | undefined,
): StaffRoleView {
  const permissions = staffPermissionsOf(role);
  const listed = STAFF_CATALOGUE.keys.filter((k) => permissions.has(k));
  return {
    key,
    kind: custom === undefined ? "prebuilt" : "custom",
    builtIn: custom === undefined,
    label: staffRoleLabel(role),
    description: custom?.description ?? "",
    summary: staffRoleSummary(role),
    topRole: key === STAFF_CATALOGUE.topRoleKey,
    holders: held,
    permissions: listed,
    permissionCount: listed.length,
    version: custom?.version ?? null,
  };
}

function customLookup(row: CustomStaffRoleRow): StaffRoleLookup {
  return {
    kind: "custom",
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: row.permissions,
  };
}

/** The prebuilt roles in the catalogue's order, then the custom roles by name. */
export async function listStaffRoles(tx: UnitTx): Promise<StaffRoleView[]> {
  const counts = await holderCounts(tx);
  const out: StaffRoleView[] = [];
  for (const key of PREBUILT_ROLE_KEYS) {
    out.push(view(key, { kind: "built_in", key }, counts.get(key) ?? 0, undefined));
  }
  for (const row of await customStaffRoleRows(tx)) {
    out.push(view(row.id, customLookup(row), counts.get(row.id) ?? 0, row));
  }
  return out;
}

/** One prebuilt or custom role, with every group of the catalogue and what the role holds. */
export async function getStaffRole(tx: UnitTx, roleKey: string): Promise<StaffRoleDetail> {
  const role = await resolveStaffRole(tx, roleKey);
  if (typeof role === "string") throw new StaffRefusal("not_found", "staff_role.not_found");
  const custom =
    role.kind === "custom" ? (await customStaffRoleRows(tx, { id: roleKey }))[0] : undefined;
  if (role.kind === "custom" && custom === undefined) {
    throw new StaffRefusal("not_found", "staff_role.not_found");
  }
  const counts = await holderCounts(tx);
  const base = view(roleKey, role, counts.get(roleKey) ?? 0, custom);
  const held = new Set(base.permissions);
  return {
    ...base,
    groups: STAFF_CATALOGUE.groups.map((group) => ({
      key: group.key,
      label: group.label,
      permissions: group.permissions.map((key) => ({
        key,
        label: STAFF_CATALOGUE.permissions[key].label,
        held: held.has(key),
      })),
    })),
  };
}
