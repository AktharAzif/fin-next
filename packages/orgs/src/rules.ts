// Who may act on whom ([SA-32], spec 02 §8.5), re-read inside the team-change lock and mapped to the
// route's refusals: `403 giving_refused` with the problem, `403 outranked`, `409 last_top_role`.
import {
  type ActingProblem,
  actingProblem,
  type DashboardPermission,
  type DashboardRoleKey,
  type GivingProblem,
  givingProblem,
  lastTopRoleProblem,
  type RoleLookup,
  type TopRoleChange,
} from "@fin/access";
import type { UnitTx } from "@fin/identity";
import { OrgRefusal } from "./errors.ts";
import type { OrgActor } from "./guard.ts";
import {
  CATALOGUE,
  type CustomRole,
  customRolesOf,
  lockMembers,
  lookupRole,
  type MemberRow,
  otherTopHolders,
  permissionsFor,
} from "./store.ts";

export function givingRefusal(problem: GivingProblem): OrgRefusal {
  return problem === "outranked"
    ? new OrgRefusal("outranked", "team.outranked")
    : new OrgRefusal("giving_refused", `team.${problem}`, { problem });
}

export function actingRefusal(problem: ActingProblem): OrgRefusal {
  return problem === "outranked"
    ? new OrgRefusal("outranked", "team.outranked")
    : new OrgRefusal("giving_refused", "team.self", { problem: "self" });
}

/** The actor as the lock sees it: their membership, role and permissions read again. */
export interface LockedActor {
  member: MemberRow;
  roleKey: string;
  role: RoleLookup;
  permissions: ReadonlySet<DashboardPermission>;
  roles: Map<string, CustomRole>;
}

/**
 * Inside the team-change lock (the organisation's row, which requireActor took): locks the actor's
 * and the targets' member rows in ID order and reads every role again (§9.5), then checks the actor
 * still holds `permission`. Returns the actor and the targets found.
 */
export async function lockTeam(
  tx: UnitTx,
  actor: OrgActor,
  targetIds: readonly string[],
  permission: DashboardPermission,
): Promise<{ me: LockedActor; targets: Map<string, MemberRow> }> {
  const rows = await lockMembers(tx, actor.organization.id, [actor.member.id, ...targetIds]);
  const mine = rows.get(actor.member.id);
  if (mine === undefined) throw new OrgRefusal("not_found", "org.not_member");
  const roles = await customRolesOf(tx, actor.organization.id, { lock: true });
  const role = lookupRole(roles, mine.roleKey);
  const permissions = permissionsFor(role);
  if (!permissions.has(permission)) {
    throw new OrgRefusal("forbidden", "policy.permission", { permission });
  }
  const targets = new Map<string, MemberRow>();
  for (const id of targetIds) {
    const row = rows.get(id);
    if (row !== undefined) targets.set(id, row);
  }
  return { me: { member: mine, roleKey: mine.roleKey, role, permissions, roles }, targets };
}

/** Refuses a change that gives a role the actor may not give (§8.5's giving rule). */
export function checkGiving(
  me: LockedActor,
  input: {
    targetIsSelf: boolean;
    current?: RoleLookup;
    next: RoleLookup<DashboardRoleKey>;
  },
): void {
  const problem = givingProblem(CATALOGUE, {
    actorRoleKey: me.roleKey,
    actorPerms: me.permissions,
    targetIsSelf: input.targetIsSelf,
    ...(input.current === undefined ? {} : { targetCurrentRole: input.current }),
    newRole: input.next,
  });
  if (problem !== null) throw givingRefusal(problem);
}

/** Refuses acting on a target whose role holds something the actor lacks, or on oneself. */
export function checkActing(
  me: LockedActor,
  input: { targetIsSelf: boolean; role: RoleLookup },
): void {
  const problem = actingProblem(CATALOGUE, {
    actorPerms: me.permissions,
    targetIsSelf: input.targetIsSelf,
    targetRole: input.role,
  });
  if (problem !== null) throw actingRefusal(problem);
}

/** Refuses removing or demoting the organisation's last Super admin (`409 last_top_role`). */
export async function checkLastTopRole(
  tx: UnitTx,
  orgId: string,
  target: MemberRow,
  role: RoleLookup,
  change: TopRoleChange,
): Promise<void> {
  const problem = lastTopRoleProblem(CATALOGUE, {
    targetRole: role,
    change,
    otherTopHolders: await otherTopHolders(tx, orgId, target.id),
  });
  if (problem !== null) throw new OrgRefusal("last_top_role", "team.last_top_role");
}
