// Who may act on whom (spec 02 §8.4, §8.5, [SA-32]), the same in both realms. These are pure
// checks: the caller runs them inside the team-change or staff-change lock, after reading the
// actor's and the target's roles again, and maps each problem to its refusal:
//   giving_refused (403, with the problem) for unknown_role, gone, beyond, top_only, self and
//   unchanged; outranked (403) for outranked; last_top_role (409) for the last holder of the top
//   role.
import { isTopRole, permissionsOf, roleKeyOf, sameRole } from "./roles.ts";
import type {
  ActingProblem,
  Catalogue,
  DeletionProblem,
  EditingProblem,
  GivingProblem,
  RoleLookup,
} from "./types.ts";

/** Whether the target holds something the actor lacks. */
export function outranks<P extends string>(
  cat: Catalogue<P>,
  targetPerms: Iterable<NoInfer<P>>,
  actorPerms: ReadonlySet<NoInfer<P>>,
): boolean {
  for (const key of targetPerms) {
    if (Object.hasOwn(cat.permissions, key) && !actorPerms.has(key)) return true;
  }
  return false;
}

/** Whether everything the role allows is within the actor's permissions. */
function within<P extends string>(
  cat: Catalogue<P>,
  role: RoleLookup,
  actorPerms: ReadonlySet<P>,
): boolean {
  return !outranks(cat, permissionsOf(cat, role), actorPerms);
}

export interface GivingInput<P extends string> {
  /** The actor's role key now, read again inside the lock. */
  readonly actorRoleKey: string;
  /** What the actor's role allows now (`permissionsOf`). */
  readonly actorPerms: ReadonlySet<P>;
  /** The target is the actor: their own membership or staff row. */
  readonly targetIsSelf: boolean;
  /** The target's role now; absent for a new invitation or a new staff member. */
  readonly targetCurrentRole?: RoleLookup;
  readonly newRole: RoleLookup;
}

/**
 * Whether the actor may give `newRole` to the target: an invitation, a new staff member, a role
 * change, an invitation's role change, or the move off a deleted role. In order: a role Fin does
 * not know, a role that no longer exists, the target is the actor, the top role from anyone but
 * its holders, a role holding something the actor lacks, a target whose current role holds
 * something the actor lacks, and the same role again. `null` when the giving may go ahead.
 */
export function givingProblem<P extends string>(
  cat: Catalogue<P>,
  input: GivingInput<NoInfer<P>>,
): GivingProblem | null {
  const { newRole } = input;
  if (newRole === "unknown") return "unknown_role";
  if (newRole === "gone") return "gone";
  if (input.targetIsSelf) return "self";
  if (isTopRole(cat, newRole) && input.actorRoleKey !== cat.topRoleKey) return "top_only";
  if (!within(cat, newRole, input.actorPerms)) return "beyond";
  const current = input.targetCurrentRole;
  if (current !== undefined && !within(cat, current, input.actorPerms)) return "outranked";
  if (current !== undefined && sameRole(current, newRole)) return "unchanged";
  return null;
}

export interface ActingInput<P extends string> {
  readonly actorPerms: ReadonlySet<P>;
  readonly targetIsSelf: boolean;
  /** The target's role now: a member's, a staff member's or an invitation's. */
  readonly targetRole: RoleLookup;
}

/**
 * Whether the actor may remove a member, remove or reset a staff member, or resend or cancel an
 * invitation: never themselves, and only when the target's role is within the actor's
 * permissions. A role Fin does not know holds nothing, so its holder outranks nobody.
 */
export function actingProblem<P extends string>(
  cat: Catalogue<P>,
  input: ActingInput<NoInfer<P>>,
): ActingProblem | null {
  if (input.targetIsSelf) return "self";
  if (!within(cat, input.targetRole, input.actorPerms)) return "outranked";
  return null;
}

/** What happens to a top-role holder: removed, reset (staff), or given `newRole`. */
export type TopRoleChange = "remove" | "reset" | { readonly newRole: RoleLookup };

export interface TopRoleInput {
  readonly targetRole: RoleLookup;
  readonly change: TopRoleChange;
  /**
   * How many hold the top role now, the target included, counted inside the lock: members of the
   * organisation holding `super_admin`, or `active` staff holding `admin`.
   */
  readonly topHolders: number;
}

/**
 * Whether the change would leave the realm without a holder of its top role: the last Super admin
 * cannot be removed or demoted, and the last active staff Admin cannot be removed, demoted or
 * reset (`409 last_top_role`). A count below one is treated as the last holder.
 */
export function lastTopRoleProblem(cat: Catalogue, input: TopRoleInput): "last_top_role" | null {
  if (!isTopRole(cat, input.targetRole)) return null;
  const { change } = input;
  const staysTop = typeof change !== "string" && isTopRole(cat, change.newRole);
  if (staysTop) return null;
  return input.topHolders <= 1 ? "last_top_role" : null;
}

export interface EditingInput<P extends string> {
  /** The editor's role key now (a built-in key or a custom role ID). */
  readonly actorRoleKey: string;
  readonly actorPerms: ReadonlySet<P>;
  /** The role being edited or deleted, read again inside the lock. */
  readonly role: RoleLookup;
}

/**
 * Whether the actor may edit or delete a role: never a built-in (immutable rows in code), never the
 * role the actor holds, and never one that allows something the actor lacks (so never a role held
 * by anyone who outranks the actor, since a holder's permissions are the role's). A role that no
 * longer exists is `gone` (the route answers 404).
 */
export function editingProblem<P extends string>(
  cat: Catalogue<P>,
  input: EditingInput<NoInfer<P>>,
): EditingProblem | null {
  const { role } = input;
  if (typeof role === "string") return "gone";
  if (role.kind === "built_in") return "built_in";
  if (roleKeyOf(role) === input.actorRoleKey) return "self";
  if (!within(cat, role, input.actorPerms)) return "outranked";
  return null;
}

export interface DeletionInput<P extends string> extends EditingInput<P> {
  /** How many people hold the role now. */
  readonly holders: number;
  /** How many pending invitations offer the role now. */
  readonly invitations: number;
  /** Where its holders and invitations move; needed when there are any. */
  readonly moveTo?: RoleLookup;
}

/**
 * Whether the actor may delete a custom role, moving its holders and pending invitations to
 * `moveTo`: the editing rules, then a move when anyone holds or is offered the role, the move
 * permission (`member.role`, staff `staff.role`) when people move, and `moveTo` a role the actor
 * may give in place of this one.
 */
export function deletionProblem<P extends string>(
  cat: Catalogue<P>,
  input: DeletionInput<NoInfer<P>>,
): DeletionProblem | null {
  const editing = editingProblem(cat, input);
  if (editing !== null) return editing;
  if (input.holders <= 0 && input.invitations <= 0) return null;
  if (input.moveTo === undefined) return "move_required";
  if (input.holders > 0 && !input.actorPerms.has(cat.movePermission)) return "move_forbidden";
  return givingProblem(cat, {
    actorRoleKey: input.actorRoleKey,
    actorPerms: input.actorPerms,
    targetIsSelf: false,
    targetCurrentRole: input.role,
    newRole: input.moveTo,
  });
}
