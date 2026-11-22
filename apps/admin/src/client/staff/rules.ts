// What the Staff page draws enabled, and why not (spec 02 §8.5, §8.7, §10.2). These only mirror the
// server: it checks the permission, the step-up, who may act on whom and the last Admin inside the
// staff-change lock on every request, and refuses whatever this says. A control the role cannot use
// is drawn disabled with its reason; nothing is hidden that the page itself shows.
import { type StaffMember, type StaffRole, TOP_STAFF_ROLE } from "../api/contracts.ts";

export const NO_PERMISSION = "Your role doesn’t allow this. Ask someone who can change roles.";
export const LAST_ADMIN = "Fin Admin needs at least one Admin. Make someone else an Admin first.";
export const OWN_ROLE = "You can’t change your own role.";
export const OWN_REMOVAL = "You can’t remove yourself from staff.";
export const OUTRANKED = "Their role allows more than yours.";
export const TOP_ONLY = "Only an Admin can give the Admin role.";
export const BEYOND = "This role allows more than yours.";

export interface Actor {
  readonly id: string;
  readonly roleKey: string;
  readonly permissions: ReadonlySet<string>;
}

export interface RowControls {
  /** null when the control is enabled, else the reason it is not. */
  readonly changeRole: string | null;
  readonly remove: string | null;
  /** Only for a pending member; undefined for an active one (no such control). */
  readonly newCode?: string | null;
}

/** True when `member` is the one active Admin left (spec 02 §10.8). */
export function isLastActiveAdmin(member: StaffMember, staff: readonly StaffMember[]): boolean {
  if (member.roleKey !== TOP_STAFF_ROLE || member.status !== "active") return false;
  return staff.filter((m) => m.roleKey === TOP_STAFF_ROLE && m.status === "active").length === 1;
}

function holds(actor: Actor, role: StaffRole | undefined): boolean {
  if (role === undefined) return true;
  return role.permissions.every((permission) => actor.permissions.has(permission));
}

/** The controls of one row of the list, for this member of staff. */
export function rowControls(
  actor: Actor,
  member: StaffMember,
  staff: readonly StaffMember[],
  roles: readonly StaffRole[],
): RowControls {
  const own = member.id === actor.id;
  const last = isLastActiveAdmin(member, staff);
  const outranked = !holds(
    actor,
    roles.find((role) => role.key === member.roleKey),
  );
  const pick = (permission: string, self: string): string | null => {
    if (!actor.permissions.has(permission)) return NO_PERMISSION;
    if (last) return LAST_ADMIN;
    if (own) return self;
    if (outranked) return OUTRANKED;
    return null;
  };
  const controls: RowControls = {
    changeRole: pick("staff.role", OWN_ROLE),
    remove: pick("staff.remove", OWN_REMOVAL),
  };
  if (member.status !== "pending") return controls;
  return {
    ...controls,
    newCode: !actor.permissions.has("staff.add") ? NO_PERMISSION : outranked ? OUTRANKED : null,
  };
}

/** Why `actor` cannot give `role`, or null when they can (spec 02 §8.5's giving rules). */
export function givingReason(actor: Actor, role: StaffRole): string | null {
  if (role.key === TOP_STAFF_ROLE && actor.roleKey !== TOP_STAFF_ROLE) return TOP_ONLY;
  if (!holds(actor, role)) return BEYOND;
  return null;
}

/** The page's own "Add staff": with `staff.add`, else disabled with the reason. */
export function addReason(actor: Actor): string | null {
  return actor.permissions.has("staff.add") ? null : NO_PERMISSION;
}

/** The first role the actor may give, for a new member: the least that is enough to start. */
export function defaultRoleKey(actor: Actor, roles: readonly StaffRole[]): string | null {
  return roles.find((role) => givingReason(actor, role) === null)?.key ?? null;
}
