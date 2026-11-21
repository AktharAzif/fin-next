// Tabs and TabLinks (spec 06 §3.3; the design canvases' Tabs board).
//
// Tabs switch between views of one object or list without leaving the page: Transactions' All and
// To settle, the sections of a record in a drawer. The UI SDK's tabs entry carries the WAI-ARIA
// tabs pattern (the named tablist with a single tab stop, arrow keys that move and select, Home and
// End, each panel labelled by its tab, panels mounted only while chosen); Fin adds the look and two
// layouts:
//
// - `variant="page"`, under a page header. The row keeps to its own box, with no negative margin,
//   so it never widens a scroll container and never clips the first tab's focus ring; each label
//   sits inside its tab's 8px side padding, and a panel starts 24px under the 1px rule.
// - `variant="drawer"`, under a drawer header. The caller lets the tabs run out to the drawer's
//   edges, the rule spans the whole drawer, and the row and its panels are padded so labels and
//   content start on the drawer's 24px content edge.
//
// In both, a row too wide for its box (several tabs on a phone) scrolls sideways inside itself
// instead of widening the page, whether the parent is a block, a grid or a flex row. Tabs and
// panels draw their focus ring inside their own box, where no edge can clip it. A count follows a
// label only for work that waits for someone ("To settle 3"); with nothing waiting there is no
// count at all, never a 0.
//
// TabLinks draw the same row as a named <nav> holding a list of ordinary links, for tabs that are
// addresses of their own (Settings' sections, a customer's `?tab=`). They are not a tablist: every
// link is in the Tab order and the one on show carries aria-current="page". @fin/ui knows no
// router, so the app's router link comes in once, through TabLinks' `linkAs`.
//
// Every part takes only the props listed on its type, and hands the SDK or the markup nothing
// else. Each part's className is merged through cn: a class of the same utility family as one of
// the part's defaults replaces that default.
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

/** The box that holds a row: it may shrink below its content, and draws the 1px rule under it. */
const BAR = "min-w-0 border-b border-border";

/** The row itself, per layout; it scrolls sideways rather than overflow its box. */
const ROW: Record<Layout, string> = {
  page: "flex gap-3 overflow-x-auto",
  drawer: "flex gap-3 overflow-x-auto px-4",
};

/** A panel's place under the row, per layout; its focus ring is drawn inside it. */
const PANEL: Record<Layout, string> = {
  page: "pt-6",
  drawer: "px-6 py-5",
};

/** A tab or a tab link: 40px tall, 8px of padding either side, its label in the label role. */
const ITEM =
  "relative inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xs px-2 text-label text-text-secondary no-underline transition-fade focus-visible:outline-focus-inset";

/** The 2px bar under the chosen label, kept on ::after and faded in when it is chosen. */
const MARK =
  "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-text-primary after:opacity-0 after:transition-fade";

/** A tab's looks: unavailable beats chosen, so a disabled tab never shows the chosen mark. */
const TAB_ENABLED = "cursor-pointer hover:text-text-primary";
const TAB_CHOSEN = "text-text-primary after:opacity-100";
const TAB_DISABLED = "cursor-not-allowed text-text-disabled";

/** The number of things waiting behind a tab, as given, after its label; nothing when none wait. */
function Count(props: { value: number | undefined }) {
  if (props.value === undefined || !(props.value > 0)) return null;
  return (
    <span data-slot="tab-count" className="font-regular text-text-tertiary tabular-nums">
      {props.value}
    </span>
  );
}

/** Children as content only: a function of the SDK's state (its render form) is dropped. */
const content = (children: ReactNode): ReactNode =>
  typeof children === "function" ? null : children;

/** The named props that are set, and nothing else, so no other prop reaches the SDK. */
function only<P extends object, K extends keyof P>(props: P, names: readonly K[]): Pick<P, K> {
  const picked: Partial<Pick<P, K>> = {};
  for (const name of names) if (props[name] !== undefined) picked[name] = props[name];
  return picked as Pick<P, K>;
}

/** The SDK root's documented options that Fin's tabs take; `orientation` is not one (always a row). */
const ROOT_OPTIONS = [
  "value",
  "defaultValue",
  "onValueChange",
  "activation",
  "loop",
  "hiddenUntilFound",
  "controller",
  "id",
] as const;

export type TabsProps = Pick<ComponentProps<typeof SdkTabs>, (typeof ROOT_OPTIONS)[number]> & {
  /** `page` under a page header (the default); `drawer` under a drawer header, edge to edge. */
  variant?: Layout;
  className?: string;
  children: ReactNode;
};

/**
 * Views of one object or list, one shown at a time. Uncontrolled with `defaultValue`, else the
 * first tab that can be chosen; controlled with `value` and `onValueChange` (for a `?tab=` in the
 * URL), whose `details` are the SDK's own, so `details.cancel()` refuses a change. The tabs always
 * run in a row.
 */
export function Tabs(props: TabsProps) {
  const variant = props.variant ?? "page";
  return (
    <LayoutContext.Provider value={variant}>
      <SdkTabs
        {...only(props, ROOT_OPTIONS)}
        data-variant={variant}
        className={cn("flex min-w-0 flex-col", props.className)}
      >
        {content(props.children)}
      </SdkTabs>
    </LayoutContext.Provider>
  );
}

/** The tablist's accessible name: a label, or the id of an element that names it. */
type TabsListName =
  | { "aria-label": string; "aria-labelledby"?: never }
  | { "aria-labelledby": string; "aria-label"?: never };

export type TabsListProps = TabsListName & {
  /** Classes for the tablist itself, the row over its rule (its margins and placement). */
  className?: string;
  children: ReactNode;
};

/** The row of tabs over its rule. */
export function TabsList(props: TabsListProps) {
  const layout = useContext(LayoutContext);
  return (
    <SdkTabsList
      aria-label={props["aria-label"]}
      aria-labelledby={props["aria-labelledby"]}
      className={cn(BAR, ROW[layout], props.className)}
    >
      {content(props.children)}
    </SdkTabsList>
  );
}

export type TabProps = {
  /** Pairs the tab with the TabPanel of the same `value`. */
  value: string;
  /** Reachable with the arrow keys, as the pattern asks, but never chosen. */
  disabled?: boolean;
  /** Work waiting for someone behind this tab; leave it out, or 0, when nothing waits. */
  count?: number;
  className?: string;
  /** A noun in sentence case, the same words as the page or section it shows. */
  children: ReactNode;
};

/**
 * One tab, shown with the TabPanel of the same `value`. A `disabled` tab stays reachable with the
 * arrow keys, as the pattern asks, but can't be chosen; named by `value` or `defaultValue`, it
 * still looks unavailable, with no chosen mark.
 */
export function Tab({ value, disabled = false, count, className, children }: TabProps) {
  return (
    <SdkTabsTab
      value={value}
      disabled={disabled}
      className={(state) =>
        cn(
          ITEM,
          MARK,
          state.disabled ? TAB_DISABLED : [TAB_ENABLED, state.selected && TAB_CHOSEN],
          className,
        )
      }
    >
      {children}
      <Count value={count} />
    </SdkTabsTab>
  );
}

export type TabPanelProps = {
  /** The `value` of the Tab this panel belongs to. */
  value: string;
  /** Keeps the panel in the page, hidden, while its tab isn't chosen (to keep a draft). */
  keepMounted?: boolean;
  className?: string;
  children: ReactNode;
};

/**
 * The view for the Tab of the same `value`, in the page only while that tab is chosen. With
 * nothing focusable inside it takes a tab stop of its own, and shows the focus ring there.
 */
export function TabPanel({ value, keepMounted = false, className, children }: TabPanelProps) {
  const layout = useContext(LayoutContext);
  return (
    <SdkTabsPanel
      value={value}
      keepMounted={keepMounted}
      className={cn(
        "min-w-0 rounded-xs focus-visible:outline-focus-inset",
        PANEL[layout],
        className,
      )}
    >
      {content(children)}
    </SdkTabsPanel>
  );
}

/** What the app's router link receives: the address, the classes, aria-current and the label. */
export type TabLinkTargetProps = {
  href: string;
  className: string;
  "aria-current"?: "page";
  children: ReactNode;
};

const LinkContext = createContext<ElementType<TabLinkTargetProps>>("a");

export type TabLinksProps = {
  /** What the links move between ("Settings"); it names the <nav>. */
  label: string;
  /** `page` under a page header (the default); `drawer` under a drawer header, edge to edge. */
  variant?: Layout;
  /** The app's router link (a component or a tag name) for every TabLink inside; <a> by default. */
  linkAs?: ElementType<TabLinkTargetProps>;
  className?: string;
  children: ReactNode;
};

/** Tabs that are links: the same row, as a named navigation landmark holding a list. */
export function TabLinks({
  label,
  variant = "page",
  linkAs = "a",
  className,
  children,
}: TabLinksProps) {
  return (
    <nav aria-label={label} data-slot="tab-links" className={cn(BAR, className)}>
      <ul className={cn("m-0 list-none", ROW[variant])}>
        <LinkContext.Provider value={linkAs}>{children}</LinkContext.Provider>
      </ul>
    </nav>
  );
}

export type TabLinkProps = {
  href: string;
  /** The address on show: underlined, and announced as the current page. */
  current?: boolean;
  className?: string;
  children: ReactNode;
};

/** One link in TabLinks, as one item of its list. */
export function TabLink({ href, current = false, className, children }: TabLinkProps) {
  const Link = useContext(LinkContext);
  const classes = cn(ITEM, MARK, "hover:text-text-primary", current && TAB_CHOSEN, className);
  const target: TabLinkTargetProps = current
    ? { href, className: classes, "aria-current": "page", children }
    : { href, className: classes, children };
  return (
    <li className="flex shrink-0">
      <Link {...target} />
    </li>
  );
}
