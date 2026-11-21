// The role editor's model (RoleEditor board; spec 02 §8.1, §8.4): ticking a permission ticks what
// it needs, unticking one unticks what depends on it, and each permission the editor cannot give is
// locked with the reason. The draft is checked with the engine the server runs (validateRole); the
// server checks again, with the full name rules, inside its lock.
import {
  type DashboardPermission,
  dashboardCatalogue,
  permissionSet,
  type RoleProblem,
  sortPermissions,
  tick,
  untick,
  validateRole,
} from "@fin/access";

export type Permission = DashboardPermission;

export const CATALOGUE = dashboardCatalogue;

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

/** Ticks or unticks every permission of a group the editor may give. */
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

/** Why a permission cannot be ticked by this editor, or null. */
export function lockReason(key: Permission, actor: ReadonlySet<Permission>): string | null {
  if (CATALOGUE.permissions[key].restricted) return "Only a Super admin can do this.";
  if (!actor.has(key)) return "You don’t have this yourself.";
  return null;
}

/** The problems a draft has, from the engine; the name and permissions in the form it is saved. */
export function draftProblems(
  draft: Draft,
  actor: ReadonlySet<Permission>,
  takenNames: readonly string[] = [],
): RoleProblem[] {
  return validateRole(
    CATALOGUE,
    {
      name: draft.name.normalize("NFC").trim().replace(/\s+/gu, " "),
      description: draft.description.normalize("NFC").trim().replace(/\s+/gu, " "),
      permissions: sortPermissions(CATALOGUE, draft.permissions),
    },
    actor,
    { takenNames },
  );
}

/** The line under Save when it cannot be pressed yet. */
export function whySaveIsOff(problems: readonly RoleProblem[], name: string): string | null {
  const noName = name.trim() === "";
  const empty = problems.includes("empty");
  if (noName && empty) return "Name the role and tick at least one permission.";
  if (noName) return "Name the role first.";
  if (empty) return "Tick at least one permission.";
  return null;
}

/** A field's sentence for each problem the form shows beside a field. */
export function problemSentence(problem: RoleProblem): string | null {
  switch (problem) {
    case "name":
      return "Use letters, numbers and simple punctuation, up to 40 characters and 5 words.";
    case "name_taken":
      return "Another role already has that name.";
    case "reads_as_built_in":
      return "That reads like a built-in role’s name. Choose another.";
    case "description":
      return "Up to 120 characters, with no web addresses or phone numbers.";
    default:
      return null;
  }
}

/** "Developer can do 15 things.", "This role can’t do anything yet." */
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
