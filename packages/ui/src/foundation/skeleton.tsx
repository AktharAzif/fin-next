// The Skeleton family (spec 06 §5.2; the export's Skeleton spec): content-shaped placeholders,
// never a page spinner. Every shape is aria-hidden and carries data-skeleton, which the motion
// layer's shimmer (fin-shimmer on <body>) sweeps. The region around the shapes is aria-busy and
// says "Loading {label}" once, through announce().
import type { ReactNode } from "react";
import { useAnnounceOnMount } from "../lib/announce.ts";
import { cn } from "../lib/cn.ts";

export type SkeletonShape = "text" | "badge" | "control" | "circle" | "block";

const SHAPES: Record<SkeletonShape, string> = {
  text: "h-3 w-full rounded-sm",
  badge: "h-5 w-16 rounded-badge",
  control: "h-control-md w-30 rounded-control",
  circle: "size-8 rounded-full",
  block: "h-24 w-full rounded-md",
};

export function Skeleton(props: { shape?: SkeletonShape; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-skeleton=""
      data-shape={props.shape ?? "text"}
      className={cn(
        "block shrink-0 bg-fill-selected",
        SHAPES[props.shape ?? "text"],
        props.className,
      )}
    />
  );
}

/** Lines of text: the last one shorter, as a paragraph ends. */
export function SkeletonText(props: { lines?: number; className?: string }) {
  const lines = Math.max(1, props.lines ?? 3);
  return (
    <span aria-hidden="true" className={cn("flex flex-col gap-2 py-1", props.className)}>
      {Array.from({ length: lines }, (_, i) => `line-${i}`).map((key, i) => (
        <Skeleton key={key} className={i === lines - 1 && lines > 1 ? "w-3/5" : "w-full"} />
      ))}
    </span>
  );
}

function LoadingRegion(props: { label: string; className?: string; children: ReactNode }) {
  useAnnounceOnMount(`Loading ${props.label}`);
  return (
    // A group of placeholders, not a form: <fieldset> would say the wrong thing.
    // biome-ignore lint/a11y/useSemanticElements: role group names the busy region
    <div
      aria-busy="true"
      aria-label={`Loading ${props.label}`}
      role="group"
      data-slot="skeleton-region"
      className={props.className}
    >
      {props.children}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex h-row items-center gap-4 border-b border-border px-4">
      <Skeleton className="w-2/5" />
      <Skeleton className="w-1/5" />
      <Skeleton shape="badge" className="ml-auto" />
    </div>
  );
}

/** A section loading in place: a drawer section, a tab panel, a card. */
export function SkeletonSection(props: {
  /** What is loading, for screen readers: "beneficiaries" says "Loading beneficiaries". */
  label: string;
  rows?: number;
  /** Draw the section's heading bar (off when the real heading is on screen). */
  heading?: boolean;
  className?: string;
}) {
  const rows = props.rows ?? 3;
  return (
    <LoadingRegion label={props.label} className={cn("flex flex-col gap-4", props.className)}>
      {props.heading === false ? null : <Skeleton className="h-4 w-40" />}
      <div className="flex flex-col">
        {Array.from({ length: rows }, (_, i) => `row-${i}`).map((key) => (
          <SkeletonRow key={key} />
        ))}
      </div>
    </LoadingRegion>
  );
}

/** A page before its first response: the header, an optional toolbar and list rows. */
export function SkeletonPage(props: {
  label: string;
  toolbar?: boolean;
  rows?: number;
  className?: string;
}) {
  const rows = props.rows ?? 8;
  return (
    <LoadingRegion label={props.label} className={cn("flex flex-col gap-6", props.className)}>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="w-80 max-w-full" />
      </div>
      {props.toolbar === true ? (
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton shape="control" className="w-60 max-w-full" />
          <Skeleton shape="control" className="h-control-sm w-24" />
          <Skeleton shape="control" className="h-control-sm w-24" />
        </div>
      ) : null}
      <div className="flex flex-col">
        {Array.from({ length: rows }, (_, i) => `row-${i}`).map((key) => (
          <SkeletonRow key={key} />
        ))}
      </div>
    </LoadingRegion>
  );
}
