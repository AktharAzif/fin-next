// Avatar (spec 06 §3.3; the export's Avatar spec): initials from the name, else the first letter of
// the email (the canvases' noName states). People are circles, businesses rounded squares. It is
// decorative: the control or the text beside it names the person.
import { FlagArt, isFlagCode } from "@fin/icons";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export type AvatarSize = 20 | 24 | 32 | 40;

/** Two initials from a name ("Maya Rivera" is MR), one from an email ("m" is M). */
export function initials(name: string | null | undefined, email?: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const first = words[0]?.[0] ?? "";
    const last = words.length > 1 ? (words.at(-1)?.[0] ?? "") : "";
    return (first + last).toLocaleUpperCase("en-GB");
  }
  const letter = (email ?? "").trim()[0];
  return letter === undefined ? "" : letter.toLocaleUpperCase("en-GB");
}

const SIZES: Record<AvatarSize, { box: string; badge: number }> = {
  20: { box: "size-5 text-caption", badge: 10 },
  24: { box: "size-6 text-caption", badge: 12 },
  32: { box: "size-8 text-caption", badge: 12 },
  40: { box: "size-10 text-label", badge: 16 },
};

export type AvatarProps = {
  /** The full name; the initials come from it. Empty when the person has no name yet. */
  name: string;
  /** Used when there is no name: its first letter. */
  email?: string;
  kind?: "individual" | "business";
  size?: AvatarSize;
  /** A small visual on the lower right, usually a flag. */
  badge?: ReactNode;
  /** An ISO country code for a flag badge; `badge` wins when both are set. */
  country?: string;
  className?: string;
};

export function Avatar(props: AvatarProps) {
  const size = SIZES[props.size ?? 32];
  const country = props.country?.toUpperCase();
  const badge =
    props.badge ??
    (country !== undefined && isFlagCode(country) ? (
      <FlagArt code={country} size={size.badge} />
    ) : null);
  return (
    <span
      aria-hidden="true"
      data-slot="avatar"
      className={cn("relative inline-flex shrink-0", props.className)}
    >
      <span
        className={cn(
          "inline-flex items-center justify-center bg-surface-subtle font-medium text-text-secondary",
          props.kind === "business" ? "rounded-sm" : "rounded-full",
          size.box,
        )}
      >
        {initials(props.name, props.email)}
      </span>
      {badge === null ? null : (
        <span className="absolute -right-0.5 -bottom-0.5 inline-flex rounded-full ring-2 ring-bg">
          {badge}
        </span>
      )}
    </span>
  );
}
