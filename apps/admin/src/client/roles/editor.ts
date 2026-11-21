// AdminRoleEditor's model (spec 02 §8.1, §8.3, §8.4, §8.7): ticking a staff permission ticks what it
// needs, unticking one unticks what depends on it, and a permission this member of staff cannot
// give is locked with the reason (an Admin-only one, or one their own role lacks). The draft is
// checked with the engine the server runs (`validateRole` on the staff catalogue); the server
// checks again, with the full name rules, inside the staff-change lock, and decides.
import {
  needsOf,
  permissionSet,
  type RoleProblem,
  type StaffPermission,
  sortPermissions,
  staffCatalogue,
  tick,
  untick,
  validateRole,
  withNeeds,
} from "@fin/access";

export type Permission = StaffPermission;

export const CATALOGUE = staffCatalogue;

/** The permission that makes, changes and deletes custom staff roles. */
export const MANAGE = "staffRoles.manage";
/** The permission that moves people off a deleted role (the catalogue's move permission). */
export const MOVE = staffCatalogue.movePermission;

/** The Staff page's own description: both tabs keep one header (StaffPage's STAFF_DESCRIPTION). */
export const STAFF_PAGE_DESCRIPTION =
  "Who can use Fin Admin and what they may do. Cloudflare Access decides who can reach it.";

export const ADMIN_ONLY = "Only the Admin role can have this.";
export const NOT_YOURS = "You don’t have this yourself.";
export const READ_ONLY_NOTICE =
  "You can see the roles. Changing them needs Create and change staff roles.";
export const NO_MANAGE = "Your role doesn’t allow this. Ask someone who can change staff roles.";

export interface Draft {
  name: string;
  description: string;
  permissions: ReadonlySet<Permission>;
}

export function toPermissions(values: Iterable<string>): ReadonlySet<Permission> {
  return permissionSet(CATALOGUE, values) as ReadonlySet<Permission>;
}

/** Ticks or unticks one permission, with its needs or its dependents. */
export function toggle(
  permissions: ReadonlySet<Permission>,
  key: Permission,
  on: boolean,
): ReadonlySet<Permission> {
  return on ? tick(CATALOGUE, permissions, key) : untick(CATALOGUE, permissions, key);
}

/** Ticks or unticks every permission of a group this member of staff may give. */
export function toggleGroup(
  permissions: ReadonlySet<Permission>,
  groupKeys: readonly Permission[],
  on: boolean,
  givable: (key: Permission) => boolean,
): ReadonlySet<Permission> {
  let next = permissions;
  for (const key of groupKeys) {
    if (!givable(key)) continue;
    next = toggle(next, key, on);
  }
  return next;
}

export type GroupState = "all" | "some" | "none";

export function groupState(
  permissions: ReadonlySet<Permission>,
  groupKeys: readonly Permission[],
): GroupState {
  const held = groupKeys.filter((key) => permissions.has(key)).length;
  if (held === 0) return "none";
  return held === groupKeys.length ? "all" : "some";
}

/** Why a permission cannot be ticked in a custom staff role by this member of staff, or null. */
export function lockReason(key: Permission, actor: ReadonlySet<Permission>): string | null {
  if (CATALOGUE.permissions[key].restricted) return ADMIN_ONLY;
  if (!actor.has(key)) return NOT_YOURS;
  return null;
}

/**
 * A duplicate's permissions: the source role's, less every one this member of staff may not give
 * and every one that needs such a permission, with everything the rest need. So a copy of Admin
 * keeps everything but the Admin-only permissions, and can always be saved.
 */
export function givableCopy(
  source: Iterable<string>,
  actor: ReadonlySet<Permission>,
): ReadonlySet<Permission> {
  const givable = (key: Permission) => lockReason(key, actor) === null;
  const kept = [...toPermissions(source)].filter(
    (key) => givable(key) && [...needsOf(CATALOGUE, key)].every(givable),
  );
  return withNeeds(CATALOGUE, kept) as ReadonlySet<Permission>;
}

/** The text in the form it is checked and saved in: NFC, trimmed, one space between words. */
export function normalised(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/gu, " ");
}

/** The problems a draft has, from the engine, in the form it is saved. */
export function draftProblems(
  draft: Draft,
  actor: ReadonlySet<Permission>,
  takenNames: readonly string[] = [],
): RoleProblem[] {
  return validateRole(
    CATALOGUE,
    {
      name: normalised(draft.name),
      description: normalised(draft.description),
      permissions: sortPermissions(CATALOGUE, draft.permissions),
    },
    actor,
    { takenNames },
  );
}

/**
 * The line under Save when it cannot be pressed yet. Every problem without a field of its own is
 * named here, so Save is never pressable while saving would do nothing.
 */
export function whySaveIsOff(problems: readonly RoleProblem[], name: string): string | null {
  const noName = name.trim() === "";
  const empty = problems.includes("empty");
  if (noName && empty) return "Name the role and tick at least one permission.";
  if (noName) return "Name the role first.";
  if (empty) return "Tick at least one permission.";
  if (problems.includes("restricted") || problems.includes("beyond"))
    return "Untick the permissions you can’t give first.";
  if (problems.includes("missing_need")) return "Tick what each permission needs first.";
  return null;
}

/** A field's sentence for each problem the form shows beside a field (spec 02 §8.6's inventory). */
export function problemSentence(problem: RoleProblem | string): string | null {
  switch (problem) {
    case "name":
      return "Use letters, numbers and simple punctuation, up to 40 characters and 5 words.";
    case "name_taken":
      return "Another role already has that name.";
    case "reads_as_built_in":
      return "That reads like a prebuilt role’s name. Choose another.";
    case "description":
      return "Up to 120 characters, with no web addresses or phone numbers.";
    default:
      return null;
  }
}

/** "Support desk can do 4 things.", "This role can’t do anything yet." */
export function countLine(name: string, count: number): string {
  if (count === 0) return "This role can’t do anything yet.";
  const who = name.trim() === "" ? "This role" : name.trim();
  return `${who} can do ${count} ${count === 1 ? "thing" : "things"}.`;
}

/** A group's short line in the summary: "All", "2 of 4", "None". */
export function groupShort(state: GroupState, held: number, total: number): string {
  if (state === "all") return "All";
  if (state === "none") return "None";
  return `${held} of ${total}`;
}

/** "Nobody", "1 person", "3 people". */
export function holdersText(count: number): string {
  if (count === 0) return "Nobody";
  return count === 1 ? "1 person" : `${count} people`;
}

/** "1 permission", "26 permissions". */
export function permissionsText(count: number): string {
  return count === 1 ? "1 permission" : `${count} permissions`;
}

/** The member of staff a page acts as, from the viewer: their ID, role key and permissions now. */
export function actorOf(viewer: {
  staff: { id: string; roleKey: string };
  permissions: readonly string[];
}): { id: string; roleKey: string; permissions: ReadonlySet<string> } {
  return {
    id: viewer.staff.id,
    roleKey: viewer.staff.roleKey,
    permissions: new Set(viewer.permissions),
  };
}

/** Where a role opens: its key in the path, which is always a prebuilt key or an `srl_` ID. */
export function roleHref(roleKey: string): string {
  return `/staff/roles/${encodeURIComponent(roleKey)}`;
}

/** Where "Duplicate" opens: a new role from this one. */
export function duplicateHref(roleKey: string): string {
  return `/staff/roles/new?${new URLSearchParams({ from: roleKey }).toString()}`;
}
