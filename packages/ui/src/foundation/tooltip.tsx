// Tooltip and TooltipProvider (spec 06 §3.3) on the SDK's tooltip. The text stays in the page,
// hidden, as the trigger's name or description, so it is there before focus reaches the trigger.
import { Tooltip as SdkTooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { createContext, type ReactElement, type ReactNode, useContext } from "react";
import { cn } from "../lib/cn.ts";

const Delay = createContext<number | undefined>(undefined);

/** Sets how long the pointer rests before tooltips open. Mount once near the root. */
export function TooltipProvider(props: { delay?: number; children: ReactNode }) {
  return <Delay.Provider value={props.delay}>{props.children}</Delay.Provider>;
}

export type TooltipProps = {
  /** Plain words. Empty (null, false or "") renders the trigger alone. */
  content: ReactNode;
  /** The trigger: one element that takes props and a ref (Button, IconButton, a focusable span). */
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /**
   * `label` names the trigger with the text (an icon-only control), `description` adds it as a
   * description. By default the SDK names a trigger with no name of its own and describes others.
   */
  type?: "label" | "description";
  /** Mono, for full IDs, hashes and addresses. */
  mono?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Keeps the tooltip open when the trigger is pressed (a copy button turning into "Copied"). */
  closeOnPress?: boolean;
};

export function Tooltip(props: TooltipProps) {
  const delay = useContext(Delay);
  if (props.content === null || props.content === false || props.content === "") {
    return props.children;
  }
  return (
    <SdkTooltip
      {...(delay === undefined ? {} : { delay })}
      {...(props.type === undefined ? {} : { type: props.type })}
      {...(props.open === undefined ? {} : { open: props.open })}
      {...(props.defaultOpen === undefined ? {} : { defaultOpen: props.defaultOpen })}
      {...(props.closeOnPress === undefined ? {} : { closeOnPress: props.closeOnPress })}
      {...(props.onOpenChange === undefined
        ? {}
        : { onOpenChange: (open: boolean) => props.onOpenChange?.(open) })}
    >
      <TooltipTrigger render={props.children} />
      <TooltipContent
        side={props.side ?? "top"}
        align={props.align ?? "center"}
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          "max-w-60 rounded-sm bg-surface-inverse px-2 py-1 text-caption text-text-inverse shadow-popover",
          "origin-popup transition-tooltip state-starting:scale-pop state-starting:opacity-0",
          "state-ending:scale-pop state-ending:opacity-0 state-ending:duration-fast-exit state-instant:transition-none",
          props.mono === true && "font-mono text-mono break-all",
        )}
      >
        {props.content}
      </TooltipContent>
    </SdkTooltip>
  );
}
