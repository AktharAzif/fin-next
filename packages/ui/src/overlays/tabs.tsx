// Tabs and TabLinks (spec 06 §3.3; the design canvases' Tabs board).
//
// Tabs switch between views of one object or list without leaving the page: Transactions' All and
// To settle, the sections of a record in a drawer. The UI SDK's tabs entry carries the WAI-ARIA
// tabs pattern (the named tablist with a single tab stop, arrow keys that move and select, Home and
// End, each panel labelled by its tab, panels mounted only while chosen); Fin adds the look and two
// layouts:
//
// - `variant="page"`, under a page header. The row reaches 8px past the content on each side, the
//   side padding of one tab, so labels start on the content edge and the inset focus ring never
//   meets a label; the 1px rule below stays on the content's own width.
// - `variant="drawer"`, under a drawer header. The caller lets the tabs run out to the drawer's
//   edges, the rule spans the whole drawer, and the row is padded so labels start on the drawer's
//   24px content edge.
//
// In both, a row too wide for its box (several tabs on a phone) scrolls sideways inside itself
// instead of widening the page. A count follows a label only for work that waits for someone
// ("To settle 3"); with nothing waiting there is no count at all, never a 0.
//
// TabLinks draw the same row as a named <nav> of ordinary links, for tabs that are addresses of
// their own (Settings' sections, a customer's `?tab=`). They are not a tablist: every link is in
// the Tab order and the one on show carries aria-current="page". @fin/ui knows no router, so the
// app's router link comes in through `linkAs`.
import {
  Tabs as SdkTabs,
  TabsList as SdkTabsList,
  TabsPanel as SdkTabsPanel,
  TabsTab as SdkTabsTab,
} from "@ui-sdk/react/tabs";
import {
  type ComponentProps,
  createContext,
  type ElementType,
  type ReactNode,
  useContext,
} from "react";
import { cn } from "../lib/cn.ts";

type Layout = "page" | "drawer";

const LayoutContext = createContext<Layout>("page");

/** The box that holds a row: it draws the 1px rule along its bottom edge. */
const BAR = "min-w-0 border-b border-border";

/** The row itself, per layout; it scrolls sideways rather than overflow its box. */
const ROW: Record<Layout, string> = {
  page: "-mx-2 flex overflow-x-auto",
  drawer: "flex overflow-x-auto px-4",
};

/** A tab or a tab link: 40px tall, 8px of padding either side, its label in the label role. */
const ITEM =
  "relative inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xs px-2 text-label text-text-secondary no-underline transition-fade focus-visible:outline-focus-inset";

/** The 2px bar under the chosen label, kept on ::after and faded in when it is chosen. */
const MARK =
  "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-text-primary after:opacity-0 after:transition-fade";

/** A tab's chosen and unavailable looks, from the SDK's data-selected and data-disabled. */
const TAB_STATES =
  "cursor-pointer state-active:text-text-primary state-active:after:opacity-100 state-disabled:cursor-not-allowed state-disabled:text-text-disabled";

/** The number of things waiting behind a tab, after its label; nothing when none wait. */
function Count(props: { value: number | undefined }) {
  if (props.value === undefined || !(props.value > 0)) return null;
  return (
    <span className="text-text-tertiary tabular-nums">{props.value.toLocaleString("en-GB")}</span>
  );
}

export type TabsProps = Omit<
  ComponentProps<typeof SdkTabs>,
  "orientation" | "className" | "render" | "children"
> & {
  /** `page` under a page header (the default); `drawer` under a drawer header, edge to edge. */
  variant?: Layout;
  className?: string;
  children: ReactNode;
};

/**
 * Views of one object or list, one shown at a time. Uncontrolled with `defaultValue`, else the
 * first tab that can be chosen; controlled with `value` and `onValueChange` (for a `?tab=` in the
 * URL). The tabs always run in a row.
 */
export function Tabs({ variant = "page", className, children, ...props }: TabsProps) {
  return (
    <LayoutContext.Provider value={variant}>
      <SdkTabs {...props} data-variant={variant} className={cn("min-w-0", className)}>
        {children}
      </SdkTabs>
    </LayoutContext.Provider>
  );
}

type TabsListProps = Omit<
  ComponentProps<typeof SdkTabsList>,
  "className" | "render" | "children"
> & {
  /** What the tabs switch between ("Customer"); it is the tablist's name, so it is required. */
  "aria-label": string;
  /** Classes for the bar around the row (its margins and placement). */
  className?: string;
  children: ReactNode;
};

/** The row of tabs over its rule. */
export function TabsList({ className, children, ...props }: TabsListProps) {
  const layout = useContext(LayoutContext);
  return (
    <div data-slot="tabs-bar" className={cn(BAR, className)}>
      <SdkTabsList {...props} className={ROW[layout]}>
        {children}
      </SdkTabsList>
    </div>
  );
}

type TabProps = Omit<ComponentProps<typeof SdkTabsTab>, "className" | "render" | "children"> & {
  /** Work waiting for someone behind this tab; leave it out, or 0, when nothing waits. */
  count?: number;
  className?: string;
  /** A noun in sentence case, the same words as the page or section it shows. */
  children: ReactNode;
};

/**
 * One tab, shown with the TabPanel of the same `value`. A `disabled` tab stays reachable with the
 * arrow keys, as the pattern asks, but can't be chosen.
 */
export function Tab({ count, className, children, ...props }: TabProps) {
  return (
    <SdkTabsTab
      {...props}
      className={(state) =>
        cn(ITEM, MARK, TAB_STATES, !state.disabled && "hover:text-text-primary", className)
      }
    >
      {children}
      <Count value={count} />
    </SdkTabsTab>
  );
}

type TabPanelProps = Omit<ComponentProps<typeof SdkTabsPanel>, "className" | "render"> & {
  className?: string;
};

/**
 * The view for the Tab of the same `value`, in the page only while that tab is chosen. With
 * nothing focusable inside it takes a tab stop of its own, and shows the focus ring there.
 */
export function TabPanel({ className, ...props }: TabPanelProps) {
  return (
    <SdkTabsPanel
      {...props}
      className={cn("min-w-0 rounded-xs focus-visible:outline-focus", className)}
    />
  );
}

/** The app's router link: it receives the address, the classes, aria-current and the label. */
type TabLinkElement = ElementType<{
  href: string;
  className?: string;
  "aria-current"?: "page" | undefined;
  children?: ReactNode;
}>;

const LinkContext = createContext<TabLinkElement>("a");

type TabLinksProps = {
  /** What the links move between ("Settings"); it names the <nav>. */
  label: string;
  /** `page` under a page header (the default); `drawer` under a drawer header, edge to edge. */
  variant?: Layout;
  /** The app's router link for every TabLink inside; a plain <a> when left out. */
  linkAs?: TabLinkElement;
  className?: string;
  children: ReactNode;
};

/** Tabs that are links: the same row, as a named navigation landmark. */
export function TabLinks({
  label,
  variant = "page",
  linkAs = "a",
  className,
  children,
}: TabLinksProps) {
  return (
    <nav aria-label={label} data-slot="tab-links" className={cn(BAR, className)}>
      <div className={ROW[variant]}>
        <LinkContext.Provider value={linkAs}>{children}</LinkContext.Provider>
      </div>
    </nav>
  );
}

type TabLinkProps = {
  href: string;
  /** The address on show: underlined, and announced as the current page. */
  current?: boolean;
  /** Work waiting for someone behind this link; leave it out, or 0, when nothing waits. */
  count?: number;
  /** A router link for this one link, in place of the one TabLinks hands down. */
  linkAs?: TabLinkElement;
  className?: string;
  children: ReactNode;
};

/** One link in TabLinks. */
export function TabLink({
  href,
  current = false,
  count,
  linkAs,
  className,
  children,
}: TabLinkProps) {
  const inherited = useContext(LinkContext);
  const Link = linkAs ?? inherited;
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        ITEM,
        MARK,
        "hover:text-text-primary",
        current && "text-text-primary after:opacity-100",
        className,
      )}
    >
      {children}
      <Count value={count} />
    </Link>
  );
}
