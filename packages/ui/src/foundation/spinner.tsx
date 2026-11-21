// Spinner (spec 06 §3.3): an SVG ring turning once every 600ms; it keeps turning under reduced
// motion, as the design system's spinners do. Decorative: the busy control says it is busy.
import { cn } from "../lib/cn.ts";

export type SpinnerProps = { size?: 12 | 16 | 20 | 24; className?: string };

export function Spinner(props: SpinnerProps) {
  const size = props.size ?? 16;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-slot="spinner"
      className={cn("shrink-0 animate-spin-fin", props.className)}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path
        d="M8 1.75A6.25 6.25 0 0 1 14.25 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
