// The sidebar's one collapse control (the owner, 21 Nov; [UI-11]; spec 06 §4.2; shell-v2 §3.1, §10,
// §11). A 24px round secondary icon button centred on the sidebar's right border at the brand row:
// "Collapse sidebar" (‹) on the 224px sidebar, "Expand sidebar" (›) on the 64px rail, in the same
// place. Always visible at rest from 1280px; hidden below (the width forces the rail) and on phones.
// It is one element whatever its state, so a press keeps the focus on it, and its tooltip is its
// name. Under every scrim, drawer, dialog and menu (`z-header`).
//
// IconButton's 24px size and the toggle itself are UI requests (UR-01, UR-02): this is the shell's
// own button until @fin/ui's IconButton gains `size="xs"`.
import { classes } from "./classes.ts";
import { Glyph } from "./Glyph.tsx";
import { NamingTooltip } from "./parts.tsx";

export interface EdgeToggleProps {
  collapsed: boolean;
  onToggle: () => void;
  /** The id of the sidebar's <nav>. */
  controls: string;
  /** 40px from the top in the console (under the Sandbox strip's row), 16px in Fin Admin. */
  offset: "console" | "admin";
}

export function EdgeToggle({ collapsed, onToggle, controls, offset }: EdgeToggleProps) {
  const name = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <div
      data-edge-toggle={collapsed ? "expand" : "collapse"}
      className={classes(
        "absolute z-header hidden -translate-x-1/2 xl:inline-flex",
        offset === "console" ? "top-10" : "top-4",
        collapsed ? "left-sidebar-collapsed" : "left-sidebar",
      )}
    >
      <NamingTooltip label={name} side="right">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={controls}
          onClick={onToggle}
          className="group/toggle inline-flex size-6 items-center justify-center rounded-full border border-transparent bg-surface-raised text-text-secondary shadow-button transition-press hover:text-text-primary hover:shadow-button-hover focus-visible:outline-focus active:scale-press"
        >
          <Glyph name={collapsed ? "CaretRight" : "CaretLeft"} />
        </button>
      </NamingTooltip>
    </div>
  );
}
