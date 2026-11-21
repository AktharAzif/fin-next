// The small pieces the shell's controls share, on the UI SDK's parts: the tooltip, the menu's
// popup chrome and rows. Behaviour, focus, keyboard, dismissal, positioning and ARIA are the SDK's;
// the look is tokens through Fin's utilities, keyed to the SDK's state attributes. Overlays render
// in place in the browser's top layer, with no portal (spec 06 §3.3).
import {
  MenuContent,
  MenuItem,
  MenuItemIcon,
  MenuItemIndicator,
  MenuRadioItem,
  MenuSeparator,
} from "@ui-sdk/react/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { classes } from "./classes.ts";
import { Glyph } from "./Glyph.tsx";
import type { ShellGlyphName } from "./glyph-data.ts";

export const TOOLTIP_CHROME =
  "z-tooltip max-w-64 rounded-sm bg-surface-inverse px-2 py-1 text-caption text-text-inverse shadow-popover origin-popup transition-opacity duration-fast state-starting:opacity-0 state-ending:opacity-0";

/**
 * A tooltip that names its trigger (an icon-only control): the trigger's accessible name is the
 * tooltip's text, so it is read once, not twice.
 */
export function NamingTooltip({
  label,
  side = "bottom",
  disabled,
  children,
}: {
  label: string;
  side?: "top" | "right" | "bottom" | "left";
  disabled?: boolean;
  children: ReactElement;
}) {
  return (
    <Tooltip type="label" delay={300} {...(disabled === undefined ? {} : { disabled })}>
      <TooltipTrigger render={children} />
      <TooltipContent side={side} sideOffset={8} className={TOOLTIP_CHROME}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

const POPUP_CHROME =
  "z-popover rounded-md border border-transparent bg-surface-raised p-1 text-body text-text-primary shadow-popover outline-none origin-popup transition-press duration-base state-starting:scale-97 state-starting:opacity-0 state-ending:opacity-0 motion-reduce:scale-100";

/** A menu's popup, 4px under its trigger (shell-v2 §5.6). `className` sets its width. */
export function MenuPopup({
  className,
  align = "start",
  children,
  ...rest
}: Omit<ComponentProps<typeof MenuContent>, "className"> & {
  className?: string;
  children: ReactNode;
}) {
  return (
    <MenuContent
      sideOffset={4}
      align={align}
      className={classes(POPUP_CHROME, className)}
      {...rest}
    >
      {children}
    </MenuContent>
  );
}

const ROW =
  "group/row relative flex min-h-8 w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-body text-text-primary outline-none state-highlighted:bg-fill-hover state-disabled:text-text-disabled state-pending:text-text-secondary";

function RowIcon({ glyph }: { glyph: ShellGlyphName }) {
  return (
    <MenuItemIcon className="flex text-text-tertiary group-data-highlighted/row:text-text-secondary">
      <Glyph name={glyph} />
    </MenuItemIcon>
  );
}

export function MenuRow({
  glyph,
  className,
  children,
  ...rest
}: Omit<ComponentProps<typeof MenuItem>, "className" | "children"> & {
  glyph?: ShellGlyphName;
  className?: string;
  children: ReactNode;
}) {
  return (
    <MenuItem className={classes(ROW, className)} {...rest}>
      {glyph === undefined ? null : <RowIcon glyph={glyph} />}
      {children}
    </MenuItem>
  );
}

/** A radio row with a caption line under its label (UR-05) and the check at its far end. */
export function MenuRadioRow({
  glyph,
  caption,
  className,
  children,
  ...rest
}: Omit<ComponentProps<typeof MenuRadioItem>, "className" | "children"> & {
  glyph?: ShellGlyphName;
  caption?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <MenuRadioItem className={classes(ROW, className)} {...rest}>
      {glyph === undefined ? null : <RowIcon glyph={glyph} />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{children}</span>
        {caption === undefined ? null : (
          <span className="truncate text-caption text-text-tertiary group-data-highlighted/row:text-text-secondary">
            {caption}
          </span>
        )}
      </span>
      <MenuItemIndicator className="ml-auto flex text-text-primary">
        <Glyph name="Check" />
      </MenuItemIndicator>
    </MenuRadioItem>
  );
}

export function MenuRule() {
  return <MenuSeparator className="-mx-1 my-1 h-px bg-border" />;
}

/** A static line at the top of a menu: who is signed in (not an item; never focused). */
export function MenuIdentity({ title, caption }: { title: string; caption: string }) {
  return (
    <div role="none" className="flex flex-col px-2 py-1.5">
      <span className="truncate text-label text-text-primary">{title}</span>
      <span className="truncate text-caption text-text-tertiary">{caption}</span>
    </div>
  );
}
