// ErrorState (spec 06 §3.3; the export's ErrorState spec): "Couldn't load {things}" with Try again
// and the API's request ID, which support needs. The page header, tabs and toolbar stay drawn
// around it; it replaces only what failed to load.
import { WarningCircleIcon } from "@fin/icons";
import type { ReactNode } from "react";
import { Button } from "../foundation/button.tsx";
import { CopyField } from "../foundation/copy-field.tsx";
import { cn } from "../lib/cn.ts";

export type ErrorStateProps = {
  size?: "section" | "page" | "inline";
  /** Outcome first, no full stop: "Couldn't load transactions". */
  title: string;
  /** What happened, if the API said, and what to do. Defaults to the connection sentence. */
  description?: ReactNode;
  onRetry?: () => unknown;
  retrying?: boolean;
  requestId?: string;
  action?: ReactNode;
  /** Page only: the heading level when the page header above already has the h1. */
  headingLevel?: 1 | 2 | 3;
  className?: string;
};

export const CONNECTION_SENTENCE = "Check your connection and try again.";

export function ErrorState(props: ErrorStateProps) {
  const size = props.size ?? "section";
  const description = props.description ?? CONNECTION_SENTENCE;
  const retry =
    props.onRetry === undefined ? null : (
      <Button
        variant="secondary"
        size="sm"
        loading={props.retrying === true}
        onClick={() => props.onRetry?.()}
      >
        Try again
      </Button>
    );
  if (size === "inline") {
    return (
      <div
        data-slot="error-state"
        data-size="inline"
        role="alert"
        className={cn(
          "flex flex-wrap items-center gap-2 text-body text-text-secondary",
          props.className,
        )}
      >
        <WarningCircleIcon className="shrink-0 text-status-danger-fg" />
        <span className="text-text-primary">{props.title}</span>
        <span>{description}</span>
        {retry}
      </div>
    );
  }
  const Heading = size === "page" ? (`h${props.headingLevel ?? 1}` as "h1" | "h2" | "h3") : "h2";
  return (
    <div
      data-slot="error-state"
      data-size={size}
      className={cn(
        "flex flex-col items-center gap-4 text-center",
        size === "page" ? "px-6 py-24" : "px-6 py-12",
        props.className,
      )}
    >
      <span
        aria-hidden="true"
        className="grid size-10 place-items-center rounded-md bg-status-danger-bg text-status-danger-fg"
      >
        <WarningCircleIcon />
      </span>
      <div role="alert" className="flex max-w-form flex-col gap-1">
        <Heading
          className={cn("m-0 text-text-primary", size === "page" ? "text-heading" : "text-label")}
        >
          {props.title}
        </Heading>
        <p className="m-0 text-body text-text-secondary">{description}</p>
      </div>
      {retry === null && props.action === undefined ? null : (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {retry}
          {props.action}
        </div>
      )}
      {props.requestId === undefined ? null : (
        <div className="flex items-center gap-2 text-caption text-text-tertiary">
          <span>Request ID</span>
          <CopyField value={props.requestId} label="Request ID" head={8} tail={4} />
        </div>
      )}
    </div>
  );
}
