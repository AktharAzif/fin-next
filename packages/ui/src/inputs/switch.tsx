// Switch (spec 06 §3.3; the export's Switch spec) on the SDK's switch: a setting saved at once.
// While the change saves (`busy`) it shows the new value, keeps focus and ignores input.
import { Switch as SdkSwitch, SwitchThumb } from "@ui-sdk/react/switch";
import { type ComponentProps, type ReactNode, useId } from "react";
import { cn } from "../lib/cn.ts";

type SdkProps = ComponentProps<typeof SdkSwitch>;

export type SwitchProps = Omit<SdkProps, "className" | "children" | "style"> & {
  label: ReactNode;
  description?: ReactNode;
  /** `end` puts the label first and the switch at the far end, for settings rows. */
  placement?: "start" | "end";
  busy?: boolean;
  className?: string;
};

export function Switch(props: SwitchProps) {
  const { label, description, placement = "start", busy, className, id, readOnly, ...rest } = props;
  const switchId = id ?? `switch${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const control = (
    <SdkSwitch
      {...rest}
      id={switchId}
      readOnly={busy === true || readOnly === true}
      {...(busy === true ? { "aria-busy": true } : {})}
      {...(description === undefined ? {} : { "aria-describedby": `${switchId}-description` })}
      className={cn(
        "relative inline-flex h-5 w-8 shrink-0 cursor-pointer items-center rounded-full bg-border-strong p-0.5",
        "transition-field focus-visible:outline-focus data-checked:bg-action-primary",
        "data-disabled:cursor-not-allowed data-disabled:bg-surface-subtle aria-busy:cursor-progress",
      )}
    >
      <SwitchThumb className="block size-4 rounded-full bg-surface-raised shadow-button transition-popup data-checked:translate-x-3" />
    </SdkSwitch>
  );
  return (
    <div
      data-slot="fin-switch"
      className={cn(
        "flex items-start gap-3",
        placement === "end" && "flex-row-reverse justify-between",
        className,
      )}
    >
      <span className="flex h-5 items-center">{control}</span>
      <span className="flex flex-col gap-0.5">
        <label htmlFor={switchId} className="cursor-pointer text-body text-text-primary">
          {label}
        </label>
        {description === undefined ? null : (
          <span id={`${switchId}-description`} className="text-caption text-text-tertiary">
            {description}
          </span>
        )}
      </span>
    </div>
  );
}
