// The sidebar's one collapse control (the owner, 21 Nov; [UI-11]; spec 06 §4.2; shell-v2 §3.1, §10,
// §11): IconButton, secondary, 24px (`size="xs"`, UR-02), round, centred on the sidebar's right
// border at the brand row. "Collapse sidebar" (‹) on the 224px sidebar, "Expand sidebar" (›) on the
// 64px rail, in the same place. Always visible at rest from 1280px; hidden below (the width forces
// the rail) and on phones. It is one element whatever its state, so a press keeps the focus on it;
// its tooltip is its name, on the right. Under every scrim, drawer, dialog and menu (`z-header`).
import { CaretLeftIcon, CaretRightIcon } from "@fin/icons";
import { IconButton } from "../foundation/button.tsx";
import { cn } from "../lib/cn.ts";

export interface EdgeToggleProps {
  collapsed: boolean;
  onToggle: () => void;
  /** The id of the sidebar's <nav>. */
  controls: string;
  /** 40px from the top in the console (under the Sandbox strip's row), 16px in Fin Admin. */
  offset: "console" | "admin";
}

export function EdgeToggle({ collapsed, onToggle, controls, offset }: EdgeToggleProps) {
  return (
    <div
      data-edge-toggle={collapsed ? "expand" : "collapse"}
      className={cn(
        "absolute z-header hidden -translate-x-1/2 xl:inline-flex",
        offset === "console" ? "top-10" : "top-4",
        collapsed ? "left-sidebar-collapsed" : "left-sidebar",
      )}
    >
      <IconButton
        label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        icon={collapsed ? <CaretRightIcon /> : <CaretLeftIcon />}
        variant="secondary"
        size="xs"
        tooltipSide="right"
        aria-expanded={!collapsed}
        aria-controls={controls}
        onClick={onToggle}
        className="rounded-full"
      />
    </div>
  );
}
