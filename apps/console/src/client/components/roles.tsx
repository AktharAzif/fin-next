// Choosing a role (Team's invite and change-role dialogs, Roles' delete-and-move): every role the
// organisation has, each with what it allows; a role the person may not give is drawn disabled
// with the reason ([SA-32], spec 02 §8.5, §8.7), from the same engine the server runs. The server
// checks again inside its lock and refuses regardless. @fin/ui has no radio group yet, so it is
// composed from native radios and the design system's tokens, and marked pending (UI-03).
// @pendingDesign UR-22: a RadioGroup in @fin/ui (Team's change role, Roles' move).
import {
  type DashboardPermission,
  dashboardCatalogue,
  givingProblem,
  outranks,
  permissionSet,
  type RoleLookup,
  summary,
} from "@fin/access";
import { useId } from "react";
import type { RoleRow } from "../api/contracts/roles.ts";

export interface RoleChoice {
  roleKey: string;
  label: string;
  description: string;
  /** Why it cannot be chosen, or null. */
  reason: string | null;
}

function lookupOf(role: RoleRow): RoleLookup {
  if (role.builtIn) return { kind: "built_in", key: role.roleKey };
  return {
    kind: "custom",
    id: role.roleId ?? role.roleKey,
    name: role.label,
    description: role.description ?? "",
    permissions: role.permissions ?? [],
  };
}

/** What the role allows, in a sentence: a built-in's summary, a custom role's description. */
export function roleSummary(role: RoleRow): string {
  if (!role.builtIn && role.description !== null && role.description !== undefined) {
    if (role.description.trim() !== "") return role.description;
  }
  if (!role.builtIn && role.permissions === undefined) return "";
  return summary(dashboardCatalogue, lookupOf(role));
}

/**
 * Each role as a choice for an actor with `actorRoleKey` and `actorPermissions`, giving it to
 * someone who now has `currentRoleKey` (absent for an invitation).
 */
export function roleChoices(
  roles: readonly RoleRow[],
  actor: { roleKey: string; permissions: readonly string[] },
  currentRoleKey?: string,
): RoleChoice[] {
  const actorPerms = permissionSet(dashboardCatalogue, actor.permissions);
  return roles.map((role) => {
    let reason: string | null = null;
    if (role.builtIn) {
      const problem = givingProblem(dashboardCatalogue, {
        actorRoleKey: actor.roleKey,
        actorPerms: actorPerms as ReadonlySet<DashboardPermission>,
        targetIsSelf: false,
        newRole: lookupOf(role) as RoleLookup<never>,
      });
      if (problem === "top_only") reason = "Only a Super admin can do this.";
      else if (problem === "beyond") reason = "You don’t have this yourself.";
    } else if (
      role.permissions !== undefined &&
      outranks(dashboardCatalogue, role.permissions as DashboardPermission[], actorPerms)
    ) {
      reason = "You don’t have this yourself.";
    }
    if (reason === null && role.roleKey === currentRoleKey) reason = "Current";
    return {
      roleKey: role.roleKey,
      label: role.label,
      description: roleSummary(role),
      reason,
    };
  });
}

/** Whether the actor may give any of the roles. */
export function canGiveAny(choices: readonly RoleChoice[]): boolean {
  return choices.some((choice) => choice.reason === null);
}

/**
 * The role the person picked, while it is still one they may give; otherwise null. A picker that
 * gives a role (an invitation, the move when a role is deleted) never starts with one chosen: the
 * person picks it, so no form ever defaults to a role, least of all the most privileged.
 */
export function pickedRole(choices: readonly RoleChoice[], picked: string | null): string | null {
  if (picked === null) return null;
  return choices.some((choice) => choice.roleKey === picked && choice.reason === null)
    ? picked
    : null;
}

/** The reason a picker's action waits, or null when a role is picked. */
export function whyNoRole(choices: readonly RoleChoice[], picked: string | null): string | null {
  if (!canGiveAny(choices)) return "There is no role you can give.";
  return pickedRole(choices, picked) === null ? "Choose a role first." : null;
}

export function RolePicker(props: {
  label: string;
  choices: readonly RoleChoice[];
  value: string | null;
  onChange: (roleKey: string) => void;
  disabled?: boolean;
}) {
  const name = `role${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={props.disabled}>
      <legend className="mb-2 p-0 text-label-sm text-text-secondary">{props.label}</legend>
      <div className="flex flex-col gap-1">
        {props.choices.map((choice) => {
          const id = `${name}-${choice.roleKey.replace(/[^A-Za-z0-9_-]/g, "")}`;
          const disabled = choice.reason !== null && choice.reason !== "Current";
          return (
            <label
              key={choice.roleKey}
              htmlFor={id}
              className={
                disabled
                  ? "flex cursor-not-allowed items-start gap-3 rounded-md px-3 py-2.5"
                  : "flex cursor-pointer items-start gap-3 rounded-md px-3 py-2.5 hover:bg-fill-hover has-checked:bg-fill-selected"
              }
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={choice.roleKey}
                checked={props.value === choice.roleKey}
                disabled={disabled}
                onChange={() => props.onChange(choice.roleKey)}
                className="mt-0.5 size-4 shrink-0 accent-action-primary"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span
                  className={
                    disabled ? "text-label text-text-disabled" : "text-label text-text-primary"
                  }
                >
                  {choice.label}
                  {choice.reason === "Current" ? (
                    <span className="font-regular text-text-tertiary"> · Current</span>
                  ) : null}
                </span>
                <span className="text-caption text-text-tertiary">
                  {disabled ? choice.reason : choice.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
