// Checkbox (spec 06 §3.3; the export's Checkbox spec) on the SDK's checkbox, with a native
// <label>. Indeterminate is for select-all. An error is one sentence linked by aria-describedby.
import { CheckIcon, MinusIcon } from "@fin/icons";
import { CheckboxIndicator, Checkbox as SdkCheckbox } from "@ui-sdk/react/checkbox";
import { type ComponentProps, type ReactNode, useId } from "react";
import { cn } from "../lib/cn.ts";

type SdkProps = ComponentProps<typeof SdkCheckbox>;

export type CheckboxProps = Omit<SdkProps, "className" | "children" | "style"> & {
  label?: ReactNode;
  description?: ReactNode;
  error?: string;
  invalid?: boolean;
  className?: string;
};

export function Checkbox(props: CheckboxProps) {
  const { label, description, error, invalid, className, id, ...rest } = props;
  const generated = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const boxId = id ?? `checkbox${generated}`;
  const describedBy = [
    error === undefined ? null : `${boxId}-error`,
    description === undefined ? null : `${boxId}-description`,
  ]
    .filter(Boolean)
    .join(" ");
  const isInvalid = invalid === true || error !== undefined;
  const box = (
    <SdkCheckbox
      {...rest}
      id={boxId}
      {...(describedBy === "" ? {} : { "aria-describedby": describedBy })}
      {...(isInvalid ? { "aria-invalid": true } : {})}
      className={cn(
        "group/box relative inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm",
        "border border-border-input bg-surface-raised text-on-action-primary transition-field focus-visible:outline-focus",
        "hover:border-border-input-hover data-checked:border-action-primary data-checked:bg-action-primary",
        "data-indeterminate:border-action-primary data-indeterminate:bg-action-primary",
        "aria-invalid:border-border-danger data-disabled:cursor-not-allowed data-disabled:border-border data-disabled:bg-surface-subtle data-disabled:text-text-disabled",
        label === undefined && className,
      )}
    >
      <CheckboxIndicator className="inline-flex">
        {(state) => (state.indeterminate ? <MinusIcon size={12} /> : <CheckIcon size={12} />)}
      </CheckboxIndicator>
    </SdkCheckbox>
  );
  if (label === undefined) return box;
  return (
    <div data-slot="fin-checkbox" className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-start gap-2">
        <span className="flex h-5 items-center">{box}</span>
        <div className="flex flex-col gap-0.5">
          <label htmlFor={boxId} className="cursor-pointer text-body text-text-primary">
            {label}
          </label>
          {description === undefined ? null : (
            <p id={`${boxId}-description`} className="m-0 text-caption text-text-tertiary">
              {description}
            </p>
          )}
        </div>
      </div>
      {error === undefined ? null : (
        <p id={`${boxId}-error`} className="m-0 pl-6 text-caption text-status-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}
