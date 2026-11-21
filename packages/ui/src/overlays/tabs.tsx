// Tabs and TabLinks (spec 06 §3.3; the export's Tabs spec). Tabs switch panels in place on the
// SDK's tabs (arrow keys, Home and End). TabLinks are router links (Settings, a customer's tabs):
// the current one carries aria-current="page". Counts only for waiting work ("To settle 3").
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

type Variant = "page" | "drawer";
const VariantContext = createContext<Variant>("page");

const LIST: Record<Variant, string> = {
  page: "flex gap-6 overflow-x-auto border-b border-border",
  drawer: "flex gap-4 overflow-x-auto border-b border-border px-6",
};

const TAB = cn(
  "relative inline-flex h-10 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap bg-transparent px-0",
  "text-label text-text-secondary transition-fade focus-visible:outline-focus-inset",
  "hover:text-text-primary data-disabled:cursor-not-allowed data-disabled:text-text-disabled",
  "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-transparent",
);
const TAB_CURRENT = "text-text-primary after:bg-text-primary";

function Count(props: { count?: number }) {
  if (props.count === undefined || props.count <= 0) return null;
  return <span className="text-label text-text-tertiary">{props.count}</span>;
}

type SdkTabsProps = ComponentProps<typeof SdkTabs>;

export type TabsProps = Omit<SdkTabsProps, "className" | "children"> & {
  variant?: Variant;
  className?: string;
  children: ReactNode;
};

export function Tabs(props: TabsProps) {
  const { variant = "page", className, children, ...rest } = props;
  return (
    <VariantContext.Provider value={variant}>
      <SdkTabs {...rest} className={cn("flex flex-col", className)}>
        {children}
      </SdkTabs>
    </VariantContext.Provider>
  );
}

export function TabsList(props: {
  "aria-label"?: string;
  className?: string;
  children: ReactNode;
}) {
  const variant = useContext(VariantContext);
  return (
    <SdkTabsList
      {...(props["aria-label"] === undefined ? {} : { "aria-label": props["aria-label"] })}
      className={cn(LIST[variant], props.className)}
    >
      {props.children}
    </SdkTabsList>
  );
}

export function Tab(props: {
  value: string;
  disabled?: boolean;
  /** Waiting work only; zero shows nothing. */
  count?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <SdkTabsTab
      value={props.value}
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      className={cn(
        TAB,
        "state-active:text-text-primary state-active:after:bg-text-primary",
        props.className,
      )}
    >
      {props.children}
      <Count {...(props.count === undefined ? {} : { count: props.count })} />
    </SdkTabsTab>
  );
}

export function TabPanel(props: { value: string; className?: string; children: ReactNode }) {
  return (
    <SdkTabsPanel
      value={props.value}
      className={cn("pt-6 focus-visible:outline-focus", props.className)}
    >
      {props.children}
    </SdkTabsPanel>
  );
}

type LinkComponent = ElementType<{
  href: string;
  className?: string;
  "aria-current"?: "page";
  children?: ReactNode;
}>;

const LinkAs = createContext<LinkComponent>("a");

/** Tabs that are links: one per route, the current one marked. */
export function TabLinks(props: {
  /** Names the navigation: "Settings". */
  label: string;
  /** The app's router link; a plain <a> by default. */
  linkAs?: LinkComponent;
  variant?: Variant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <LinkAs.Provider value={props.linkAs ?? "a"}>
      <nav aria-label={props.label} className={props.className}>
        <ul className={cn(LIST[props.variant ?? "page"], "m-0 list-none p-0")}>{props.children}</ul>
      </nav>
    </LinkAs.Provider>
  );
}

export function TabLink(props: {
  href: string;
  current?: boolean;
  count?: number;
  className?: string;
  children: ReactNode;
}) {
  const Link = useContext(LinkAs);
  return (
    <li className="flex">
      <Link
        href={props.href}
        {...(props.current === true ? { "aria-current": "page" as const } : {})}
        className={cn(TAB, "no-underline", props.current === true && TAB_CURRENT, props.className)}
      >
        {props.children}
        <Count {...(props.count === undefined ? {} : { count: props.count })} />
      </Link>
    </li>
  );
}
