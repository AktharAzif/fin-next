// Logo (spec 06 §3.3): the Fin.com lockup (expanded sidebar, signed-out pages) or the F mark (the
// rail at 24px, UR-04; the phone header at 18px), in text-primary. Usually inside a link that names
// it ("Fin home"), so it is decorative unless given a label. Reserved artwork: see @fin/icons'
// NOTICE.md and the LICENSE.
import { FinLockup, FinMark } from "@fin/icons";
import { cn } from "../lib/cn.ts";

export type LogoProps = {
  variant?: "full" | "mark";
  /** Height in px; the width follows the artwork. 18 for full and 24 for the mark; never below 16. */
  height?: number;
  label?: string;
  className?: string;
};

export function Logo(props: LogoProps) {
  const variant = props.variant ?? "full";
  const height = Math.max(16, props.height ?? (variant === "full" ? 18 : 24));
  const shared = {
    height,
    className: cn("shrink-0 text-text-primary", props.className),
    ...(props.label === undefined ? {} : { label: props.label }),
  };
  return variant === "full" ? <FinLockup {...shared} /> : <FinMark {...shared} />;
}
