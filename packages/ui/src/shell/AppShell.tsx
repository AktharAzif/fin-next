// The frame around every signed-in page of the console and Fin Admin (spec 06 §4.1; shell-v2 §3,
// §6; the export's AppShell with the 21 Nov deltas). Layout by width: from 1280px the 224px sidebar,
// or the 64px rail if the person collapsed it; from 1024 to 1279px the rail, forced; below 1024px a
// menu button opens the sidebar as a sheet and the header takes two rows. `<main>` is the scroll
// container, so sticky table headers stick under the header.
//
// DOM and Tab order: (the skip link, in index.html), the strip, the sidebar column (brand link,
// edge toggle, navigation, pinned footer), the header (the `environment` slot, then the account),
// then `<main id="main">`.
import { type ReactNode, useId } from "react";
import { Logo } from "../foundation/logo.tsx";
import { EdgeToggle } from "./EdgeToggle.tsx";
import { PhoneNavSheet } from "./PhoneNavSheet.tsx";
import {
  type ShellLink,
  Sidebar,
  type SidebarBrand,
  type SidebarMode,
  type SidebarNav,
} from "./Sidebar.tsx";
import { useShellWidth } from "./width.ts";

export type AppShellLayout = "auto" | "expanded" | "collapsed" | "mobile";

export interface AppShellProps {
  /** The console (the strip's row puts the edge toggle 40px down) or Fin Admin (16px). */
  variant: "console" | "admin";
  nav: SidebarNav;
  brand: SidebarBrand;
  linkAs: ShellLink;
  /** The person's choice; it applies from 1280px only. */
  collapsed: boolean;
  onCollapsedChange: (next: boolean) => void;
  /** The console in Sandbox: the 24px strip reading "Sandbox" (UR-06). Production shows none. */
  strip?: "sandbox" | null;
  /** The header's left: the organisation switcher and the EnvironmentSwitch, or the deployment. */
  environment: ReactNode;
  /** The header's right: the AccountMenu, or the staff menu. */
  account: ReactNode;
  /** The navigation bar, drawn across the top of the content. */
  progress?: ReactNode;
  /** `auto` follows the width; the others force one layout (the kit and the boards only). */
  layout?: AppShellLayout;
  children: ReactNode;
}

export function AppShell({
  variant,
  nav,
  brand,
  linkAs: Link,
  collapsed,
  onCollapsedChange,
  strip = null,
  environment,
  account,
  progress,
  layout = "auto",
  children,
}: AppShellProps) {
  const width = useShellWidth();
  const navElementId = useId();
  const phone = layout === "mobile" || (layout === "auto" && width === "narrow");
  const mode: SidebarMode =
    layout === "expanded"
      ? "expanded"
      : layout === "collapsed"
        ? "rail"
        : width === "wide" && !collapsed
          ? "expanded"
          : "rail";
  const toggleShown =
    layout === "expanded" || layout === "collapsed" || (layout === "auto" && width === "wide");

  const main = (
    <div className="relative min-h-0 flex-1">
      {progress}
      <main
        id="main"
        data-app-shell-main=""
        tabIndex={-1}
        className="h-full overflow-y-auto outline-none"
      >
        {children}
      </main>
    </div>
  );

  return (
    <div
      data-app-shell={variant}
      data-layout={phone ? "mobile" : mode}
      className="relative flex h-dvh flex-col overflow-hidden bg-bg text-body text-text-primary"
    >
      {strip === "sandbox" ? (
        <div
          data-strip="sandbox"
          className="flex h-6 shrink-0 items-center justify-center bg-surface-subtle text-caption font-medium text-text-secondary"
        >
          Sandbox
        </div>
      ) : null}
      {phone ? (
        <>
          <header className="shrink-0 border-b border-border bg-bg">
            <div className="flex h-12 items-center gap-3 px-2">
              <PhoneNavSheet nav={nav} brand={brand} linkAs={Link} navElementId={navElementId} />
              <Link
                href={brand.href}
                aria-label={brand.label}
                className="flex rounded-control focus-visible:outline-focus"
              >
                <Logo variant="mark" height={18} />
              </Link>
              <div className="ml-auto flex items-center pr-2">{account}</div>
            </div>
            <div className="flex min-w-0 items-center gap-3 px-3 pb-2">{environment}</div>
          </header>
          {main}
        </>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="h-full shrink-0">
            <Sidebar
              nav={nav}
              brand={brand}
              mode={mode}
              linkAs={Link}
              navElementId={navElementId}
              toggle={
                toggleShown ? (
                  <EdgeToggle
                    collapsed={mode === "rail"}
                    onToggle={() => onCollapsedChange(mode !== "rail")}
                    controls={navElementId}
                    offset={variant}
                  />
                ) : null
              }
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-header shrink-0 items-center justify-between gap-3 border-b border-border bg-bg px-6">
              <div className="flex min-w-0 items-center gap-3">{environment}</div>
              {account}
            </header>
            {main}
          </div>
        </div>
      )}
    </div>
  );
}

/** The page's content box inside AppShell: the gutters (16, 24, 32px) and the vertical rhythm. */
export function AppShellContent({ notice, children }: { notice?: ReactNode; children: ReactNode }) {
  return (
    <div className="w-full px-4 pt-6 pb-16 md:px-6 lg:px-8 lg:pt-8">
      {notice === undefined || notice === null ? null : (
        // Empty (every notice rendered nothing): no box and no gap above the page.
        <div data-notices="" className="mb-6 flex flex-col gap-3 empty:hidden">
          {notice}
        </div>
      )}
      {children}
    </div>
  );
}
