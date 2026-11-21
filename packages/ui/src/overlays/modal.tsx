// Modal and ConfirmDialog (spec 06 §3.3; the export's Modal and ConfirmDialog specs) on the SDK's
// dialog and alert dialog: in place, in the top layer, no portal. 480px with 24px padding, 16px
// from the edges on phones. `busy` stops Escape, the scrim and Close. ConfirmDialog has no X: its
// title is a question and its confirm button repeats the verb. Exits run on data-ending-style.
import { XIcon } from "@fin/icons";
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@ui-sdk/react/alert-dialog";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { Button, IconButton } from "../foundation/button.tsx";
import { Field, Input } from "../foundation/field.tsx";
import { InlineAlert } from "../foundation/inline-alert.tsx";
import { cn } from "../lib/cn.ts";

const BACKDROP = cn(
  "fixed inset-0 bg-overlay transition-fade state-starting:opacity-0 state-ending:opacity-0",
);

const PANEL = cn(
  "fixed inset-x-4 inset-y-0 m-auto flex h-fit max-h-full max-w-modal flex-col gap-6 overflow-auto",
  "rounded-md bg-surface-raised p-modal-padding text-text-primary shadow-overlay",
  "transition-dialog state-starting:scale-pop state-starting:opacity-0",
  "state-ending:scale-pop state-ending:opacity-0 state-ending:duration-slow-exit",
);

const TITLE = "m-0 text-heading text-text-primary outline-none";
const DESCRIPTION = "m-0 text-body text-text-secondary";

export type ModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the modal is for: "Create API key". */
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned: secondary first, then the one primary. */
  footer?: ReactNode;
  /** While a request runs: Escape, the scrim and Close do nothing. */
  busy?: boolean;
  /** Where focus lands on open; the title by default, the first field for forms. */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
};

export function Modal(props: ModalProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const busy = props.busy === true;
  return (
    <Dialog open={props.open} onOpenChange={(open) => props.onOpenChange(open)} dismissible={!busy}>
      <DialogBackdrop className={BACKDROP} />
      <DialogContent
        initialFocus={() => props.initialFocus?.current ?? titleRef.current}
        aria-busy={busy || undefined}
        className={cn(PANEL, props.className)}
      >
        <div className="flex items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <DialogTitle ref={titleRef} tabIndex={-1} className={TITLE}>
              {props.title}
            </DialogTitle>
            {props.description === undefined ? null : (
              <DialogDescription className={DESCRIPTION}>{props.description}</DialogDescription>
            )}
          </div>
          <DialogClose
            disabled={busy}
            render={
              <IconButton
                label="Close"
                icon={<XIcon />}
                size="sm"
                tooltip={false}
                className="-mt-1 -mr-2"
              />
            }
          />
        </div>
        {props.children === undefined ? null : (
          <div className="flex flex-col gap-4">{props.children}</div>
        )}
        {props.footer === undefined ? null : (
          <div className="flex flex-wrap justify-end gap-2">{props.footer}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A question naming the action and the object: "Delete this webhook?" */
  title: string;
  /** The consequence, outcome first. */
  description: ReactNode;
  /** A verb and an object, matching the title: "Delete webhook". */
  confirmLabel: string;
  cancelLabel?: string;
  /** danger for anything that deletes data or cannot be undone. */
  tone?: "default" | "danger";
  onConfirm: () => unknown;
  /** While the request runs: the confirm button spins and nothing can dismiss the dialog. */
  busy?: boolean;
  /** Why the last attempt failed, in one sentence; the dialog stays open. */
  error?: string;
  /** Typed confirmation (Production deletes): the exact text to type, usually the name. */
  confirmText?: string;
  /** The environment cue: "This moves real money in Production." */
  cue?: string;
};

export function ConfirmDialog(props: ConfirmDialogProps) {
  const busy = props.busy === true;
  const [typed, setTyped] = useState("");
  // A typed confirmation belongs to one opening of the dialog: it starts empty every time the
  // dialog opens, however it was last closed (by the page after its request, by Cancel or by
  // Escape), and whenever it names something else. Reset while rendering, so a stale value is
  // never drawn, not even for a frame.
  const [opening, setOpening] = useState({ open: props.open, text: props.confirmText });
  if (opening.open !== props.open || opening.text !== props.confirmText) {
    setOpening({ open: props.open, text: props.confirmText });
    if (props.open || opening.text !== props.confirmText) setTyped("");
  }
  const inputId = `confirm${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const matches = props.confirmText === undefined || typed === props.confirmText;
  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(open) => props.onOpenChange(open)}
      dismissible={!busy}
    >
      <AlertDialogBackdrop className={BACKDROP} />
      <AlertDialogContent aria-busy={busy || undefined} className={PANEL}>
        <div className="flex flex-col gap-1">
          <AlertDialogTitle className={TITLE}>{props.title}</AlertDialogTitle>
          <AlertDialogDescription className={DESCRIPTION}>
            {props.description}
          </AlertDialogDescription>
        </div>
        {props.cue === undefined &&
        props.error === undefined &&
        props.confirmText === undefined ? null : (
          <div className="flex flex-col gap-4">
            {props.cue === undefined ? null : <InlineAlert tone="warning" title={props.cue} />}
            {props.confirmText === undefined ? null : (
              <Field id={inputId} label={`Type ${props.confirmText} to confirm`}>
                <Input
                  value={typed}
                  onValueChange={(value) => setTyped(value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </Field>
            )}
            {props.error === undefined ? null : (
              <InlineAlert tone="danger" title={props.error} live="assertive" />
            )}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <AlertDialogClose
            disabled={busy}
            render={<Button variant="secondary">{props.cancelLabel ?? "Cancel"}</Button>}
          />
          <Button
            variant={props.tone === "danger" ? "danger" : "primary"}
            loading={busy}
            {...(matches
              ? {}
              : { disabledReason: `Type ${props.confirmText ?? ""} exactly to confirm.` })}
            onClick={() => props.onConfirm()}
          >
            {props.confirmLabel}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
