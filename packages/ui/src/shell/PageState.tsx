// The frame's own page states, drawn inside the shell (AppFrame `notFound`, `notAllowed`, `error`,
// `offline`, `frameLoading`; AdminFrame `notFound`, `pageError`, `loading`): a page heading with its
// primary action, a centred problem with an icon tile, and the loading shapes.
//
// A pending composition ([UI-03]) on design-system primitives and tokens while @fin/ui's PageHeader,
// EmptyState, ErrorState, Button and Skeleton are built in parallel (P0-G sessions G1 and G2): once
// they merge, these render those components with the same copy, and the frames do not change.
import type { ReactNode } from "react";
import { classes } from "./classes.ts";
import { Glyph } from "./Glyph.tsx";
import type { ShellGlyphName } from "./glyph-data.ts";
import type { ShellLink } from "./Sidebar.tsx";

const BUTTON =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control px-3 text-label outline-none transition-press focus-visible:outline-focus active:scale-press";
export const PRIMARY_BUTTON = `${BUTTON} bg-action-primary text-on-action-primary hover:bg-action-primary-hover`;
export const SECONDARY_BUTTON = `${BUTTON} border border-transparent bg-surface-raised text-text-primary shadow-button hover:shadow-button-hover`;

export interface PageAction {
  label: string;
  glyph?: ShellGlyphName;
  /** A link (Go to Home), or a press (Try again). */
  href?: string;
  onPress?: () => void;
}

function Action({
  action,
  primary,
  linkAs: Link,
}: {
  action: PageAction;
  primary: boolean;
  linkAs: ShellLink;
}) {
  const className = primary ? PRIMARY_BUTTON : SECONDARY_BUTTON;
  const content = (
    <>
      {action.glyph === undefined ? null : <Glyph name={action.glyph} />}
      {action.label}
    </>
  );
  if (action.href !== undefined) {
    return (
      <Link href={action.href} className={className}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={action.onPress} className={className}>
      {content}
    </button>
  );
}

/** The page's one `<h1>`, focusable so focus can move to it after a navigation (S6-17). */
export function PageHeading({
  title,
  description,
  primary,
  linkAs,
}: {
  title: string;
  description?: string;
  primary?: PageAction;
  linkAs: ShellLink;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 tabIndex={-1} className="text-title text-text-primary outline-none">
          {title}
        </h1>
        {description === undefined ? null : (
          <p className="text-body text-text-secondary">{description}</p>
        )}
      </div>
      {primary === undefined ? null : <Action action={primary} primary linkAs={linkAs} />}
    </div>
  );
}

/** A centred problem: an icon tile, a title, one line, and up to two actions. */
export function PageProblem({
  glyph,
  tone = "neutral",
  title,
  description,
  actions = [],
  requestId,
  linkAs,
}: {
  glyph: ShellGlyphName;
  tone?: "neutral" | "danger";
  title: string;
  description: string;
  actions?: readonly PageAction[];
  /** Shown so a person can quote it to Fin. */
  requestId?: string | null;
  linkAs: ShellLink;
}) {
  return (
    <section
      aria-labelledby="page-problem-title"
      className="flex flex-col items-center px-4 pt-16 pb-16 text-center"
    >
      <span
        aria-hidden="true"
        className={classes(
          "mb-4 inline-flex size-10 items-center justify-center rounded-md border border-transparent bg-surface-raised shadow-ring",
          tone === "danger" ? "text-status-danger-fg" : "text-text-secondary",
        )}
      >
        <Glyph name={glyph} />
      </span>
      <h1
        id="page-problem-title"
        tabIndex={-1}
        className="text-heading text-text-primary outline-none"
      >
        {title}
      </h1>
      <p className="mt-1 max-w-sm text-body text-text-secondary">{description}</p>
      {actions.length > 0 ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {actions.map((action) => (
            <Action key={action.label} action={action} primary={false} linkAs={linkAs} />
          ))}
        </div>
      ) : null}
      {requestId === undefined || requestId === null ? null : (
        <p className="mt-4 font-mono text-mono text-text-tertiary">Request ID {requestId}</p>
      )}
    </section>
  );
}

/** The loading shapes before a page's first answer: never a spinner (spec 06 §5.2). */
export function PageSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-3 pt-1">
      <p role="status" className="sr-only">
        {label}
      </p>
      <div aria-hidden="true" data-skeleton="" className="h-6 w-48 rounded-sm bg-fill-selected" />
      <div
        aria-hidden="true"
        data-skeleton=""
        className="h-2 w-80 max-w-full rounded-sm bg-fill-selected"
      />
    </div>
  );
}

/**
 * A notice across the top of the content (AppFrame `logOutFailed`, the release notice): a title,
 * one sentence and at most one action. Spoken when it appears after an action (`live`).
 */
export function PageNotice({
  tone,
  title,
  children,
  action,
  live = "polite",
}: {
  tone: "info" | "danger";
  title: string;
  children?: ReactNode;
  action?: { label: string; onPress: () => void };
  live?: "polite" | "assertive";
}) {
  return (
    <div
      role={live === "assertive" ? "alert" : "status"}
      data-notice={tone}
      className={classes(
        "flex items-start gap-3 rounded-md border border-transparent px-4 py-3",
        tone === "danger" ? "bg-status-danger-bg" : "bg-status-info-bg",
      )}
    >
      <span
        className={classes(
          "mt-0.5 flex",
          tone === "danger" ? "text-status-danger-fg" : "text-status-info-fg",
        )}
      >
        <Glyph name={tone === "danger" ? "WarningCircle" : "ArrowClockwise"} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-label text-text-primary">{title}</p>
        {children === undefined ? null : (
          <p className="text-body text-text-secondary">{children}</p>
        )}
      </div>
      {action === undefined ? null : (
        <button type="button" onClick={action.onPress} className={SECONDARY_BUTTON}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/** A plain wrapper so a frame can put its states and its page in one column, 24px apart. */
export function PageColumn({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-6">{children}</div>;
}
