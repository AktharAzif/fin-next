// The staff-change lock and the last Admin (spec 02 §10.8, §8.5, [SA-32], T-SAT-24). Every staff
// change starts its transaction with the one lock row, then reads the actor's and the target's
// roles again, so two concurrent demotions or removals of the last two active Admins cannot both
// pass: the second waits for the first to commit and then counts what is left.
//
// One lock order for every change, so that no two changes, and no change and ceremony, ever wait
// on each other in a circle:
//   1. the staff-change lock, before the guard reads the actor's session (requireStaff's
//      `changeLock`). Reading the session renews it once its renewal age has passed (§11.1), and
//      the renewed row stays locked until the change commits; a change that held it while it
//      waited for another (two Admins acting on each other at once) would deadlock with that change
//      ending it. Taken first, the lock is all a waiting change holds, and the second of the two
//      then finds its own session ended by the first and is refused as signed out;
//   2. the actor's session, renewed inside the lock, and the actor's row, read without a lock;
//   3. the target's ceremony lock (@fin/identity's holdCeremonyLock), which every sign-in and
//      factor ceremony of theirs takes before it holds their row: the change waits only for the
//      ceremonies queued before it, never behind a stream of them, and none runs while it holds
//      it (§10.4, §11.4);
//   4. the target's row `FOR UPDATE`, then their sessions, factors and emailed codes.
// The actor's own row and ceremony lock are never taken: a ceremony of theirs in flight holds both
// while it waits to write the session this change renewed, so a wait on either would wait on that
// ceremony while it waits on this change. That ceremony, replacing the session (a passkey step-up,
// §11.3), takes the session's row before the intents it moves to the new one, in the order this
// change takes them (the renewed session, then the intent it spends; @fin/identity's
// moveToReplacement), so it waits for this change rather than hold the intent this change waits
// for. No lock is needed: everything that can take a role or an
// active status away takes the change lock first (the changes here and the operator's bootstrap),
// so the row read inside it is the committed one, and enrolment only makes a pending member
// active. A change aimed at the actor themselves is refused on that same read, before any row is
// locked.
import type { StaffPermission } from "@fin/access";
import { AuthRefusal, holdCeremonyLock } from "@fin/identity";
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

/** Refuses to run a staff change whose guard did not take the staff-change lock first (step 1). */
export function requireChangeLock(who: { changeLocked: boolean }): void {
  if (!who.changeLocked) throw new Error("a staff change runs behind requireStaff's changeLock");
}

async function memberRow(
  tx: Queryable,
  id: string,
  lock: "" | " FOR UPDATE",
): Promise<MemberRow | null> {
  const result = await tx.query<{
    id: string;
    email: string;
    role_key: string;
    status: MemberRow["status"];
  }>(`SELECT id, email, role_key, status FROM staff.member WHERE id = $1${lock}`, [id]);
  const row = result.rows[0];
  return row === undefined
    ? null
    : { id: row.id, email: row.email, roleKey: row.role_key, status: row.status };
}

/**
 * A change's target's row, locked for the change after their ceremony lock (steps 3 and 4). Never
 * the actor's own (see above). A removed member has no ceremony to wait for: their row is returned
 * unlocked, for the change to refuse.
 */
export async function memberForChange(
  tx: Queryable,
  id: string,
  now: Date,
): Promise<MemberRow | null> {
  const found = await memberRow(tx, id, "");
  if (found === null || found.status === "removed") return found;
  await holdCeremonyLock(tx, "staff", id, now);
  return memberRow(tx, id, " FOR UPDATE");
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
 * The actor read again inside the lock, without locking their row (see above): still active, and
 * still holding the route's permission. A change that raced the actor's own removal or demotion is
 * refused here.
 */
export async function actorInsideLock(
  tx: Queryable,
  staffId: string,
  permission: StaffPermission,
): Promise<ActorNow> {
  const row = await memberRow(tx, staffId, "");
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
