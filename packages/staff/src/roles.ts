// `GET /api/staff-roles` and `GET /api/staff-roles/:roleKey` (spec 02 §10.7, must-have): the four
// prebuilt roles (and custom staff roles once stretch 3 adds them), with what each allows, its
// summary and how many members hold it, for the Staff page's Roles card and role picker.
import type { StaffPermission } from "@fin/access";
import {
  customStaffRole,
  PREBUILT_ROLE_KEYS,
  resolveStaffRole,
  STAFF_CATALOGUE,
  type StaffRoleLookup,
  staffPermissionsOf,
  staffRoleLabel,
  staffRoleSummary,
} from "./catalogue.ts";
import { StaffRefusal } from "./errors.ts";
import type { UnitTx } from "./ports.ts";

export interface StaffRoleView {
  key: string;
  kind: "prebuilt" | "custom";
  label: string;
  summary: string;
  topRole: boolean;
  holders: number;
  permissions: StaffPermission[];
}

export interface StaffRoleDetail extends StaffRoleView {
  groups: {
    key: string;
    label: string;
    permissions: { key: StaffPermission; label: string; held: boolean }[];
  }[];
}

async function holders(tx: UnitTx): Promise<Map<string, number>> {
  const result = await tx.query<{ role_key: string; n: number }>(
    "SELECT role_key, count(*)::integer AS n FROM staff.member WHERE status <> 'removed' GROUP BY role_key",
  );
  return new Map(result.rows.map((r) => [r.role_key, Number(r.n)]));
}

function view(key: string, role: StaffRoleLookup, held: number): StaffRoleView {
  const permissions = staffPermissionsOf(role);
  return {
    key,
    kind: typeof role !== "string" && role.kind === "custom" ? "custom" : "prebuilt",
    label: staffRoleLabel(role),
    summary: staffRoleSummary(role),
    topRole: key === STAFF_CATALOGUE.topRoleKey,
    holders: held,
    permissions: STAFF_CATALOGUE.keys.filter((k) => permissions.has(k)),
  };
}

export async function listStaffRoles(tx: UnitTx): Promise<StaffRoleView[]> {
  const counts = await holders(tx);
  const out: StaffRoleView[] = [];
  for (const key of PREBUILT_ROLE_KEYS) {
    out.push(view(key, { kind: "built_in", key }, counts.get(key) ?? 0));
  }
  // Custom roles by name in code-point order (COLLATE "C"), the same on every server: a bare ORDER
  // BY follows the database's collation, and glibc's en_US.utf8 (CI's Postgres image) orders names
  // with spaces or punctuation otherwise.
  const custom = await tx.query<{ id: string }>(
    'SELECT id FROM staff.role ORDER BY lower(name) COLLATE "C", id',
  );
  for (const row of custom.rows) {
    const record = await customStaffRole(tx, row.id);
    if (record !== undefined) {
      out.push(view(row.id, { kind: "custom", ...record }, counts.get(row.id) ?? 0));
    }
  }
  return out;
}

export async function getStaffRole(tx: UnitTx, roleKey: string): Promise<StaffRoleDetail> {
  const role = await resolveStaffRole(tx, roleKey);
  if (typeof role === "string") throw new StaffRefusal("not_found", "staff_role.not_found");
  const counts = await holders(tx);
  const base = view(roleKey, role, counts.get(roleKey) ?? 0);
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
