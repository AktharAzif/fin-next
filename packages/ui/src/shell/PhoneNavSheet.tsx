// The phone's navigation (spec 06 §4.1; the canvases' MobileNavFrame): below 1024px a menu button
// opens the sidebar as a 288px sheet from the left, on the UI SDK's Dialog: touch-size items, focus
// trapped and returned to the menu button, the page behind dimmed and inert. Choosing a page closes
// it. There is no edge toggle here.
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@ui-sdk/react/dialog";
import { useState } from "react";
import { Glyph } from "./Glyph.tsx";
import { NamingTooltip } from "./parts.tsx";
import { type ShellLink, Sidebar, type SidebarBrand, type SidebarNav } from "./Sidebar.tsx";

export interface PhoneNavSheetProps {
  nav: SidebarNav;
  brand: SidebarBrand;
  linkAs: ShellLink;
  navElementId: string;
  /** Documentation and the kit only: start open. */
  defaultOpen?: boolean;
}

const ICON_BUTTON =
  "inline-flex size-8 items-center justify-center rounded-control text-text-secondary outline-none transition-colors duration-fast hover:bg-fill-hover hover:text-text-primary focus-visible:outline-focus";

export function PhoneNavSheet({
  nav,
  brand,
  linkAs,
  navElementId,
  defaultOpen = false,
}: PhoneNavSheetProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Dialog open={open} onOpenChange={(next) => setOpen(next)}>
      <NamingTooltip label="Open navigation">
        <DialogTrigger data-phone-nav-trigger="" className={ICON_BUTTON}>
          <Glyph name="List" />
        </DialogTrigger>
      </NamingTooltip>
      <DialogBackdrop className="fixed inset-0 z-scrim bg-overlay transition-opacity duration-slow state-starting:opacity-0 state-ending:opacity-0" />
      <DialogContent
        data-phone-nav=""
        className="fixed inset-y-0 left-0 z-drawer m-0 flex h-dvh max-h-none w-72 max-w-full flex-col border-0 border-r border-border bg-surface p-0 text-text-primary shadow-overlay outline-none transition-transform duration-slow state-starting:-translate-x-full state-ending:-translate-x-full motion-reduce:transition-opacity motion-reduce:state-starting:translate-x-0 motion-reduce:state-ending:translate-x-0"
      >
        <DialogTitle className="sr-only">Navigation</DialogTitle>
        <Sidebar
          nav={nav}
          brand={brand}
          mode="touch"
          linkAs={linkAs}
          navElementId={navElementId}
          onNavigate={() => setOpen(false)}
          close={
            <NamingTooltip label="Close navigation">
              <DialogClose className={ICON_BUTTON}>
                <Glyph name="X" />
              </DialogClose>
            </NamingTooltip>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
