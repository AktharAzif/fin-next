// The role picker of Add staff and Change role (AdminStaff, spec 02 §15.3): every role the list
// knows, each with its one-line summary, and those the member of staff cannot give drawn disabled
// with the reason (spec 02 §8.5, §8.7).
//
// @pendingDesign UR-21: the board draws a Select with the chosen role's summary as its helper;
// @fin/ui has no Select yet (wave 2), so this is a radio group composed from tokens, one choice per
// row, which also shows every summary at once. It moves to Select when the kit has it.
import { cn } from "@fin/ui";
import { useId } from "react";
import type { StaffRole } from "../api/contracts.ts";

export interface RoleChoice {
  readonly role: StaffRole;
  /** Why this role cannot be chosen, or null. */
  readonly disabledReason: string | null;
}

export function RolePicker(props: {
  label: string;
  choices: readonly RoleChoice[];
  value: string | null;
  onChange: (roleKey: string) => void;
  disabled?: boolean;
  error?: string | null;
}) {
  const id = `roles${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const errorId = `${id}-error`;
  const hasError = props.error !== undefined && props.error !== null;
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
      aria-describedby={hasError ? errorId : undefined}
      disabled={props.disabled === true}
    >
      <legend className="mb-2 p-0 text-label-sm text-text-secondary">{props.label}</legend>
      <div className="flex flex-col gap-1">
        {props.choices.map(({ role, disabledReason }) => {
          const optionId = `${id}-${role.key}`;
          const reasonId = `${optionId}-reason`;
          const unavailable = disabledReason !== null;
          const chosen = props.value === role.key;
          return (
            <label
              key={role.key}
              htmlFor={optionId}
              data-role={role.key}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-control border border-transparent px-3 py-2.5 transition-field",
                chosen ? "bg-fill-selected" : "hover:bg-fill-hover",
                unavailable && "cursor-not-allowed hover:bg-transparent",
              )}
            >
              <input
                id={optionId}
                type="radio"
                name={id}
                value={role.key}
                checked={chosen}
                disabled={unavailable || props.disabled === true}
                // Named by the role alone; the summary and any reason describe it.
                aria-labelledby={`${optionId}-label`}
                aria-describedby={`${optionId}-summary${unavailable ? ` ${reasonId}` : ""}`}
                onChange={() => props.onChange(role.key)}
                className="mt-0.5 size-4 shrink-0 accent-action-primary focus-visible:outline-focus"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span
                  id={`${optionId}-label`}
                  className={cn(
                    "text-label text-text-primary",
                    unavailable && "text-text-disabled",
                  )}
                >
                  {role.label}
                </span>
                <span id={`${optionId}-summary`} className="text-caption text-text-tertiary">
                  {role.summary}
                </span>
                {unavailable ? (
                  <span id={reasonId} className="text-caption text-text-secondary">
                    {disabledReason}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {hasError ? (
        <p id={errorId} className="m-0 text-caption text-status-danger-fg">
          {props.error}
        </p>
      ) : null}
    </fieldset>
  );
}
