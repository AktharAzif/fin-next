// The staff-change lock and the last Admin (spec 02 §10.8, §8.5, [SA-32], T-SAT-24). Every staff
// change starts its transaction with the one lock row, then reads the actor's and the target's
// roles again, so two concurrent demotions or removals of the last two active Admins cannot both
// pass: the second waits for the first to commit and then counts what is left.
import type { StaffPermission } from "@fin/access";
import { AuthRefusal } from "@fin/identity";
import { resolveStaffRole, type StaffRoleLookup, staffPermissionsOf } from "./catalogue.ts";
import type { Queryable } from "./ports.ts";

export interface MemberRow {
  id: string;
  email: string;
  roleKey: string;
  status: "pending" | "active" | "removed";
}

export async function takeStaffChangeLock(tx: Queryable): Promise<void> {
  const result = await tx.query("SELECT 1 FROM staff.change_lock WHERE id = 1 FOR UPDATE");
  if (result.rowCount !== 1) throw new Error("staff.change_lock has no row");
}

/** A member's row, locked for the change. */
export async function memberForChange(tx: Queryable, id: string): Promise<MemberRow | null> {
  const result = await tx.query<{
    id: string;
    email: string;
    role_key: string;
    status: MemberRow["status"];
  }>("SELECT id, email, role_key, status FROM staff.member WHERE id = $1 FOR UPDATE", [id]);
  const row = result.rows[0];
  return row === undefined
    ? null
    : { id: row.id, email: row.email, roleKey: row.role_key, status: row.status };
}

/** How many active Admins there are besides `exceptId` (pending ones never count). */
export async function otherActiveAdmins(tx: Queryable, exceptId: string): Promise<number> {
  const result = await tx.query<{ n: number }>(
    "SELECT count(*)::integer AS n FROM staff.member WHERE role_key = 'admin' AND status = 'active' AND id <> $1",
    [exceptId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

export interface ActorNow {
  row: MemberRow;
  role: StaffRoleLookup;
  permissions: ReadonlySet<StaffPermission>;
}

/**
 * The actor read again inside the lock: still active, and still holding the route's permission.
 * A change that raced the actor's own removal or demotion is refused here.
 */
export async function actorInsideLock(
  tx: Queryable,
  staffId: string,
  permission: StaffPermission,
): Promise<ActorNow> {
  const row = await memberForChange(tx, staffId);
  if (row === null || row.status !== "active") {
    throw new AuthRefusal("unauthenticated", "staff.actor_gone", { reason: "signed_out" });
  }
  const role = await resolveStaffRole(tx, row.roleKey);
  const permissions = staffPermissionsOf(role);
  if (!permissions.has(permission)) {
    throw new AuthRefusal("forbidden", "staff.permission", { permission });
  }
  return { row, role, permissions };
}
