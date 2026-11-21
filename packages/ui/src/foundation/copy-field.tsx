// CopyField (spec 06 §3.3; the export's CopyField spec): IDs, keys and addresses are display-only,
// in mono, with a copy button named "Copy {label}". Inline values are middle-truncated with the
// whole value in the tooltip. Copying cross-fades the icon to a check for 2 seconds; a clipboard
// that refuses shows a "blocked" state instead. The secret variant is masked until revealed.
import { CheckIcon, CopyIcon, EyeIcon, EyeSlashIcon } from "@fin/icons";
import { useEffect, useState } from "react";
import { announce } from "../lib/announce.ts";
import { cn } from "../lib/cn.ts";
import { IconButton } from "./button.tsx";
import { Tooltip } from "./tooltip.tsx";

/** `a1b2c3…9f0e`: the head and tail of a long value, joined by an ellipsis. */
export function middleTruncate(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/** "Transaction ID" becomes "transaction ID"; "API key" stays "API key". */
export function lowerFirst(label: string): string {
  const [first = "", ...rest] = label.split(" ");
  const keep = first.length > 1 && first === first.toUpperCase();
  return [keep ? first : first.charAt(0).toLowerCase() + first.slice(1), ...rest].join(" ");
}

type CopyState = "idle" | "copied" | "blocked";

/** Copies `value`, reporting whether the clipboard took it; reverts to idle after 2 seconds. */
export function useCopy(value: string): { state: CopyState; copy: () => Promise<void> } {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
        throw new Error("no clipboard");
      }
      await navigator.clipboard.writeText(value);
      setState("copied");
      announce("Copied");
    } catch {
      setState("blocked");
      announce("Couldn’t copy. Select it and copy it yourself.", "assertive");
    }
  };
  return { state, copy };
}

function CopyButton(props: { value: string; label: string; size?: "xs" | "sm" }) {
  const { state, copy } = useCopy(props.value);
  const tip =
    state === "copied"
      ? "Copied"
      : state === "blocked"
        ? "Couldn’t copy. Select it and copy it yourself."
        : `Copy ${lowerFirst(props.label)}`;
  return (
    <IconButton
      size={props.size ?? "sm"}
      label={`Copy ${lowerFirst(props.label)}`}
      tooltip={tip}
      data-copy-state={state}
      onClick={copy}
      icon={
        <span className="relative inline-flex size-4">
          <CopyIcon
            className={cn(
              "absolute inset-0 animate-copied",
              state === "copied" ? "scale-pop opacity-0" : "opacity-100",
            )}
          />
          <CheckIcon
            className={cn(
              "absolute inset-0 animate-copied text-status-success-fg",
              state === "copied" ? "opacity-100" : "scale-pop opacity-0",
            )}
          />
        </span>
      }
    />
  );
}

export type CopyFieldProps = {
  value: string;
  /** What the value is: "Transaction ID". Names the copy button ("Copy transaction ID"). */
  label: string;
  variant?: "inline" | "block" | "secret";
  /** Characters kept at each end when inline. */
  head?: number;
  tail?: number;
  className?: string;
};

export function CopyField(props: CopyFieldProps) {
  const variant = props.variant ?? "inline";
  const [revealed, setRevealed] = useState(false);
  if (variant === "inline") {
    const shown = middleTruncate(props.value, props.head, props.tail);
    const truncated = shown !== props.value;
    return (
      <span
        data-slot="copy-field"
        data-variant="inline"
        className={cn("inline-flex h-8 items-center gap-1", props.className)}
      >
        <Tooltip content={truncated ? props.value : null} mono type="description">
          {/* The full value is its tooltip, reached by keyboard: a Tab stop only when there is a
              full value to show (a value shown whole has no tooltip, so focusing it does nothing). */}
          <span
            {...(truncated ? { tabIndex: 0 } : {})}
            className="rounded-xs font-mono text-mono text-text-primary"
          >
            {shown}
          </span>
        </Tooltip>
        <CopyButton value={props.value} label={props.label} size="xs" />
      </span>
    );
  }
  const secret = variant === "secret";
  return (
    <div
      data-slot="copy-field"
      data-variant={variant}
      className={cn("flex flex-col gap-2", props.className)}
    >
      <span className="text-label-sm text-text-secondary">{props.label}</span>
      <div className="flex items-start gap-2 rounded-md bg-surface-subtle py-1.5 pr-1.5 pl-3">
        <span
          className={cn(
            "min-w-0 flex-1 py-1 font-mono text-mono break-all text-text-primary",
            secret && !revealed && "select-none",
          )}
        >
          {secret && !revealed ? "•".repeat(Math.min(32, props.value.length)) : props.value}
        </span>
        {secret ? (
          <IconButton
            size="sm"
            label={revealed ? `Hide ${lowerFirst(props.label)}` : `Show ${lowerFirst(props.label)}`}
            icon={revealed ? <EyeSlashIcon /> : <EyeIcon />}
            aria-pressed={revealed}
            onClick={() => setRevealed((r) => !r)}
          />
        ) : null}
        <CopyButton value={props.value} label={props.label} />
      </div>
    </div>
  );
}
