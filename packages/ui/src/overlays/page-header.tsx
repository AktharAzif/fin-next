// PageHeader (spec 06 §3.3; the export's PageHeader spec): one <h1 tabIndex={-1}> that takes focus
// on a new page (S6-17), its title equal to the sidebar label; breadcrumbs through `linkAs`; `meta`
// takes a status badge, never a count; the one primary action sits last, on the right.
import type { ElementType, ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export type Breadcrumb = { label: string; href: string };

export type PageHeaderProps = {
  title: string;
  description?: ReactNode;
  /** Ancestors only, outermost first, when the page is more than one level deep. */
  breadcrumbs?: readonly Breadcrumb[];
  /** A status badge beside the title. */
  meta?: ReactNode;
  /** Secondary buttons, an overflow menu. Never a second primary. */
  actions?: ReactNode;
  /** The page's single primary Button. */
  primaryAction?: ReactElement;
  /** Page-level tabs, under the header. */
  tabs?: ReactNode;
  /** The app's router link for breadcrumbs; a plain <a> by default. */
  linkAs?: ElementType<{ href: string; className?: string; children?: ReactNode }>;
  className?: string;
};

export function PageHeader(props: PageHeaderProps) {
  const Link = props.linkAs ?? "a";
  return (
    <header data-slot="page-header" className={cn("flex flex-col gap-6", props.className)}>
      <div className="flex flex-col gap-2">
        {props.breadcrumbs === undefined || props.breadcrumbs.length === 0 ? null : (
          <nav aria-label="Breadcrumb">
            <ol className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0 text-body text-text-tertiary">
              {props.breadcrumbs.map((crumb) => (
                <li key={crumb.href} className="flex items-center gap-1.5">
                  <Link
                    href={crumb.href}
                    className="rounded-xs text-text-secondary no-underline hover:text-text-primary focus-visible:outline-focus"
                  >
                    {crumb.label}
                  </Link>
                  <span aria-hidden="true">/</span>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 tabIndex={-1} className="m-0 text-title text-text-primary outline-none">
                {props.title}
              </h1>
              {props.meta}
            </div>
            {props.description === undefined ? null : (
              <p className="m-0 text-body text-text-secondary">{props.description}</p>
            )}
          </div>
          {props.actions === undefined && props.primaryAction === undefined ? null : (
            <div className="flex shrink-0 items-center gap-2">
              {props.actions}
              {props.primaryAction}
            </div>
          )}
        </div>
      </div>
      {props.tabs}
    </header>
  );
}
