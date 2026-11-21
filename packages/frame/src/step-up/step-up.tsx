// The root StepUp host (spec 06 §2.4; spec 02 §7.1, §7.5): one modal at the root, above every other
// dialog, completing the intent it was opened for. `api()` asks it for a proof when an answer is
// `403 step_up_required`; the app's own modal content (spec 02 §15, `src/client/step-up/**`, the
// identity lanes') runs the passkey or code ceremony and calls `prove` with the proved intent, or
// `cancel`. The host then hears the re-sent request's outcome: done (close), invalid ("That didn't
// work. Try again."), or failed. One request at a time: a second that asks while one is asking or
// its re-send is in flight is refused, and each outcome reaches only the request it was proved for,
// so a late answer can never close or change a request opened after it.
//
// The same dialog has two notices of its own (the StepUp board's "add a second factor first" and
// "sign in by email to add a second factor"): `403 second_factor_required` without a hold, and
// `403 fresh_session_required`, open them through `notify`. A notice asks for no proof; nobody
// waits on it, and the call that met it fails to its screen as before.
import type { StepUpRequired } from "@fin/app-contracts";
import { type ReactNode, useEffect } from "react";
import type { StepUpProof } from "../api/client.ts";
import { createStore, type Store, useStore } from "../runtime/store.ts";

export type StepUpStatus = "asking" | "sending" | "invalid" | "failed";

/** The answers that need a factor before any proof can be given (spec 02 §6.3, §7.5). */
export type StepUpNotice = "second_factor_required" | "fresh_session_required";

export type StepUpState =
  /** A proof for the named intent or window, and how its re-send went. */
  | {
      readonly kind: "proof";
      readonly required: StepUpRequired;
      readonly status: StepUpStatus;
    }
  /** One of the dialog's notices; Close is the only way on. */
  | { readonly kind: "notice"; readonly notice: StepUpNotice };

export interface StepUpController {
  /** For `api()`'s `stepUp` hook. Resolves null at once when no modal content is mounted. */
  request(required: StepUpRequired): Promise<StepUpProof | null>;
  /** Opens one of the dialog's notices, unless a proof is asking or sending. */
  notify(notice: StepUpNotice): void;
  /** What the dialog shows, or null. */
  readonly state: Store<StepUpState | null>;
  /** The modal content calls this after the ceremony succeeded (null intent for a window). */
  prove(intentId: string | null): void;
  /** The person closed the modal, or the ceremony could not run. */
  cancel(): void;
  /** Whether app content is mounted to run ceremonies (set by StepUpHost). */
  attach(attached: boolean): void;
}

/** One open request: who is waiting for the proof, until the person proves or closes. */
interface Ticket {
  waiting: ((proof: StepUpProof | null) => void) | null;
}

/** True while the dialog holds a proof that is not finished: it may not be replaced. */
function busy(state: StepUpState | null): boolean {
  return state?.kind === "proof" && (state.status === "asking" || state.status === "sending");
}

export function createStepUpController(): StepUpController {
  const state = createStore<StepUpState | null>(null);
  let attached = false;
  // The request the dialog shows, or null (nothing open, or a notice). Every change to a proof
  // checks it is still the same ticket.
  let current: Ticket | null = null;

  /** Closes the dialog: the waiting api() call (if any) hears null, a late outcome is ignored. */
  const close = () => {
    const ticket = current;
    current = null;
    state.set(null);
    const waiting = ticket?.waiting ?? null;
    if (ticket !== null) ticket.waiting = null;
    waiting?.(null);
  };

  return {
    state,
    attach(next) {
      attached = next;
      if (!next && state.get() !== null) close();
    },
    request(required) {
      if (!attached || busy(state.get())) return Promise.resolve(null);
      // A finished request still on screen ("That didn't work") or a notice gives way.
      const ticket: Ticket = { waiting: null };
      current = ticket;
      state.set({ kind: "proof", required, status: "asking" });
      return new Promise<StepUpProof | null>((resolve) => {
        ticket.waiting = resolve;
      });
    },
    notify(notice) {
      if (!attached || busy(state.get())) return;
      current = null;
      state.set({ kind: "notice", notice });
    },
    prove(intentId) {
      const ticket = current;
      const open = state.get();
      const waiting = ticket?.waiting ?? null;
      if (ticket === null || open?.kind !== "proof" || waiting === null) return;
      ticket.waiting = null;
      state.set({ ...open, status: "sending" });
      let settled = false;
      waiting({
        intentId,
        settle(outcome) {
          if (settled) return;
          settled = true;
          // The dialog was closed, or now shows something later: this outcome is not its own.
          if (current !== ticket) return;
          const shown = state.get();
          if (shown?.kind !== "proof") return;
          if (outcome === "done") {
            current = null;
            state.set(null);
          } else {
            state.set({ ...shown, status: outcome });
          }
        },
      });
    },
    cancel() {
      close();
    },
  };
}

export interface StepUpContentProps {
  readonly state: StepUpState;
  prove(intentId: string | null): void;
  /** Closes the modal; after `invalid`, `failed` or a notice it is the only way out (never a loop). */
  close(): void;
}

/**
 * Mounts the app's StepUp modal content at the root. Without `content` (before the identity lanes
 * add theirs), api() gets no proof and the screen shows the refusal.
 */
export function StepUpHost({
  controller,
  content: Content,
}: {
  controller: StepUpController;
  content?: ((props: StepUpContentProps) => ReactNode) | undefined;
}) {
  const state = useStore(controller.state);
  const mounted = Content !== undefined;
  useEffect(() => {
    controller.attach(mounted);
    return () => controller.attach(false);
  }, [controller, mounted]);
  if (Content === undefined || state === null) return null;
  return (
    <Content
      state={state}
      prove={(intentId) => controller.prove(intentId)}
      close={() => controller.cancel()}
    />
  );
}
