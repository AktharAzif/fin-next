// Badge and StatusBadge (spec 06 §3.3; the export's Badge and StatusBadge specs). A badge always
// carries words: never meaning by colour alone. Status reaches the screen only through
// StatusBadge, with the tone from the status vocabulary's map, never picked by hand.
import { cn } from "../lib/cn.ts";

export type BadgeHue =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "pink"
  | "orange"
  | "cyan"
  | "indigo"
  | "violet"
  | "rose"
  | "amber"
  | "lime"
  | "emerald"
  | "sky"
  | "fuchsia";

// Written out in full so Tailwind sees every class.
const HUES: Record<BadgeHue, string> = {
  red: "bg-badge-red-bg text-badge-red-fg",
  blue: "bg-badge-blue-bg text-badge-blue-fg",
  green: "bg-badge-green-bg text-badge-green-fg",
  yellow: "bg-badge-yellow-bg text-badge-yellow-fg",
  purple: "bg-badge-purple-bg text-badge-purple-fg",
  pink: "bg-badge-pink-bg text-badge-pink-fg",
  orange: "bg-badge-orange-bg text-badge-orange-fg",
  cyan: "bg-badge-cyan-bg text-badge-cyan-fg",
  indigo: "bg-badge-indigo-bg text-badge-indigo-fg",
  violet: "bg-badge-violet-bg text-badge-violet-fg",
  rose: "bg-badge-rose-bg text-badge-rose-fg",
  amber: "bg-badge-amber-bg text-badge-amber-fg",
  lime: "bg-badge-lime-bg text-badge-lime-fg",
  emerald: "bg-badge-emerald-bg text-badge-emerald-fg",
  sky: "bg-badge-sky-bg text-badge-sky-fg",
  fuchsia: "bg-badge-fuchsia-bg text-badge-fuchsia-fg",
};

export const badgeHues = Object.keys(HUES) as BadgeHue[];

const VARIANTS = {
  default: "bg-action-primary text-on-action-primary",
  secondary: "bg-surface-subtle text-text-secondary",
  outline: "border border-border-strong text-text-secondary",
  destructive: "bg-danger-solid text-on-danger-solid",
} as const;

const BASE =
  "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-badge text-caption font-medium";

export type BadgeProps = {
  /** The label, in words. */
  children: string;
  /** Defaults to outline: a fact about the view ("Sample data", "Sandbox"). */
  variant?: keyof typeof VARIANTS;
  /** One of the 16 category colours, for a rail or product tag. Never a status. */
  color?: BadgeHue;
  size?: "sm" | "md";
  className?: string;
};

export function Badge(props: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(
        BASE,
        props.size === "sm" ? "px-1" : "px-1.5",
        props.color === undefined ? VARIANTS[props.variant ?? "outline"] : HUES[props.color],
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

export type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";

const TONES: Record<StatusTone, { badge: string; dot: string }> = {
  success: { badge: "bg-status-success-bg text-status-success-fg", dot: "bg-status-success-fg" },
  info: { badge: "bg-status-info-bg text-status-info-fg", dot: "bg-status-info-fg" },
  warning: { badge: "bg-status-warning-bg text-status-warning-fg", dot: "bg-status-warning-fg" },
  danger: { badge: "bg-status-danger-bg text-status-danger-fg", dot: "bg-status-danger-fg" },
  neutral: { badge: "bg-status-neutral-bg text-status-neutral-fg", dot: "bg-status-neutral-fg" },
};

export type StatusBadgeProps = {
  tone: StatusTone;
  /** The human label from the status map, never the raw API value. */
  children: string;
  /** badge in tables and detail headers; dot in dense lists and running text. */
  presentation?: "badge" | "dot";
  size?: "sm" | "md";
  className?: string;
};

export function StatusBadge(props: StatusBadgeProps) {
  const tone = TONES[props.tone];
  if (props.presentation === "dot") {
    return (
      <span
        data-slot="status-badge"
        data-tone={props.tone}
        className={cn(
          "inline-flex items-center gap-1.5 text-body text-text-primary",
          props.className,
        )}
      >
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
        {props.children}
      </span>
    );
  }
  return (
    <span
      data-slot="status-badge"
      data-tone={props.tone}
      className={cn(BASE, props.size === "sm" ? "px-1" : "px-1.5", tone.badge, props.className)}
    >
      {props.children}
    </span>
  );
}
