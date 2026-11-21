// EmptyState and DocsLink (spec 06 §3.3; the export's EmptyState spec). A zero state shows only
// after a request succeeded with nothing in it: an icon tile, the outcome as a title (no full stop),
// one line of description, and the next action. Five variants, as the export defines them.
import {
  ArrowUpRightIcon,
  KeyIcon,
  LockSimpleIcon,
  MagnifyingGlassIcon,
  TrayIcon,
  XIcon,
} from "@fin/icons";
import type { ReactNode } from "react";
import { Button } from "../foundation/button.tsx";
import { cn } from "../lib/cn.ts";

/** A quiet link that opens the docs in a new tab, and says so. */
export function DocsLink(props: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1 rounded-xs text-label text-text-secondary underline decoration-border-strong underline-offset-4",
        "hover:text-text-primary hover:decoration-text-primary focus-visible:outline-focus",
        props.className,
      )}
    >
      {props.children}
      <ArrowUpRightIcon size={12} />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export type EmptyStateVariant =
  | "first-use"
  | "no-results"
  | "not-configured"
  | "no-permission"
  | "section";

export type EmptyStateFilter = { id: string; label: string; onRemove: () => void };

export type EmptyStateProps = {
  variant: EmptyStateVariant;
  /** The outcome, sentence case, no full stop: "No transactions yet". */
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  docs?: { label: string; href: string };
  /** no-results only: the active filters, each removable. */
  filters?: readonly EmptyStateFilter[];
  /** no-results only: clears every filter; a no-results state is never a dead end. */
  onClearFilters?: () => void;
  className?: string;
};

const ICONS: Record<Exclude<EmptyStateVariant, "section">, ReactNode> = {
  "first-use": <TrayIcon />,
  "no-results": <MagnifyingGlassIcon />,
  "not-configured": <KeyIcon />,
  "no-permission": <LockSimpleIcon />,
};

export function EmptyState(props: EmptyStateProps) {
  if (props.variant === "section") {
    return (
      <div
        data-slot="empty-state"
        data-variant="section"
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed border-border-strong px-4 py-3",
          props.className,
        )}
      >
        <p className="m-0 text-body text-text-tertiary">{props.title}</p>
        {props.action}
      </div>
    );
  }
  return (
    <div
      data-slot="empty-state"
      data-variant={props.variant}
      className={cn("flex flex-col items-center gap-4 px-6 py-16 text-center", props.className)}
    >
      <span
        aria-hidden="true"
        className="grid size-10 place-items-center rounded-md bg-surface-subtle text-text-secondary"
      >
        {props.icon ?? ICONS[props.variant]}
      </span>
      <div className="flex max-w-form flex-col gap-1">
        <h2 className="m-0 text-label text-text-primary">{props.title}</h2>
        {props.description === undefined ? null : (
          <p className="m-0 text-body text-text-secondary">{props.description}</p>
        )}
      </div>
      {props.variant === "no-results" && props.filters !== undefined && props.filters.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap justify-center gap-2 p-0">
          {props.filters.map((filter) => (
            <li key={filter.id}>
              <button
                type="button"
                onClick={filter.onRemove}
                aria-label={`Remove filter: ${filter.label}`}
                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-control bg-fill-selected px-3 text-label-sm text-text-secondary hover:text-text-primary focus-visible:outline-focus"
              >
                {filter.label}
                <XIcon size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {props.action === undefined &&
      props.docs === undefined &&
      !(props.variant === "no-results" && props.onClearFilters !== undefined) ? null : (
        <div className="flex flex-wrap items-center justify-center gap-4">
          {props.variant === "no-results" && props.onClearFilters !== undefined ? (
            <Button variant="secondary" size="sm" onClick={props.onClearFilters}>
              Clear filters
            </Button>
          ) : null}
          {props.action}
          {props.docs === undefined ? null : (
            <DocsLink href={props.docs.href}>{props.docs.label}</DocsLink>
          )}
        </div>
      )}
    </div>
  );
}
