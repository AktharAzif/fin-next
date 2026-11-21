// Tabs and TabLinks (spec 06 §3.3, on the SDK's `tabs` entry; the Tabs board of the design canvas).
//
// Tabs switch between views of one object inside the page: the SDK gives the tablist its single tab
// stop, the arrow keys that move and choose, Home and End, and each panel its name; Fin gives the
// look. TabLinks look the same but are a named navigation of real links (Settings, a customer's
// tabs), the current one marked aria-current="page"; the app's router link comes in through
// `linkAs` on TabLinks.
//
// The look, measured on the board and on the screens that use it: each tab is 40px tall with 8px
// either side of its label and 12px between tabs, so labels sit 28px apart; the chosen tab's label
// takes the primary text colour over a 2px mark as wide as the label, the others are secondary
// until hovered; a count follows the label by 6px, regular weight, tertiary; focus draws the ring
// 2px inside the tab. A 1px rule runs under the row. Under a page header ("page", the default)
// the labels line up with the content edge, the row pulling back by a tab's 8px so the ring never
// touches a label, and a panel starts 24px under the rule. Across a drawer ("drawer") the labels
// sit 24px in, as the drawer's padding does, and a panel keeps that inset with 20px above and
// below. A row wider than its box scrolls inside itself, never the page. A caller's className wins
// over any of these through `cn`; on TabsList it styles the row, the element that carries the rule.
//
// Each part takes a closed list of props, only what the screens need. Tabs are horizontal (the
// design's Tabs leave out `orientation`), their root is always a <div> (no `render`), and no part
// takes `style` or raw markup. A count shows waiting work, as the plain number, and only above 0.
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

export type TabsVariant = "page" | "drawer";

type SdkTabsProps = ComponentProps<typeof SdkTabs>;

export interface TabsProps {
  /** The chosen tab, when the caller owns the choice (a page's `?tab=`). */
  value?: string | null | undefined;
  /** The tab chosen first when the tabs own the choice; without either, the first enabled tab. */
  defaultValue?: string | null | undefined;
  /** Called with the tab a person chose, and the SDK's details of why. */
  onValueChange?: SdkTabsProps["onValueChange"];
  /** "page" under a page header (the default); "drawer" across a drawer, under its header. */
  variant?: TabsVariant | undefined;
  className?: string | undefined;
  children: ReactNode;
}

/** The tablist's name, saying what it switches between ("Customer"). One of the two is required. */
type TabsListName =
  | { "aria-label": string; "aria-labelledby"?: never }
  | { "aria-labelledby": string; "aria-label"?: never };

export type TabsListProps = TabsListName & {
  className?: string | undefined;
  children: ReactNode;
};

export interface TabProps {
  value: string;
  /** The arrow keys still reach it, but it is never chosen. */
  disabled?: boolean | undefined;
  /** Work waiting behind the tab ("To settle 3"); left out when there is none, never 0. */
  count?: number | undefined;
  className?: string | undefined;
  children: ReactNode;
}

export interface TabPanelProps {
  /** The value of the tab that shows this panel. */
  value: string;
  className?: string | undefined;
  children: ReactNode;
}

/**
 * What a TabLinks link component is given: a real link, marked when it is the page being shown.
 * `aria-current` is "page" or absent, so a link typed `"aria-current"?: "page"` fits as well as an
 * anchor's attributes do.
 */
export interface TabLinkTargetProps {
  href: string;
  className: string;
  children: ReactNode;
  "aria-current"?: "page";
}

export interface TabLinksProps {
  /** The navigation's name ("Settings"). */
  label: string;
  variant?: TabsVariant | undefined;
  /** The app's router link (@fin/frame's RouterLink); a plain <a> by default. */
  linkAs?: ElementType<TabLinkTargetProps> | undefined;
  className?: string | undefined;
  children: ReactNode;
}

export interface TabLinkProps {
  href: string;
  /** This link is the page being shown. */
  current?: boolean | undefined;
  /** Work waiting behind the link; left out when there is none, never 0. */
  count?: number | undefined;
  className?: string | undefined;
  children: ReactNode;
}

const VariantContext = createContext<TabsVariant>("page");
const LinkContext = createContext<ElementType<TabLinkTargetProps>>("a");

/** The row: the rule under the tabs, at the content's width while the list inside it scrolls. */
const ROW = "min-w-0 border-b border-border";

/** The list inside the row: it scrolls sideways, pulled back (page) or inset (drawer). */
const LIST = "flex gap-3 overflow-x-auto";
const LIST_PLACE: Record<TabsVariant, string> = {
  page: "-mx-2 px-0",
  drawer: "mx-0 px-4",
};

/**
 * A tab or a link: its box, label type, colours and focus ring, and the 2px mark drawn under its
 * label by ::after, coloured only on the chosen tab or the current link.
 */
const ITEM = [
  "relative inline-flex h-10 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-xs px-2",
  "whitespace-nowrap text-label text-text-secondary no-underline transition-fade",
  "focus-visible:outline-focus-inset",
  "after:pointer-events-none after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-transparent",
];

const PANEL_PLACE: Record<TabsVariant, string> = {
  page: "pt-6",
  drawer: "px-6 py-5",
};

function Count(props: { count: number | undefined }) {
  if (typeof props.count !== "number" || !(props.count > 0)) return null;
  return (
    <span data-slot="tab-count" className="font-regular text-text-tertiary">
      {props.count}
    </span>
  );
}

export function Tabs(props: TabsProps) {
  const variant = props.variant ?? "page";
  const choice: Pick<SdkTabsProps, "value" | "defaultValue" | "onValueChange"> = {};
  if (props.value !== undefined) choice.value = props.value;
  if (props.defaultValue !== undefined) choice.defaultValue = props.defaultValue;
  if (props.onValueChange !== undefined) choice.onValueChange = props.onValueChange;
  return (
    <VariantContext.Provider value={variant}>
      <SdkTabs
        {...choice}
        data-variant={variant}
        className={cn("flex min-w-0 flex-col", props.className)}
      >
        {props.children}
      </SdkTabs>
    </VariantContext.Provider>
  );
}

export function TabsList(props: TabsListProps) {
  const variant = useContext(VariantContext);
  const { className, children, ...name } = props;
  return (
    <div data-slot="tabs-row" data-variant={variant} className={cn(ROW, className)}>
      <SdkTabsList {...name} className={cn(LIST, LIST_PLACE[variant])}>
        {children}
      </SdkTabsList>
    </div>
  );
}

export function Tab(props: TabProps) {
  return (
    <SdkTabsTab
      value={props.value}
      disabled={props.disabled === true}
      className={cn(
        ITEM,
        "not-data-disabled:hover:text-text-primary state-active:text-text-primary",
        "state-active:after:bg-text-primary",
        "data-disabled:cursor-not-allowed data-disabled:text-text-disabled",
        props.className,
      )}
    >
      {props.children}
      <Count count={props.count} />
    </SdkTabsTab>
  );
}

export function TabPanel(props: TabPanelProps) {
  const variant = useContext(VariantContext);
  return (
    <SdkTabsPanel value={props.value} className={cn(PANEL_PLACE[variant], props.className)}>
      {props.children}
    </SdkTabsPanel>
  );
}

export function TabLinks(props: TabLinksProps) {
  const variant = props.variant ?? "page";
  return (
    <nav
      aria-label={props.label}
      data-slot="tab-links"
      data-variant={variant}
      className={cn(ROW, props.className)}
    >
      <LinkContext.Provider value={props.linkAs ?? "a"}>
        <ul className={cn("my-0 list-none py-0", LIST, LIST_PLACE[variant])}>{props.children}</ul>
      </LinkContext.Provider>
    </nav>
  );
}

export function TabLink(props: TabLinkProps) {
  const Link = useContext(LinkContext);
  const current = props.current === true;
  const mark: Pick<TabLinkTargetProps, "aria-current"> = current ? { "aria-current": "page" } : {};
  return (
    <li className="flex shrink-0">
      <Link
        href={props.href}
        {...mark}
        className={cn(
          ITEM,
          current ? "text-text-primary after:bg-text-primary" : "hover:text-text-primary",
          props.className,
        )}
      >
        {props.children}
        <Count count={props.count} />
      </Link>
    </li>
  );
}
