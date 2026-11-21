// InlineAlert (spec 06 §3.3; the export's InlineAlert spec): a message in the page, in a status
// tone, with at most one action. It is spoken only when it appears after an action (`live`).
import {
  CheckCircleIcon,
  InfoIcon,
  LightbulbIcon,
  WarningCircleIcon,
  WarningIcon,
  XIcon,
} from "@fin/icons";
import type { ReactNode } from "react";
import { useAnnounceOnMount } from "../lib/announce.ts";
import { cn } from "../lib/cn.ts";
import { IconButton } from "./button.tsx";

export type InlineAlertTone = "info" | "success" | "warning" | "danger" | "highlight";

export type InlineAlertProps = {
  tone: InlineAlertTone;
  /** One line, outcome first: "Couldn't load this transaction". */
  title: string;
  /** What to do next, in a sentence or two. */
  children?: ReactNode;
  /** One action, usually a small secondary Button. */
  action?: ReactNode;
  /** Makes it dismissible; never for one that blocks the task. */
  onDismiss?: () => void;
  /** Announce it when it appears: assertive for errors after an action, polite for results. */
  live?: "polite" | "assertive";
  className?: string;
};

const TONES: Record<InlineAlertTone, { box: string; icon: ReactNode }> = {
  info: {
    box: "bg-status-info-bg",
    icon: <InfoIcon className="shrink-0 text-status-info-fg" />,
  },
  success: {
    box: "bg-status-success-bg",
    icon: <CheckCircleIcon className="shrink-0 text-status-success-fg" />,
  },
  warning: {
    box: "bg-status-warning-bg",
    icon: <WarningIcon className="shrink-0 text-status-warning-fg" />,
  },
  danger: {
    box: "bg-status-danger-bg",
    icon: <WarningCircleIcon className="shrink-0 text-status-danger-fg" />,
  },
  highlight: {
    box: "bg-surface-subtle",
    icon: <LightbulbIcon className="shrink-0 text-text-primary" />,
  },
};

function plain(node: ReactNode): string {
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

export function InlineAlert(props: InlineAlertProps) {
  const tone = TONES[props.tone];
  const spoken = props.live === undefined ? null : `${props.title} ${plain(props.children)}`.trim();
  useAnnounceOnMount(spoken, props.live ?? "polite");
  return (
    <div
      data-slot="inline-alert"
      data-tone={props.tone}
      className={cn("flex items-start gap-3 rounded-md px-4 py-3", tone.box, props.className)}
    >
      <span className="flex h-5 items-center">{tone.icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="m-0 text-label text-text-primary">{props.title}</p>
        {props.children === undefined ? null : (
          <div className="text-body text-text-secondary">{props.children}</div>
        )}
        {props.action === undefined ? null : <div className="mt-2 flex gap-2">{props.action}</div>}
      </div>
      {props.onDismiss === undefined ? null : (
        <IconButton
          size="xs"
          label="Dismiss"
          icon={<XIcon size={12} />}
          tooltip={false}
          onClick={props.onDismiss}
          className="-mr-1"
        />
      )}
    </div>
  );
}
