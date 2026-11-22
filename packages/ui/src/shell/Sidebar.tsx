// The sidebar (spec 06 §4.2, [UI-09], [UI-11]; shell-v2 §3): the brand link, the edge toggle right
// after it, the navigation groups, then the pinned footer. Three modes: `expanded` (224px, labels),
// `rail` (64px, icons named by tooltips on the right) and `touch` (the phone sheet: full width, 40px
// items). The current item carries aria-current="page", the selected fill and its icon's fill
// weight (the duo glyph cross-fades); the label's weight never changes. Router-free: links come in
// through `linkAs`.
import { ArrowUpRightIcon, type GlyphName, Icon } from "@fin/icons";
import type { AnchorHTMLAttributes, ComponentType, ReactNode, Ref } from "react";
import { Logo } from "../foundation/logo.tsx";
import { Tooltip } from "../foundation/tooltip.tsx";
import { cn } from "../lib/cn.ts";

export type ShellLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  ref?: Ref<HTMLAnchorElement>;
};
export type ShellLink = ComponentType<ShellLinkProps>;

/** A plain anchor, for documentation and tests; apps pass the router's link. */
export function PlainLink({ ref, ...props }: ShellLinkProps) {
  return <a ref={ref} {...props} />;
}

export interface SidebarItem {
  readonly id: string;
  /** The page title, word for word. */
  readonly label: string;
  readonly href: string;
  /** A glyph with a fill weight: the current item shows it. */
  readonly glyph: GlyphName;
  /** Opens in a new tab and says so (API docs). */
  readonly external: boolean;
}

export interface SidebarGroup {
  readonly id: string;
  readonly label?: string;
  readonly items: readonly SidebarItem[];
}

export interface SidebarNav {
  readonly groups: readonly SidebarGroup[];
  readonly footer: readonly SidebarItem[];
  /** The id of the item the page sits under (the route's navId), or null. */
  readonly currentId: string | null;
}

export interface SidebarBrand {
  /** Home: `/` in the console and in Fin Admin. */
  readonly href: string;
  /** The link's name: "Fin home", or "Fin Admin". */
  readonly label: string;
  /** A line under the lockup on the expanded sidebar and the sheet ("Fin Admin"). */
  readonly caption?: string;
}

export type SidebarMode = "expanded" | "rail" | "touch";

export interface SidebarProps {
  nav: SidebarNav;
  brand: SidebarBrand;
  mode: SidebarMode;
  linkAs: ShellLink;
  /** The `<nav>` element's id, which the edge toggle's aria-controls names. */
  navElementId: string;
  /** The edge toggle, placed right after the brand link (outside the scrolling list). */
  toggle?: ReactNode;
  /** The phone sheet's close button, in the brand row. */
  close?: ReactNode;
  /** Called after an item or the brand is chosen (the phone sheet closes). */
  onNavigate?: () => void;
}

type Navigate = (() => void) | undefined;

function Brand({
  brand,
  mode,
  linkAs: Link,
  onNavigate,
}: Pick<SidebarProps, "brand" | "mode" | "linkAs"> & { onNavigate: Navigate }) {
  const rail = mode === "rail";
  return (
    <Link
      href={brand.href}
      aria-label={brand.label}
      onClick={onNavigate}
      className={cn(
        "flex rounded-control focus-visible:outline-focus",
        rail ? "items-center" : "flex-col items-start gap-1",
      )}
    >
      {rail ? <Logo variant="mark" height={24} /> : <Logo variant="full" height={18} />}
      {!rail && brand.caption !== undefined ? (
        <span className="text-caption font-medium text-text-secondary">{brand.caption}</span>
      ) : null}
    </Link>
  );
}

function Item({
  item,
  current,
  mode,
  linkAs: Link,
  onNavigate,
}: {
  item: SidebarItem;
  current: boolean;
  mode: SidebarMode;
  linkAs: ShellLink;
  onNavigate: Navigate;
}) {
  const external = item.external ? { target: "_blank", rel: "noopener noreferrer" } : {};
  const tone = current
    ? "bg-fill-selected text-text-primary"
    : "text-text-secondary hover:bg-fill-hover hover:text-text-primary";
  const icon = (
    <Icon
      name={item.glyph}
      duo
      current={current}
      className={
        current ? "text-text-primary" : "text-text-tertiary group-hover/item:text-text-primary"
      }
    />
  );

  if (mode === "rail") {
    return (
      <Tooltip
        content={item.external ? `${item.label} (opens in a new tab)` : item.label}
        type="label"
        side="right"
      >
        <Link
          href={item.href}
          {...external}
          {...(current ? { "aria-current": "page" as const } : {})}
          data-nav-item={item.id}
          onClick={onNavigate}
          className={cn(
            "group/item mx-auto flex size-10 items-center justify-center rounded-control transition-colors duration-fast focus-visible:outline-focus",
            tone,
          )}
        >
          {icon}
        </Link>
      </Tooltip>
    );
  }

  return (
    <Link
      href={item.href}
      {...external}
      {...(current ? { "aria-current": "page" as const } : {})}
      data-nav-item={item.id}
      onClick={onNavigate}
      className={cn(
        "group/item flex items-center gap-2 rounded-control px-2 text-body transition-colors duration-fast focus-visible:outline-focus",
        mode === "touch" ? "h-10" : "h-8",
        tone,
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.external ? (
        <>
          <ArrowUpRightIcon className="text-text-tertiary" />
          <span className="sr-only">(opens in a new tab)</span>
        </>
      ) : null}
    </Link>
  );
}

function ItemList({
  items,
  currentId,
  mode,
  linkAs,
  onNavigate,
  labelledBy,
}: {
  items: readonly SidebarItem[];
  currentId: string | null;
  mode: SidebarMode;
  linkAs: ShellLink;
  onNavigate: Navigate;
  labelledBy?: string;
}) {
  return (
    <ul
      className="m-0 flex list-none flex-col gap-0.5 p-0"
      {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
    >
      {items.map((item) => (
        <li key={item.id}>
          <Item
            item={item}
            current={item.id === currentId}
            mode={mode}
            linkAs={linkAs}
            onNavigate={onNavigate}
          />
        </li>
      ))}
    </ul>
  );
}

export function Sidebar({
  nav,
  brand,
  mode,
  linkAs,
  navElementId,
  toggle,
  close,
  onNavigate,
}: SidebarProps) {
  const rail = mode === "rail";
  return (
    <div
      data-sidebar-mode={mode}
      className={cn(
        "flex h-full flex-col bg-surface",
        // The right border is inside the sidebar's width, so its edge is where the toggle sits.
        mode === "expanded" && "w-sidebar border-r border-border",
        rail && "w-sidebar-collapsed border-r border-border",
        mode === "touch" && "w-full",
      )}
    >
      <div
        className={cn(
          "flex h-header shrink-0 items-center",
          rail ? "justify-center" : "justify-between gap-2 px-4",
        )}
      >
        <Brand brand={brand} mode={mode} linkAs={linkAs} onNavigate={onNavigate} />
        {close}
      </div>
      {toggle}
      <nav
        id={navElementId}
        aria-label="Main"
        className={cn("min-h-0 flex-1 overflow-y-auto", rail ? "px-3" : "px-2")}
      >
        {nav.groups.map((group, index) => {
          const headingId = group.label === undefined ? undefined : `${navElementId}-${group.id}`;
          return (
            <div key={group.id} className={index === 0 ? undefined : rail ? "mt-2" : "mt-4"}>
              {index > 0 && rail ? (
                <div aria-hidden="true" className="mx-auto mb-2 h-px w-6 bg-border" />
              ) : null}
              {headingId === undefined ? null : (
                <p
                  id={headingId}
                  className={cn(
                    "m-0",
                    rail ? "sr-only" : "px-2 pb-1 text-caption font-medium text-text-tertiary",
                  )}
                >
                  {group.label}
                </p>
              )}
              <ItemList
                items={group.items}
                currentId={nav.currentId}
                mode={mode}
                linkAs={linkAs}
                onNavigate={onNavigate}
                {...(headingId === undefined ? {} : { labelledBy: headingId })}
              />
            </div>
          );
        })}
      </nav>
      <div className={cn("shrink-0 border-t border-border py-3", rail ? "px-3" : "px-2")}>
        {nav.footer.length > 0 ? (
          <ItemList
            items={nav.footer}
            currentId={nav.currentId}
            mode={mode}
            linkAs={linkAs}
            onNavigate={onNavigate}
          />
        ) : null}
      </div>
    </div>
  );
}
