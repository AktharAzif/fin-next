// Roles (spec 02 §8.2, §8.4; [SA-11], [SA-32]): the built-in Super admin and Admin, and up to 30
// custom roles per organisation, edited through the permission engine's own validation
// (`validateRole`, `editingProblem`, `deletionProblem`) with the identity package's name rules. An
// edit applies on each holder's next request; adding a privileged permission puts holders without a
// factor on hold (the gate reads it); holders are told when the permissions change.
import {
  builtInRole,
  type CustomRoleRecord,
  customRoleLimitReached,
  type DashboardPermission,
  deletionProblem,
  editingProblem,
  isBuiltInKey,
  isPermission,
  permissionDiff,
  type RoleLookup,
  type RoleProblem,
  roleKeyOf,
  sortPermissions,
  summary,
  validateRole,
} from "@fin/access";
import { checkName, type UnitTx } from "@fin/identity";
import { revokeTrustedBrowsers } from "./browsers.ts";
import { displayValue, orgNameForEmail, roleLabelForEmail } from "./email.ts";
import { type FieldProblem, invalid, notFound, OrgRefusal } from "./errors.ts";
import type { OrgActor } from "./guard.ts";
import { isId, newId } from "./ids.ts";
import { withdrawInvitations } from "./invitations.ts";
import { notifyEach, type Orgs } from "./orgs.ts";
import { givingRefusal, type LockedActor, lockTeam, mayInvite } from "./rules.ts";
import { CATALOGUE, type CustomRole, labelOf, lookupRole, permissionsFor } from "./store.ts";

export interface RoleDetail {
  roleKey: string;
  kind: "built_in" | "custom";
  label: string;
  description: string;
  summary: string;
  permissions: DashboardPermission[];
  permissionCount: number;
  holders: number;
  invitations: number;
  version: number | null;
}

const NAME_RULES = {
  roleName: (name: string) => checkName("roleName", name).ok,
  roleDescription: (description: string) => checkName("roleDescription", description).ok,
};

async function holderCounts(
  tx: UnitTx,
  orgId: string,
): Promise<{ holders: Map<string, number>; invitations: Map<string, number> }> {
  const holders = await tx.query<{ role_key: string; n: number }>(
    `SELECT role_key, count(*)::integer AS n FROM identity.member
      WHERE organization_id = $1 GROUP BY role_key`,
    [orgId],
  );
  const invitations = await tx.query<{ role_key: string; n: number }>(
    `SELECT role_key, count(*)::integer AS n FROM identity.invitation
      WHERE organization_id = $1 AND status = 'pending' GROUP BY role_key`,
    [orgId],
  );
  return {
    holders: new Map(holders.rows.map((r) => [r.role_key, Number(r.n)])),
    invitations: new Map(invitations.rows.map((r) => [r.role_key, Number(r.n)])),
  };
}

function detailOf(
  role: RoleLookup,
  counts: { holders: Map<string, number>; invitations: Map<string, number> },
  record: CustomRole | undefined,
): RoleDetail | null {
  if (typeof role === "string") return null;
  const key = roleKeyOf(role);
  const permissions = [...permissionsFor(role)];
  const builtIn = role.kind === "built_in" ? builtInRole(CATALOGUE, role.key) : undefined;
  return {
    roleKey: key,
    kind: role.kind,
    label: labelOf(role),
    description: role.kind === "custom" ? role.description : (builtIn?.summary ?? ""),
    summary: builtIn?.summary ?? summary(CATALOGUE, role),
    permissions,
    permissionCount: permissions.length,
    holders: counts.holders.get(key) ?? 0,
    invitations: counts.invitations.get(key) ?? 0,
    version: record?.version ?? null,
  };
}

/** `GET /api/roles` (§14.2): the built-ins, then the custom roles, with holders and counts. */
export async function listRoles(tx: UnitTx, actor: OrgActor): Promise<{ roles: RoleDetail[] }> {
  const counts = await holderCounts(tx, actor.organization.id);
  const builtIns = CATALOGUE.builtIns.map((b) =>
    detailOf({ kind: "built_in", key: b.key }, counts, undefined),
  );
  const custom = [...actor.roles.values()].map((r) =>
    detailOf(lookupRole(actor.roles, r.id), counts, r),
  );
  return { roles: [...builtIns, ...custom].filter((r): r is RoleDetail => r !== null) };
}

/** `GET /api/roles/:roleKey` (§14.2): one built-in or custom role of this organisation. */
export async function getRole(tx: UnitTx, actor: OrgActor, roleKey: string): Promise<RoleDetail> {
  if (!isBuiltInKey(CATALOGUE, roleKey) && !isId(roleKey, "rol")) throw notFound("role.key");
  const role = lookupRole(actor.roles, roleKey);
  const detail = detailOf(
    role,
    await holderCounts(tx, actor.organization.id),
    actor.roles.get(roleKey),
  );
  if (detail === null) throw notFound("role.gone");
  return detail;
}

const PROBLEM_FIELD: Readonly<Record<Exclude<RoleProblem, "beyond">, string>> = {
  name: "name",
  name_taken: "name",
  reads_as_built_in: "name",
  description: "description",
  empty: "permissions",
  restricted: "permissions",
  missing_need: "permissions",
};

/** The unique index on a custom role's name within its organisation (this area's migration). */
const NAME_INDEX = "role_name_once";

/**
 * Whether another role of the organisation has `name` the way the `role_name_once` index compares
 * names: `lower(name)` in the database's collation, which can fold letters the editor's own
 * comparison keeps apart (a capital I with a dot above, under a libc collation). Read inside the
 * team-change lock with the organisation's roles locked, so no name is written in between.
 */
async function nameTakenInStore(
  tx: UnitTx,
  orgId: string,
  name: string,
  exceptRoleId: string | null,
): Promise<boolean> {
  const result = await tx.query(
    `SELECT 1 FROM identity.role
      WHERE organization_id = $1 AND lower(name) = lower($2) AND ($3::text IS NULL OR id <> $3)
      LIMIT 1`,
    [orgId, name, exceptRoleId],
  );
  return result.rowCount > 0;
}

/**
 * A write the name index refused, as the editor's refusal (`400 invalid`, `name_taken` on the
 * name); null for anything else. The check inside the lock comes first, so this is a backstop.
 */
export function nameTakenRefusal(error: unknown): OrgRefusal | null {
  if (typeof error !== "object" || error === null) return null;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (code !== "23505" || constraint !== NAME_INDEX) return null;
  return invalid([{ path: "name", code: "name_taken" }], "role.name_taken");
}

/** Runs a write of a role's name, answering the name index's refusal as the editor's. */
async function writeName(run: () => Promise<{ rowCount: number }>): Promise<{ rowCount: number }> {
  try {
    return await run();
  } catch (error) {
    throw nameTakenRefusal(error) ?? error;
  }
}

/**
 * Refuses a draft as the role editor does: `beyond` is a giving refusal, the rest `400 invalid`.
 * `takenInStore` says the database's name index holds the name for another role, which is
 * `name_taken` too, in the engine's order, even where the engine tells the two names apart.
 */
function checkDraft(
  me: LockedActor,
  draft: { name: string; description: string; permissions: readonly string[] },
  others: readonly CustomRoleRecord[],
  takenInStore: boolean,
): void {
  const problems = validateRole(
    CATALOGUE,
    {
      name: draft.name,
      description: draft.description,
      permissions: draft.permissions as DashboardPermission[],
    },
    me.permissions,
    { takenNames: others.map((r) => r.name), names: NAME_RULES },
  );
  if (takenInStore && !problems.includes("name_taken")) {
    // `name`, when it is there, is always the first problem, and `name_taken` the next.
    problems.splice(problems[0] === "name" ? 1 : 0, 0, "name_taken");
  }
  if (problems.includes("beyond")) throw givingRefusal("beyond");
  if (problems.length > 0) {
    const fields: FieldProblem[] = problems
      .filter((p): p is Exclude<RoleProblem, "beyond"> => p !== "beyond")
      .map((p) => ({ path: PROBLEM_FIELD[p], code: p }));
    throw invalid(fields, "role.invalid");
  }
}

function cleanText(kind: "roleName" | "roleDescription", value: string): string {
  const checked = checkName(kind, value);
  return checked.ok ? checked.value : value;
}

function knownPermissions(permissions: readonly string[]): DashboardPermission[] {
  return sortPermissions(
    CATALOGUE,
    permissions.filter((p): p is DashboardPermission => isPermission(CATALOGUE, p)),
  );
}

async function holdersOf(
  tx: UnitTx,
  orgId: string,
  roleId: string,
): Promise<{ memberId: string; userId: string; email: string; name: string }[]> {
  const result = await tx.query<{ id: string; user_id: string; email: string; name: string }>(
    `SELECT m.id, m.user_id, u.email, u.name FROM identity.member m
       JOIN identity."user" u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.role_key = $2 ORDER BY m.id FOR UPDATE OF m`,
    [orgId, roleId],
  );
  return result.rows.map((r) => ({
    memberId: r.id,
    userId: r.user_id,
    email: r.email,
    name: r.name,
  }));
}

/** `POST /api/roles` (§8.4): `role.manage`, an intent, the editor's validation, at most 30. */
export async function createRole(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  body: { name: string; description: string; permissions: readonly string[] },
): Promise<{ roleId: string; version: number }> {
  const orgId = actor.organization.id;
  const { me } = await lockTeam(tx, actor, [], "role.manage");
  const name = cleanText("roleName", body.name);
  const description = cleanText("roleDescription", body.description);
  if (customRoleLimitReached(me.roles.size)) {
    throw new OrgRefusal("limit_reached", "limits.custom_roles", { limit: 30 });
  }
  checkDraft(
    me,
    { name, description, permissions: body.permissions },
    [...me.roles.values()],
    await nameTakenInStore(tx, orgId, name, null),
  );
  await actor.confirm({
    body: { name, description, permissions: [...body.permissions] },
    target: null,
    organizationId: orgId,
  });
  await orgs.limits.count(tx, "role_edit", actor.person.id);
  const permissions = knownPermissions(body.permissions);
  const roleId = newId("rol", orgs.clock);
  const now = orgs.clock.now();
  await writeName(() =>
    tx.query(
      `INSERT INTO identity.role (id, organization_id, name, description, created_by, created_at, updated_at, version)
       VALUES ($1, $2, $3, $4, $5, $6, $6, 1)`,
      [roleId, orgId, name, description, actor.person.id, now],
    ),
  );
  await tx.query(
    `INSERT INTO identity.role_permission (role_id, permission)
     SELECT $1, unnest($2::text[])`,
    [roleId, permissions],
  );
  await orgs.audit(tx, {
    event: "role.created",
    actor: actor.actor,
    target: roleId,
    refs: [orgId],
    organizationId: orgId,
    metadata: { permissions },
    context: actor.context,
  });
  return { roleId, version: 1 };
}

function roleOf(me: LockedActor, roleId: string): CustomRole {
  if (!isId(roleId, "rol")) throw notFound("role.id");
  const record = me.roles.get(roleId) as CustomRole | undefined;
  if (record === undefined) throw notFound("role.gone");
  return record;
}

function checkEditing(me: LockedActor, role: RoleLookup): void {
  const problem = editingProblem(CATALOGUE, {
    actorRoleKey: me.roleKey,
    actorPerms: me.permissions,
    role,
  });
  if (problem === null) return;
  if (problem === "gone" || problem === "built_in") throw notFound(`role.${problem}`);
  if (problem === "outranked") throw new OrgRefusal("outranked", "role.outranked");
  throw new OrgRefusal("giving_refused", "role.self", { problem: "self" });
}

/**
 * `PUT /api/roles/:roleId` (§8.4): `role.manage`, an intent; never a role the editor holds or one
 * that allows something the editor lacks; an optimistic `version` (a stale save is `409 conflict`).
 */
export async function updateRole(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  roleId: string,
  body: { name: string; description: string; permissions: readonly string[]; version: number },
): Promise<{ roleId: string; version: number }> {
  const orgId = actor.organization.id;
  const { me } = await lockTeam(tx, actor, [], "role.manage");
  const record = roleOf(me, roleId);
  const role = lookupRole(me.roles, roleId);
  checkEditing(me, role);
  if (body.version !== record.version) throw new OrgRefusal("conflict", "role.stale_version");
  const name = cleanText("roleName", body.name);
  const description = cleanText("roleDescription", body.description);
  checkDraft(
    me,
    { name, description, permissions: body.permissions },
    [...me.roles.values()].filter((r) => r.id !== roleId),
    await nameTakenInStore(tx, orgId, name, roleId),
  );
  await actor.confirm({
    body: { name, description, permissions: [...body.permissions], version: body.version },
    target: roleId,
    organizationId: orgId,
  });
  await orgs.limits.count(tx, "role_edit", actor.person.id);
  const before = [...permissionsFor(role)];
  const after = knownPermissions(body.permissions);
  const { added, removed } = permissionDiff(CATALOGUE, before, after);
  const now = orgs.clock.now();
  const updated = await writeName(() =>
    tx.query(
      `UPDATE identity.role SET name = $2, description = $3, version = version + 1, updated_at = $4
        WHERE id = $1 AND version = $5`,
      [roleId, name, description, now, body.version],
    ),
  );
  if (updated.rowCount !== 1) throw new OrgRefusal("conflict", "role.stale_version");
  // The stored rows are replaced by the known set, so a row that broke a rule does not linger.
  await tx.query("DELETE FROM identity.role_permission WHERE role_id = $1", [roleId]);
  await tx.query(
    `INSERT INTO identity.role_permission (role_id, permission) SELECT $1, unnest($2::text[])`,
    [roleId, after],
  );
  const holders = await holdersOf(tx, orgId, roleId);
  await orgs.audit(tx, {
    event: "role.updated",
    actor: actor.actor,
    target: roleId,
    refs: [orgId],
    organizationId: orgId,
    metadata: { added, removed, holders: holders.length, renamed: name !== record.name },
    context: actor.context,
  });
  if (added.length > 0 || removed.length > 0) {
    // The invitations this edit leaves their inviter unable to give, read after it: those its
    // holders sent, when the role lost a permission, and those offering it, when it gained one the
    // inviter lacks. Accepting one could never pass the inviter's re-check (§9.3), so each is
    // withdrawn as a demoted inviter's are (§9.2): the inviter now stands below the invitation.
    await withdrawInvitations(orgs, tx, actor, {
      reason: "inviter_demoted",
      inviters: holders.map((h) => h.userId),
      invitationIds: (
        await tx.query<{ id: string }>(
          `SELECT id FROM identity.invitation
            WHERE organization_id = $1 AND role_key = $2 AND status = 'pending'`,
          [orgId, roleId],
        )
      ).rows.map((r) => r.id),
      refs: [roleId],
    });
  }
  if (added.length > 0) {
    // A role elevation revokes its holders' trusted browsers (§6.6); a privileged permission
    // added also holds those without a factor at "Protect your account" (§6.2, read by the gate).
    await revokeTrustedBrowsers(
      orgs,
      tx,
      holders.map((h) => h.userId),
      "role_elevated",
      actor.actor,
      actor.context,
    );
  }
  if (added.length > 0 || removed.length > 0) {
    const personName = displayValue("personName", actor.person.name);
    await notifyEach(
      orgs,
      tx,
      holders.map((h) => ({
        template: "orgs/role-permissions-changed" as const,
        to: h.email,
        params: {
          orgId,
          roleId,
          orgName: orgNameForEmail(actor.organization.name),
          roleLabel: roleLabelForEmail(name),
          ...(personName === undefined ? {} : { personName }),
        },
      })),
    );
  }
  return { roleId, version: record.version + 1 };
}

/**
 * `POST /api/roles/:roleId/delete` (§8.4): `role.manage`, and `member.role` when people move; every
 * holder and every pending invitation moves to `moveTo`, a role the actor may give.
 */
export async function deleteRole(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  roleId: string,
  body: { moveTo?: string | undefined },
): Promise<{ roleId: string; membersMoved: number; invitationsMoved: number }> {
  const orgId = actor.organization.id;
  const { me } = await lockTeam(tx, actor, [], "role.manage");
  roleOf(me, roleId);
  const role = lookupRole(me.roles, roleId);
  const holders = await holdersOf(tx, orgId, roleId);
  const invitations = await tx.query<{ id: string }>(
    `SELECT id FROM identity.invitation
      WHERE organization_id = $1 AND role_key = $2 AND status = 'pending' ORDER BY id FOR UPDATE`,
    [orgId, roleId],
  );
  const moveTo = body.moveTo === undefined ? undefined : lookupRole(me.roles, body.moveTo);
  const problem = deletionProblem(CATALOGUE, {
    actorRoleKey: me.roleKey,
    actorPerms: me.permissions,
    role,
    holders: holders.length,
    invitations: invitations.rows.length,
    ...(moveTo === undefined ? {} : { moveTo }),
  });
  if (problem !== null) {
    if (problem === "gone" || problem === "built_in") throw notFound(`role.${problem}`);
    if (problem === "outranked") throw new OrgRefusal("outranked", "role.outranked");
    if (problem === "move_forbidden") {
      throw new OrgRefusal("forbidden", "role.move_forbidden", { permission: "member.role" });
    }
    throw new OrgRefusal("giving_refused", `role.${problem}`, {
      problem: problem === "move_gone" ? "gone" : problem,
    });
  }
  await actor.confirm({
    body: { moveTo: body.moveTo },
    target: roleId,
    organizationId: orgId,
  });
  await orgs.limits.count(tx, "role_edit", actor.person.id);
  const now = orgs.clock.now();
  const movedTo = body.moveTo ?? null;
  const rolePerms = permissionsFor(role);
  const movePerms = moveTo === undefined ? new Set<DashboardPermission>() : permissionsFor(moveTo);
  const lowered = [...rolePerms].some((p) => !movePerms.has(p));
  const orgName = orgNameForEmail(actor.organization.name);
  const newLabel = moveTo === undefined ? "" : roleLabelForEmail(labelOf(moveTo));
  const oldLabel = roleLabelForEmail(labelOf(role));
  for (const holder of holders) {
    await tx.query("UPDATE identity.member SET role_key = $2, updated_at = $3 WHERE id = $1", [
      holder.memberId,
      movedTo,
      now,
    ]);
    await orgs.audit(tx, {
      event: "member.role_changed",
      actor: actor.actor,
      target: holder.memberId,
      refs: [holder.userId, orgId, roleId],
      organizationId: orgId,
      metadata: {
        fromRole: roleId,
        toRole: movedTo ?? roleId,
        reason: "role_deleted",
        lowered,
      },
      context: actor.context,
    });
  }
  // Each invitation moves only when its inviter, in their role after the holders moved, may give the
  // new role; otherwise accepting it could never pass the inviter's re-check (§9.3), so it is
  // withdrawn (`role_deleted`) rather than left looking live.
  const inviters = await tx.query<{ id: string; inviter_role: string | null }>(
    `SELECT i.id, m.role_key AS inviter_role FROM identity.invitation i
       LEFT JOIN identity.member m ON m.organization_id = i.organization_id AND m.user_id = i.invited_by
      WHERE i.id = ANY($1::text[]) ORDER BY i.id`,
    [invitations.rows.map((r) => r.id)],
  );
  let invitationsMoved = 0;
  for (const invitation of inviters.rows) {
    const movable =
      moveTo !== undefined &&
      invitation.inviter_role !== null &&
      mayInvite(lookupRole(me.roles, invitation.inviter_role), moveTo);
    if (!movable) {
      await tx.query(
        `UPDATE identity.invitation SET status = 'cancelled', cancel_reason = 'role_deleted', answered_at = $2
          WHERE id = $1`,
        [invitation.id, now],
      );
      await orgs.audit(tx, {
        event: "member.invitation_cancelled",
        actor: actor.actor,
        target: invitation.id,
        refs: [orgId, roleId],
        organizationId: orgId,
        metadata: { reason: "role_deleted" },
        context: actor.context,
      });
      continue;
    }
    await tx.query("UPDATE identity.invitation SET role_key = $2 WHERE id = $1", [
      invitation.id,
      movedTo,
    ]);
    await orgs.audit(tx, {
      event: "member.invitation_changed",
      actor: actor.actor,
      target: invitation.id,
      refs: [orgId, roleId],
      organizationId: orgId,
      metadata: { fromRole: roleId, toRole: movedTo ?? roleId, reason: "role_deleted" },
      context: actor.context,
    });
    invitationsMoved += 1;
  }
  if (lowered && holders.length > 0) {
    // Holders moved to a role that does less: the invitations they sent that it no longer lets them
    // give are withdrawn, as for any demotion (§9.2).
    await withdrawInvitations(orgs, tx, actor, {
      reason: "role_deleted",
      inviters: holders.map((h) => h.userId),
      refs: [roleId],
    });
  }
  if (moveTo !== undefined && [...movePerms].some((p) => !rolePerms.has(p))) {
    await revokeTrustedBrowsers(
      orgs,
      tx,
      holders.map((h) => h.userId),
      "role_elevated",
      actor.actor,
      actor.context,
    );
  }
  await tx.query("DELETE FROM identity.role WHERE id = $1", [roleId]);
  await orgs.audit(tx, {
    event: "role.deleted",
    actor: actor.actor,
    target: roleId,
    refs: [orgId],
    organizationId: orgId,
    metadata: {
      movedTo,
      membersMoved: holders.length,
      invitationsMoved,
    },
    context: actor.context,
  });
  const admins = await tx.query<{ email: string }>(
    `SELECT u.email FROM identity.member m JOIN identity."user" u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.role_key = $2`,
    [orgId, CATALOGUE.topRoleKey],
  );
  for (const holder of holders) {
    const personName = displayValue("personName", holder.name);
    const params = {
      orgId,
      userId: holder.userId,
      orgName,
      roleLabel: newLabel,
      previousRoleLabel: oldLabel,
    };
    await notifyEach(orgs, tx, [
      {
        template: "orgs/member-role-changed",
        to: holder.email,
        params: { ...params, audience: "person" },
      },
      ...admins.rows.map((a) => ({
        template: "orgs/member-role-changed" as const,
        to: a.email,
        params: {
          ...params,
          audience: "admins",
          ...(personName === undefined ? {} : { personName }),
        },
      })),
    ]);
  }
  return { roleId, membersMoved: holders.length, invitationsMoved };
}
