// Toaster and toast() (spec 06 §3.3; the export's Toast spec) on the SDK's toast.
// - At most 3 visible. A fourth evicts the oldest, the oldest non-error first: never a queue.
// - Errors stay until dismissed; the rest leave after 5 seconds (paused while hovered or focused).
// - The tone shows as the icon only; at most one action (Undo, Retry or View), with altText.
// - 480px, bottom centre, 24px up; F8 moves focus to the newest toast and back; no swipe.

import { CheckCircleIcon, InfoIcon, WarningCircleIcon, XIcon } from "@fin/icons";
import { createToaster, Toast, ToastAction, ToastClose, ToastRegion } from "@ui-sdk/react/toast";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export type ToastTone = "success" | "error" | "info";

export type ToastMessage = {
  title: string;
  description?: string;
  /** One action: Undo, Retry or View. `altText` says how to do it without the toast. */
  action?: { label: string; altText: string; onAction: () => unknown };
};

type Queue = ReturnType<typeof createToaster<ReactNode>>;

const MAX_VISIBLE = 3;
let queue: Queue | undefined;

/** The one queue, made on first use (nothing runs at module scope). */
function getQueue(): Queue {
  queue ??= createToaster<ReactNode>({ duration: 5000 });
  return queue;
}

function evictForRoom(q: Queue): void {
  const live = [...q.toasts()].sort((a, b) => a.order - b.order);
  if (live.length < MAX_VISIBLE) return;
  const victim = live.find((t) => t.type !== "error") ?? live[0];
  if (victim !== undefined) q.dismiss(victim.id);
}

function show(tone: ToastTone | "default", input: string | ToastMessage): string {
  const q = getQueue();
  evictForRoom(q);
  const message = typeof input === "string" ? { title: input } : input;
  const sdkType = tone === "default" ? "default" : tone;
  return q({
    title: message.title,
    type: sdkType,
    ...(message.description === undefined ? {} : { description: message.description }),
    ...(tone === "error" ? { duration: Number.POSITIVE_INFINITY } : {}),
    ...(message.action === undefined
      ? {}
      : {
          action: { label: message.action.label, onAction: message.action.onAction },
          data: { altText: message.action.altText },
        }),
    // No swipe: a swipe that would dismiss snaps back.
    onDismiss: (details) => {
      if (details.reason === "swipe") details.cancel();
    },
  });
}

type ToastFn = ((input: string | ToastMessage) => string) & {
  success: (input: string | ToastMessage) => string;
  error: (input: string | ToastMessage) => string;
  info: (input: string | ToastMessage) => string;
  dismiss: (id?: string) => void;
  /** How many toasts are showing, for tests. */
  count: () => number;
};

/** Shows a toast whose title is the outcome: "Webhook created", "Couldn't create webhook". */
export const toast: ToastFn = Object.assign(
  (input: string | ToastMessage) => show("default", input),
  {
    success: (input: string | ToastMessage) => show("success", input),
    error: (input: string | ToastMessage) => show("error", input),
    info: (input: string | ToastMessage) => show("info", input),
    dismiss: (id?: string) => getQueue().dismiss(id),
    count: () => getQueue().toasts().length,
  },
);

const TONE_ICON: Record<string, ReactNode> = {
  success: <CheckCircleIcon className="mt-0.5 shrink-0 text-status-success-fg" />,
  error: <WarningCircleIcon className="mt-0.5 shrink-0 text-status-danger-fg" />,
  info: <InfoIcon className="mt-0.5 shrink-0 text-status-info-fg" />,
};

/** The one toast region. Mount once, near the root, inside the app's providers. */
export function Toaster() {
  return (
    <ToastRegion
      toaster={getQueue()}
      side="bottom"
      align="center"
      maxVisible={MAX_VISIBLE}
      shortcut="F8"
      aria-label="Notifications"
      className="fin-toast-region"
    >
      {(item) => {
        const altText = (item.data as { altText?: string } | undefined)?.altText;
        return (
          <Toast
            className={cn(
              "fin-toast flex select-none items-start gap-3 rounded-md bg-surface-raised px-4 py-3 text-text-primary shadow-popover",
            )}
          >
            {TONE_ICON[item.type] ?? null}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="text-label">{item.title}</div>
              {item.description === undefined ? null : (
                <div className="text-body text-text-secondary">{item.description}</div>
              )}
            </div>
            {item.action === undefined ? null : (
              <ToastAction
                {...(altText === undefined ? {} : { "aria-description": altText })}
                className="h-control-sm shrink-0 cursor-pointer rounded-control bg-surface-raised px-3 text-label text-text-primary shadow-button hover:shadow-button-hover focus-visible:outline-focus"
              />
            )}
            <ToastClose
              aria-label="Dismiss"
              className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-text-tertiary hover:bg-fill-hover hover:text-text-primary focus-visible:outline-focus"
            >
              <XIcon />
            </ToastClose>
          </Toast>
        );
      }}
    </ToastRegion>
  );
}
