// Tabs (spec 06 §3.3, the Tabs board). Tabs, TabsList, Tab and TabPanel switch between views of one
// record or list without leaving the page; TabLinks and TabLink draw the same row as links, for
// tabs that are routes of their own (Settings, a customer's page). The SDK's tabs bring the roles,
// the arrow keys, Home and End, and the panel wiring; this file adds Fin's look: 40px tabs with
// labels 28px apart, a 2px mark under the chosen tab, a 1px rule under the row, a count only for
// work that waits, and the inside focus ring where an outside one would be cut off.
//
// Closed props: each part reads the props its type lists, one by one, and hands the SDK or the
// page nothing else. A style, an id, a data or aria attribute, raw markup or a `render` that a
// caller slips in (a spread escapes tsc's excess-property check) never reaches the markup.
import {
  Tabs as SdkTabs,
  TabsList as SdkTabsList,
  TabsPanel as SdkTabsPanel,
  TabsTab as SdkTabsTab,
} from "@ui-sdk/react/tabs";
import { type ComponentType, createContext, type ReactNode, useContext } from "react";
import { cn } from "../lib/cn.ts";

/** `page` sits under a page header; `drawer` under a drawer's header, inset to its padding. */
export type TabsVariant = "page" | "drawer";

export type TabsProps = {
  /** The chosen tab, when the page holds it (from `?tab=`, say). `null` chooses none. */
  value?: string | null | undefined;
  /** The tab chosen first when the page does not hold the choice; else the first enabled tab. */
  defaultValue?: string | null | undefined;
  /** Hears the tab a person chooses, by pointer or keys; not called for the first choice. */
  onValueChange?: ((value: string | null) => void) | undefined;
  variant?: TabsVariant | undefined;
  className?: string | undefined;
  children?: ReactNode;
};

/** The tablist's name: its own words, or the ID of the element that names it. One is required. */
type TabsListName =
  | { "aria-label": string; "aria-labelledby"?: undefined }
  | { "aria-labelledby": string; "aria-label"?: undefined };

export type TabsListProps = TabsListName & {
  /** Goes on the row around the list (its margin, say); the list keeps its own placing. */
  className?: string | undefined;
  children?: ReactNode;
};

export type TabProps = {
  /** Pairs the tab with the TabPanel of the same value. */
  value: string;
  /** Reachable by the arrow keys, never chosen. */
  disabled?: boolean | undefined;
  /** Work waiting behind the tab. Left out unless it is a whole number above 0. */
  count?: number | undefined;
  className?: string | undefined;
  children?: ReactNode;
};

export type TabPanelProps = {
  value: string;
  className?: string | undefined;
  children?: ReactNode;
};

/** What TabLinks hands the app's link component: these four props and no others. */
export type TabLinkTargetProps = {
  href: string;
  className: string;
  "aria-current"?: "page";
  children: ReactNode;
};

export type TabLinksProps = {
  /** Names the navigation landmark ("Settings"). */
  label: string;
  variant?: TabsVariant | undefined;
  /** The app's router link; a plain <a> when left out. */
  linkAs?: ComponentType<TabLinkTargetProps> | undefined;
  className?: string | undefined;
  children?: ReactNode;
};

export type TabLinkProps = {
  href: string;
  /** Marks the page being shown (aria-current="page"). */
  current?: boolean | undefined;
  count?: number | undefined;
  className?: string | undefined;
  children?: ReactNode;
};

const VariantContext = createContext<TabsVariant>("page");

function Anchor(props: TabLinkTargetProps) {
  return (
    <a href={props.href} className={props.className} aria-current={props["aria-current"]}>
      {props.children}
    </a>
  );
}

const LinkContext = createContext<ComponentType<TabLinkTargetProps>>(Anchor);

/** Anything but `drawer` is the page variant, so an unknown value still draws a usable row. */
const variantOf = (variant: unknown): TabsVariant => (variant === "drawer" ? "drawer" : "page");

/**
 * Content only. The SDK calls a function child with its state, so a function that got past the
 * types (a spread, plain JavaScript) is dropped here instead.
 */
const content = (node: ReactNode): ReactNode => (typeof node === "function" ? null : node);

/** A count is shown only for waiting work: a whole number above 0, written plainly (1234). */
function countText(count: unknown): string | null {
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0
    ? String(count)
    : null;
}

/** The 1px rule under the row. */
const ROW = "border-b border-border";

/**
 * The list: 12px between tabs, which with each tab's 8px padding puts labels 28px apart. On a page
 * it pulls back by that 8px so the first label sits on the content edge; in a drawer it sits 16px
 * in, so labels start 24px from the edge. A row too wide scrolls inside itself.
 */
const LIST = "flex gap-3 overflow-x-auto";
const LIST_PLACE: Record<TabsVariant, string> = {
  page: "-mx-2",
  drawer: "px-4",
};

/**
 * A panel starts 24px under the rule on a page. In a drawer it carries the drawer's padding and
 * reaches the drawer's edges, so its focus ring (the SDK makes a panel with nothing focusable a
 * tab stop) is drawn inside, where the drawer cannot cut it off.
 */
const PANEL_PLACE: Record<TabsVariant, string> = {
  page: "pt-6",
  drawer: "px-6 py-5 focus-visible:outline-focus-inset",
};

/** A tab or tab link: 40px tall, the label type, the mark drawn by ::after, the ring inside. */
const ITEM = cn(
  "relative inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap px-2",
  "text-label transition-fade focus-visible:outline-focus-inset",
  "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-transparent after:transition-fade",
);

/** A tab's colours by the SDK's state: secondary, primary with the mark when chosen, muted off. */
const TAB_STATE = cn(
  "text-text-secondary cursor-pointer",
  "not-state-disabled:hover:text-text-primary",
  "state-active:text-text-primary state-active:after:bg-text-primary",
  "state-disabled:cursor-not-allowed state-disabled:text-text-disabled",
);

const LINK_STATE = {
  current: "text-text-primary after:bg-text-primary",
  other: "text-text-secondary hover:text-text-primary",
};

function Count(props: { text: string | null }) {
  if (props.text === null) return null;
  return (
    <span data-slot="tab-count" className="font-regular text-text-tertiary">
      {props.text}
    </span>
  );
}

export function Tabs(props: TabsProps) {
  const listener = props.onValueChange;
  return (
    <VariantContext value={variantOf(props.variant)}>
      <SdkTabs
        value={props.value}
        defaultValue={props.defaultValue}
        onValueChange={listener === undefined ? undefined : (next) => listener(next)}
        className={cn("flex flex-col", props.className)}
      >
        {content(props.children)}
      </SdkTabs>
    </VariantContext>
  );
}

export function TabsList(props: TabsListProps) {
  const variant = useContext(VariantContext);
  const label = props["aria-label"];
  return (
    <div data-slot="tabs-row" className={cn(ROW, props.className)}>
      <SdkTabsList
        aria-label={label}
        aria-labelledby={label === undefined ? props["aria-labelledby"] : undefined}
        className={cn(LIST, LIST_PLACE[variant])}
      >
        {content(props.children)}
      </SdkTabsList>
    </div>
  );
}

export function Tab(props: TabProps) {
  return (
    <SdkTabsTab
      value={props.value}
      disabled={props.disabled === true}
      className={cn(ITEM, TAB_STATE, props.className)}
    >
      {content(props.children)}
      <Count text={countText(props.count)} />
    </SdkTabsTab>
  );
}

export function TabPanel(props: TabPanelProps) {
  const variant = useContext(VariantContext);
  return (
    <SdkTabsPanel value={props.value} className={cn(PANEL_PLACE[variant], props.className)}>
      {content(props.children)}
    </SdkTabsPanel>
  );
}

export function TabLinks(props: TabLinksProps) {
  return (
    <nav aria-label={props.label} className={cn(ROW, props.className)}>
      <ul className={cn(LIST, LIST_PLACE[variantOf(props.variant)])}>
        <LinkContext value={props.linkAs ?? Anchor}>{content(props.children)}</LinkContext>
      </ul>
    </nav>
  );
}

export function TabLink(props: TabLinkProps) {
  const Link = useContext(LinkContext);
  const current = props.current === true;
  const marked = current ? ({ "aria-current": "page" } as const) : {};
  return (
    <li className="flex shrink-0">
      <Link
        href={props.href}
        className={cn(ITEM, current ? LINK_STATE.current : LINK_STATE.other, props.className)}
        {...marked}
      >
        {content(props.children)}
        <Count text={countText(props.count)} />
      </Link>
    </li>
  );
}
