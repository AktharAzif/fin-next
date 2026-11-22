// Custom staff roles (spec 02 §10.7, §8.4; [SA-12]; stretch 3): up to 30 roles beside the four
// prebuilt ones, made, changed and deleted by a member of staff with `staffRoles.manage` (an
// Admin-only permission, so in practice an Admin), each with an intent. Every change runs in the
// route's unit of work, in the order every staff change keeps (S2-31, §10.8):
//   1. the staff-change lock, then the actor read again (still active, still holding the
//      permission) and every custom role read `FOR UPDATE`;
//   2. the rules: the permission engine's own editor validation (`validateRole`, with the identity
//      package's name rules and the other roles' names), and the name compared again as the
//      `staff_role_name` index compares it, so a name the index would refuse is refused here
//      too; who may edit or delete which role (`editingProblem`, `deletionProblem`: never a
//      prebuilt role, never the actor's own role, never one that allows something the actor
//      lacks), the optimistic `version`, the 30-role limit, and, when holders move, the members
//      the request names as the holders it showed, the giving rules for the role they move to and
//      the last Admin;
//   3. only then the intent (`who.stepUp`), spent in the same transaction as the change, its audit
//      events, its revocation-journal entry and its notices;
//   4. the edit allowance (30 an hour and 100 a day per person), counted once the change goes
//      ahead, so asking for a factor never spends it.
// A refusal at any step writes nothing. An edit applies on each holder's next request, since
// permissions are read with the member on every request; a holder moved off a deleted role has
// their sessions ended at once, as any role change does (S2-20).
import {
  customRoleLimitReached,
  deletionProblem,
  editingProblem,
  isPermission,
  permissionDiff,
  ROLE_EDIT_LIMITS,
  type RoleProblem,
  type StaffPermission,
  sortPermissions,
  validateRole,
} from "@fin/access";
import { AuthRefusal, checkName } from "@fin/identity";
import {
  lowers,
  resolveStaffRole,
  STAFF_CATALOGUE,
  type StaffRoleLookup,
  staffPermissionsOf,
  staffRoleLabel,
} from "./catalogue.ts";
import type { StaffDeps } from "./deps.ts";
import { activeAdminAddresses } from "./email.ts";
import { StaffRefusal } from "./errors.ts";
import { isIdOf, newId } from "./ids.ts";
import { type ActorNow, actorInsideLock, type MemberRow, takeStaffChangeLock } from "./lock.ts";
import { refuseLastActiveAdmin } from "./members.ts";
import { type Queryable, sqlState, type UnitTx } from "./ports.ts";
import type { StaffActor } from "./require-staff.ts";
import { type CustomStaffRoleRow, customStaffRoleRows } from "./roles.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The edit allowance's bucket and windows (§8.4: 30 edits an hour and 100 a day per person). */
export const STAFF_ROLE_EDIT_BUCKET = "staff_role_edit";
export const STAFF_ROLE_EDIT_WINDOWS = [
  { ms: HOUR, max: ROLE_EDIT_LIMITS.perHour },
  { ms: DAY, max: ROLE_EDIT_LIMITS.perDay },
] as const;

/** The editor's draft as a request carries it. */
export interface StaffRoleDraft {
  name: string;
  description: string;
  permissions: readonly string[];
}

const NAME_RULES = {
  roleName: (name: string) => checkName("roleName", name).ok,
  roleDescription: (description: string) => checkName("roleDescription", description).ok,
};

/** Which field each draft problem belongs to (`beyond` is a giving refusal, not a field's). */
const PROBLEM_FIELD: Readonly<Record<Exclude<RoleProblem, "beyond">, string>> = {
  name: "name",
  name_taken: "name",
  reads_as_built_in: "name",
  description: "description",
  empty: "permissions",
  restricted: "permissions",
  missing_need: "permissions",
};

/**
 * A role's name or description in the form it is checked and stored in (NFC, trimmed, one space
 * between words), when the identity package's rule accepts it; otherwise the text as sent, which
 * the editor validation then refuses.
 */
export function cleanRoleText(kind: "roleName" | "roleDescription", value: string): string {
  const checked = checkName(kind, value);
  return checked.ok ? checked.value : value;
}

/**
 * Refuses a draft as the role editor does: a permission the actor's role does not allow (or one
 * the catalogue does not know) is `403 giving_refused` with `problem: beyond`; every other problem
 * is `400 invalid` naming its field and the problem, never the value (§14.1). `takenInStore` says
 * the database's unique name index holds the name for another role (`nameTakenInStore`), which
 * is `name_taken` too, in the engine's order, even where the engine's own comparison tells the
 * two names apart.
 */
export function checkStaffRoleDraft(
  actorPerms: ReadonlySet<StaffPermission>,
  draft: StaffRoleDraft,
  otherNames: readonly string[],
  options: { takenInStore?: boolean } = {},
): void {
  const problems = validateRole(
    STAFF_CATALOGUE,
    {
      name: draft.name,
      description: draft.description,
      permissions: draft.permissions as StaffPermission[],
    },
    actorPerms,
    { takenNames: otherNames, names: NAME_RULES },
  );
  if (options.takenInStore === true && !problems.includes("name_taken")) {
    // `name`, when it is there, is always the first problem, and `name_taken` the next.
    problems.splice(problems[0] === "name" ? 1 : 0, 0, "name_taken");
  }
  if (problems.includes("beyond")) {
    throw new StaffRefusal("giving_refused", "staff_role.beyond", { problem: "beyond" });
  }
  if (problems.length > 0) {
    const fields = problems
      .filter((p): p is Exclude<RoleProblem, "beyond"> => p !== "beyond")
      .map((p) => ({ path: PROBLEM_FIELD[p], code: p }));
    throw new StaffRefusal("invalid", "staff_role.invalid", { fields });
  }
}

/** The draft's permissions the catalogue knows, once each, in the catalogue's order. */
function knownPermissions(permissions: readonly string[]): StaffPermission[] {
  return sortPermissions(
    STAFF_CATALOGUE,
    permissions.filter((p): p is StaffPermission => isPermission(STAFF_CATALOGUE, p)),
  );
}

function lookupOf(row: CustomStaffRoleRow): StaffRoleLookup {
  return {
    kind: "custom",
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: row.permissions,
  };
}

/** The unique index on custom staff role names (the staff area's first migration). */
const NAME_INDEX = "staff_role_name";

/**
 * Whether another custom staff role's stored name is the same as `name` the way the
 * `staff_role_name` index compares names: `lower(name)` in the database's collation, which can fold
 * letters the editor's own comparison keeps apart (a capital I with a dot above, under a libc
 * collation). Read inside the staff-change lock with every role row locked, so no name can be
 * written between this read and the change's own write.
 */
export async function nameTakenInStore(
  db: Queryable,
  name: string,
  exceptRoleId: string | null,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM staff.role
      WHERE lower(name) = lower($1) AND ($2::text IS NULL OR id <> $2) LIMIT 1`,
    [name, exceptRoleId],
  );
  return result.rowCount > 0;
}

/**
 * A write the name index refused, as the editor's refusal: `400 invalid` with `name_taken` on the
 * name. The check inside the lock (`nameTakenInStore`) comes first, so this is only a backstop;
 * anything else is not a refusal (null).
 */
export function nameTakenRefusal(error: unknown): StaffRefusal | null {
  if (sqlState(error) !== "23505") return null;
  if ((error as { constraint?: unknown }).constraint !== NAME_INDEX) return null;
  return new StaffRefusal("invalid", "staff_role.name_taken", {
    fields: [{ path: "name", code: "name_taken" }],
  });
}

/** Runs a write of a role's name, answering the name index's refusal as the editor's. */
async function writeName(run: () => Promise<{ rowCount: number }>): Promise<{ rowCount: number }> {
  try {
    return await run();
  } catch (error) {
    throw nameTakenRefusal(error) ?? error;
  }
}

/** Whether two lists name the same members, once each, in any order. */
function sameMembers(held: readonly string[], named: readonly string[]): boolean {
  const now = new Set(held);
  const shown = new Set(named);
  return now.size === shown.size && [...now].every((id) => shown.has(id));
}

/** Counts one edit against the actor's allowance; past it, `429` and the whole unit rolls back. */
async function countEdit(deps: StaffDeps, tx: UnitTx, staffId: string): Promise<void> {
  const result = await deps.realm.runtime.limits.consumeWindows(
    tx,
    STAFF_ROLE_EDIT_BUCKET,
    STAFF_ROLE_EDIT_WINDOWS,
    staffId,
  );
  if (!result.allowed) {
    throw new AuthRefusal(
      "rate_limited",
      `limits.${STAFF_ROLE_EDIT_BUCKET}`,
      { retry_after: result.retryAfter },
      { rollback: true },
    );
  }
}

/** The lock, the actor read again with `staffRoles.manage`, and every custom role, locked. */
async function lockForRoles(
  tx: UnitTx,
  who: StaffActor,
): Promise<{ actor: ActorNow; roles: CustomStaffRoleRow[] }> {
  await takeStaffChangeLock(tx);
  const actor = await actorInsideLock(tx, who.staffId, "staffRoles.manage");
  const roles = await customStaffRoleRows(tx, { forUpdate: true });
  return { actor, roles };
}

/** The custom role a path names, among the locked rows; a prebuilt key or no row is a 404. */
function roleNamed(roles: readonly CustomStaffRoleRow[], roleId: string): CustomStaffRoleRow {
  if (!isIdOf(roleId, "srl")) throw new StaffRefusal("not_found", "staff_role.id");
  const row = roles.find((r) => r.id === roleId);
  if (row === undefined) throw new StaffRefusal("not_found", "staff_role.gone");
  return row;
}

function refuseEditing(actor: ActorNow, role: StaffRoleLookup): void {
  const problem = editingProblem(STAFF_CATALOGUE, {
    actorRoleKey: actor.row.roleKey,
    actorPerms: actor.permissions,
    role,
  });
  if (problem === null) return;
  if (problem === "gone" || problem === "built_in") {
    throw new StaffRefusal("not_found", `staff_role.${problem}`);
  }
  if (problem === "outranked") throw new StaffRefusal("outranked", "staff_role.outranked");
  throw new StaffRefusal("giving_refused", "staff_role.self", { problem: "self" });
}

/** The members who hold a role now (pending or active), locked for the change. */
async function holdersOf(tx: UnitTx, roleId: string): Promise<MemberRow[]> {
  const result = await tx.query<{
    id: string;
    email: string;
    role_key: string;
    status: MemberRow["status"];
  }>(
    `SELECT id, email, role_key, status FROM staff.member
      WHERE role_key = $1 AND status <> 'removed' ORDER BY id FOR UPDATE`,
    [roleId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    email: r.email,
    roleKey: r.role_key,
    status: r.status,
  }));
}

/** `staff-role-permissions-changed` to the role's holders and every active Admin, once each. */
async function noticeRoleChanged(
  deps: StaffDeps,
  tx: UnitTx,
  holders: readonly MemberRow[],
  roleLabel: string,
): Promise<number> {
  const recipients = new Set(holders.map((h) => h.email));
  for (const admin of await activeAdminAddresses(tx)) recipients.add(admin.email);
  for (const to of recipients) {
    await deps.notify(tx, {
      template: "staff/staff-role-permissions-changed",
      to,
      params: { roleLabel },
    });
  }
  return recipients.size;
}

export interface SavedStaffRole {
  roleId: string;
  version: number;
}

/** `POST /api/staff-roles` (§10.7, §8.4): `staffRoles.manage`, an intent, the editor's rules. */
export async function createStaffRole(
  deps: StaffDeps,
  tx: UnitTx,
  who: StaffActor,
  body: StaffRoleDraft,
): Promise<SavedStaffRole> {
  const { actor, roles } = await lockForRoles(tx, who);
  const name = cleanRoleText("roleName", body.name);
  const description = cleanRoleText("roleDescription", body.description);
  if (customRoleLimitReached(roles.length)) {
    throw new StaffRefusal("limit_reached", "limits.custom_staff_roles", { limit: 30 });
  }
  checkStaffRoleDraft(
    actor.permissions,
    { name, description, permissions: body.permissions },
    roles.map((r) => r.name),
    { takenInStore: await nameTakenInStore(tx, name, null) },
  );
  const stepUp = await who.stepUp(tx, {
    action: "staffRole.create",
    target: null,
    body: { name, description, permissions: [...body.permissions] },
  });
  await countEdit(deps, tx, who.staffId);
  const permissions = knownPermissions(body.permissions);
  const roleId = newId("srl", deps.clock);
  const now = deps.clock.now();
  await writeName(() =>
    tx.query(
      `INSERT INTO staff.role (id, name, description, created_by, created_at, updated_at, version)
       VALUES ($1, $2, $3, $4, $5, $5, 1)`,
      [roleId, name, description, who.staffId, now],
    ),
  );
  await tx.query(
    "INSERT INTO staff.role_permission (role_id, permission) SELECT $1, unnest($2::text[])",
    [roleId, permissions],
  );
  await deps.audit(tx, {
    event: "staff.role_created",
    actor: { ...who.actor, stepUp },
    target: roleId,
    metadata: { permissions },
    request: who.request,
  });
  deps.lines.write("staff.changed", "warn", {
    kind: "role_created",
    roleId,
    actorId: who.staffId,
  });
  return { roleId, version: 1 };
}

/**
 * `PUT /api/staff-roles/:roleId` (§10.7, §8.4): `staffRoles.manage`, an intent; never a prebuilt
 * role, the actor's own, or one that allows something the actor lacks; the optimistic `version`
 * (a stale save is `409 conflict`). Holders and every Admin are told when the permissions change.
 */
export async function updateStaffRole(
  deps: StaffDeps,
  tx: UnitTx,
  who: StaffActor,
  roleId: string,
  body: StaffRoleDraft & { version: number },
): Promise<SavedStaffRole & { holders: number; added: number; removed: number }> {
  const { actor, roles } = await lockForRoles(tx, who);
  const row = roleNamed(roles, roleId);
  const role = lookupOf(row);
  refuseEditing(actor, role);
  if (body.version !== row.version) throw new StaffRefusal("conflict", "staff_role.stale_version");
  const name = cleanRoleText("roleName", body.name);
  const description = cleanRoleText("roleDescription", body.description);
  checkStaffRoleDraft(
    actor.permissions,
    { name, description, permissions: body.permissions },
    roles.filter((r) => r.id !== roleId).map((r) => r.name),
    { takenInStore: await nameTakenInStore(tx, name, roleId) },
  );
  const stepUp = await who.stepUp(tx, {
    action: "staffRole.update",
    target: roleId,
    body: { name, description, permissions: [...body.permissions], version: body.version },
  });
  await countEdit(deps, tx, who.staffId);
  const before = [...staffPermissionsOf(role)];
  const after = knownPermissions(body.permissions);
  const { added, removed } = permissionDiff(STAFF_CATALOGUE, before, after);
  const now = deps.clock.now();
  const updated = await writeName(() =>
    tx.query(
      `UPDATE staff.role SET name = $2, description = $3, version = version + 1, updated_at = $4
        WHERE id = $1 AND version = $5`,
      [roleId, name, description, now, body.version],
    ),
  );
  if (updated.rowCount !== 1) throw new StaffRefusal("conflict", "staff_role.stale_version");
  // The stored rows become the known set, so a stored name that broke a rule does not linger.
  await tx.query("DELETE FROM staff.role_permission WHERE role_id = $1", [roleId]);
  await tx.query(
    "INSERT INTO staff.role_permission (role_id, permission) SELECT $1, unnest($2::text[])",
    [roleId, after],
  );
  const holders = await holdersOf(tx, roleId);
  await deps.audit(tx, {
    event: "staff.role_updated",
    actor: { ...who.actor, stepUp },
    target: roleId,
    metadata: {
      added: [...added],
      removed: [...removed],
      holders: holders.length,
      renamed: name !== row.name,
    },
    request: who.request,
  });
  if (added.length > 0 || removed.length > 0) {
    await noticeRoleChanged(deps, tx, holders, name);
  }
  deps.lines.write("staff.changed", "warn", {
    kind: "role_updated",
    roleId,
    actorId: who.staffId,
    lowered: removed.length > 0,
  });
  return {
    roleId,
    version: row.version + 1,
    holders: holders.length,
    added: added.length,
    removed: removed.length,
  };
}

/**
 * `POST /api/staff-roles/:roleId/delete` (§10.7, §8.4): `staffRoles.manage`, an intent; every
 * holder moves to `moveTo`, a role the actor may give in place of this one, which needs
 * `staff.role` as well (the move permission). Each move is a role change: `staff.role_changed`
 * with `reason: role_deleted`, the holder's sessions ended (S2-20) and `staff-access-changed` to
 * them and every Admin. The last active Admin stays (§10.8).
 *
 * `holders` are the members the actor was shown as holding the role (`holderIds` of the list),
 * and the intent binds them: when the members holding it now are not exactly those, the answer is
 * `409 conflict` and nobody moves, so a proved intent never moves someone given the role after
 * the actor looked (an owner's decision beyond §7.6's `moveTo`, recorded in the pull request).
 */
export async function deleteStaffRole(
  deps: StaffDeps,
  tx: UnitTx,
  who: StaffActor,
  roleId: string,
  body: { moveTo?: string | undefined; holders: readonly string[] },
): Promise<{ roleId: string; movedTo: string | null; membersMoved: number }> {
  const { actor, roles } = await lockForRoles(tx, who);
  const row = roleNamed(roles, roleId);
  const role = lookupOf(row);
  refuseEditing(actor, role);
  const holders = await holdersOf(tx, roleId);
  const heldNow = holders.map((holder) => holder.id);
  if (!sameMembers(heldNow, body.holders)) {
    throw new StaffRefusal("conflict", "staff_role.holders_changed");
  }
  const moveTo = body.moveTo === undefined ? undefined : await resolveStaffRole(tx, body.moveTo);
  const problem = deletionProblem(STAFF_CATALOGUE, {
    actorRoleKey: actor.row.roleKey,
    actorPerms: actor.permissions,
    role,
    holders: holders.length,
    // Staff have no invitations: a member is added with a role at once (§10.2).
    invitations: 0,
    ...(moveTo === undefined ? {} : { moveTo }),
  });
  if (problem !== null) {
    if (problem === "gone" || problem === "built_in") {
      throw new StaffRefusal("not_found", `staff_role.${problem}`);
    }
    if (problem === "outranked") throw new StaffRefusal("outranked", "staff_role.outranked");
    if (problem === "move_forbidden") {
      throw new StaffRefusal("forbidden", "staff_role.move_forbidden", {
        permission: STAFF_CATALOGUE.movePermission,
      });
    }
    throw new StaffRefusal("giving_refused", `staff_role.${problem}`, {
      problem: problem === "move_gone" ? "gone" : problem,
    });
  }
  const moving = holders.length > 0 && moveTo !== undefined ? moveTo : null;
  if (moving !== null) {
    for (const holder of holders) {
      await refuseLastActiveAdmin(tx, holder, role, { newRole: moving });
    }
  }
  const stepUp = await who.stepUp(tx, {
    action: "staffRole.delete",
    target: roleId,
    body: { moveTo: body.moveTo, holders: [...body.holders] },
  });
  await countEdit(deps, tx, who.staffId);
  const now = deps.clock.now();
  const actorWithStepUp = { ...who.actor, stepUp };
  const movedTo = moving === null ? null : (body.moveTo ?? null);
  if (moving !== null && movedTo !== null) {
    const lowered = lowers(role, moving);
    const roleLabel = staffRoleLabel(moving);
    const admins = await activeAdminAddresses(tx);
    for (const holder of holders) {
      await deps.audit(tx, {
        event: "staff.role_changed",
        actor: actorWithStepUp,
        target: holder.id,
        refs: [roleId],
        metadata: { fromRole: roleId, toRole: movedTo, reason: "role_deleted", lowered },
        request: who.request,
      });
      await tx.query("UPDATE staff.member SET role_key = $2, updated_at = $3 WHERE id = $1", [
        holder.id,
        movedTo,
        now,
      ]);
      await tx.query("DELETE FROM staff.session WHERE user_id = $1", [holder.id]);
      await deps.notify(tx, {
        template: "staff/staff-access-changed",
        to: holder.email,
        params: { staffId: holder.id, kind: "role_changed", audience: "person", roleLabel },
      });
      for (const admin of admins) {
        if (admin.email === holder.email) continue;
        await deps.notify(tx, {
          template: "staff/staff-access-changed",
          to: admin.email,
          params: { staffId: holder.id, kind: "role_changed", audience: "admins", roleLabel },
        });
      }
      deps.lines.write("staff.changed", "warn", {
        kind: "role_changed",
        staffId: holder.id,
        actorId: who.staffId,
      });
    }
  }
  await tx.query("DELETE FROM staff.role WHERE id = $1", [roleId]);
  await deps.audit(tx, {
    event: "staff.role_deleted",
    actor: actorWithStepUp,
    target: roleId,
    metadata: { movedTo, membersMoved: holders.length },
    request: who.request,
  });
  deps.lines.write("staff.changed", "warn", {
    kind: "role_deleted",
    roleId,
    actorId: who.staffId,
    membersMoved: holders.length,
  });
  return { roleId, movedTo, membersMoved: holders.length };
}
