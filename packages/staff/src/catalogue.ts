// Fin Admin's roles at run time (spec 02 §8.1, §8.3, §10.7, [SA-12]): a staff member's role key is
// one of the four prebuilt keys or a custom `srl_` ID, read with the member on every request and
// resolved against @fin/access's staff catalogue. Checks are by permission, never by role; a role
// Fin does not know, or a custom role that no longer exists, allows nothing.
import {
  type CustomRoleRecord,
  isCustomRoleId,
  permissionsOf,
  type RoleLookup,
  resolveRole,
  roleLabel,
  type StaffPermission,
  type StaffRoleKey,
  staffCatalogue,
  summary,
} from "@fin/access";
import type { Queryable } from "./ports.ts";

export const STAFF_CATALOGUE = staffCatalogue;
export const TOP_ROLE: StaffRoleKey = staffCatalogue.topRoleKey;
export const PREBUILT_ROLE_KEYS: readonly StaffRoleKey[] = staffCatalogue.builtIns.map(
  (role) => role.key,
);

export type StaffRoleLookup = RoleLookup<StaffRoleKey>;

/** A custom staff role's row and its stored permissions, or undefined when there is none. */
export async function customStaffRole(
  db: Queryable,
  id: string,
): Promise<CustomRoleRecord | undefined> {
  if (!isCustomRoleId(staffCatalogue, id)) return undefined;
  const result = await db.query<{
    id: string;
    name: string;
    description: string;
    permissions: string[] | null;
  }>(
    `SELECT r.id, r.name, r.description,
            array_remove(array_agg(p.permission ORDER BY p.permission), NULL) AS permissions
       FROM staff.role r LEFT JOIN staff.role_permission p ON p.role_id = r.id
      WHERE r.id = $1
      GROUP BY r.id`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: row.permissions ?? [],
  };
}

/**
 * Resolves a stored role key now: a prebuilt key, or a custom role read from its table. Never
 * cached, so a permission taken from a role stops on the holder's next request.
 */
export async function resolveStaffRole(db: Queryable, roleKey: string): Promise<StaffRoleLookup> {
  const custom = isCustomRoleId(staffCatalogue, roleKey)
    ? await customStaffRole(db, roleKey)
    : undefined;
  return resolveRole(staffCatalogue, roleKey, (id) => (custom?.id === id ? custom : undefined));
}

/** What a role allows: the prebuilt row's set, or the custom role's, minus Admin-only keys. */
export function staffPermissionsOf(role: StaffRoleLookup): ReadonlySet<StaffPermission> {
  return permissionsOf(staffCatalogue, role);
}

export function staffRoleLabel(role: StaffRoleLookup): string {
  return roleLabel(staffCatalogue, role);
}

export function staffRoleSummary(role: StaffRoleLookup): string {
  return summary(staffCatalogue, role);
}

/** Whether `key` names one of the 26 staff permissions. */
export function isStaffPermission(key: string): key is StaffPermission {
  return Object.hasOwn(staffCatalogue.permissions, key);
}

/** Whether `next` lacks something `previous` allowed: a lowered role (spec 08 §3.10). */
export function lowers(previous: StaffRoleLookup, next: StaffRoleLookup): boolean {
  const after = staffPermissionsOf(next);
  for (const key of staffPermissionsOf(previous)) if (!after.has(key)) return true;
  return false;
}
