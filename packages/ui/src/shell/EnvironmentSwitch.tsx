// Sandbox or Production, in the console's header (spec 06 §4.3; the export's EnvironmentSwitch with
// the new lock sentence, UR-08), on the UI SDK's radio group named "Environment". While the
// organisation is not approved, Production is locked: a disabled but focusable option carrying
// data-env="production", with LockSimple as its first SVG child (the motion layer's lock shake) and a
// tooltip that says why; the arrow keys skip it. Chosen, Production is the solid inverse segment,
// the loudest control in the header. `pending` while a switch is in flight.
import { LockSimpleIcon } from "@fin/icons";
import { Radio, RadioGroup } from "@ui-sdk/react/radio";
import { Tooltip } from "../foundation/tooltip.tsx";
import { cn } from "../lib/cn.ts";

export type ShellEnvironment = "sandbox" | "production";

export interface EnvironmentSwitchProps {
  value: ShellEnvironment;
  onValueChange: (next: ShellEnvironment) => void;
  /** While Production isn't enabled: the sentence that says why. Null once it is unlocked. */
  productionLocked: string | null;
  /** The switch is in flight: `value` is already the new environment and its data is loading. */
  pending?: boolean;
}

const SEGMENT =
  "inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-label outline-none transition-colors duration-fast focus-visible:outline-focus";

export function EnvironmentSwitch({
  value,
  onValueChange,
  productionLocked,
  pending = false,
}: EnvironmentSwitchProps) {
  return (
    <RadioGroup
      aria-label="Environment"
      value={value}
      onValueChange={(next) => {
        if (next === "sandbox" || next === "production") onValueChange(next);
      }}
      {...(pending ? { "aria-busy": true, "data-pending": "" } : {})}
      className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-control bg-surface-subtle p-0.5"
    >
      <Radio
        value="sandbox"
        data-env="sandbox"
        className={cn(
          SEGMENT,
          "text-text-secondary hover:text-text-primary state-checked:bg-surface-raised state-checked:text-text-primary state-checked:shadow-button",
        )}
      >
        Sandbox
      </Radio>
      {productionLocked === null ? (
        <Radio
          value="production"
          data-env="production"
          className={cn(
            SEGMENT,
            "text-text-secondary hover:text-text-primary state-checked:bg-action-primary state-checked:text-on-action-primary",
          )}
        >
          Production
        </Radio>
      ) : (
        <Tooltip content={productionLocked} type="description" side="bottom">
          {/* biome-ignore lint/a11y/useSemanticElements: a disabled native radio could not be focused to say why it is locked */}
          <span
            role="radio"
            aria-checked="false"
            aria-disabled="true"
            tabIndex={0}
            data-env="production"
            data-disabled=""
            className={cn(SEGMENT, "cursor-not-allowed text-text-disabled")}
          >
            <LockSimpleIcon size={12} />
            Production
          </span>
        </Tooltip>
      )}
    </RadioGroup>
  );
}
