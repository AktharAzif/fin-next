// The root StepUp host (spec 06 §2.4; spec 02 §7.1, §7.5): one modal at the root, above every other
// dialog, completing the intent it was opened for. `api()` asks it for a proof when an answer is
// `403 step_up_required`; the app's own modal content (spec 02 §15, `src/client/step-up/**`, the
// identity lanes') runs the passkey or code ceremony and calls `prove` with the proved intent, or
// `cancel`. The host then hears the re-sent request's outcome: done (close), invalid ("That didn't
// work. Try again."), or failed. One request at a time: a second that asks while one is asking or
// its re-send is in flight is refused, and each outcome reaches only the request it was proved for,
// so a late answer can never close or change a request opened after it.
import type { StepUpRequired } from "@fin/app-contracts";
import { type ReactNode, useEffect } from "react";
import type { StepUpProof } from "../api/client.ts";
import { createStore, type Store, useStore } from "../runtime/store.ts";

export type StepUpStatus = "asking" | "sending" | "invalid" | "failed";

export interface StepUpState {
  readonly required: StepUpRequired;
  readonly status: StepUpStatus;
}

export interface StepUpController {
  /** For `api()`'s `stepUp` hook. Resolves null at once when no modal content is mounted. */
  request(required: StepUpRequired): Promise<StepUpProof | null>;
  /** The open request, or null. */
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

export function createStepUpController(): StepUpController {
  const state = createStore<StepUpState | null>(null);
  let attached = false;
  // The request the dialog shows, or null. Every change checks it is still the same ticket.
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
      if (!next && current !== null) close();
    },
    request(required) {
      const open = state.get();
      if (!attached || open?.status === "asking" || open?.status === "sending") {
        return Promise.resolve(null);
      }
      // A finished request still on screen ("That didn't work") gives way to the new one.
      const ticket: Ticket = { waiting: null };
      current = ticket;
      state.set({ required, status: "asking" });
      return new Promise<StepUpProof | null>((resolve) => {
        ticket.waiting = resolve;
      });
    },
    prove(intentId) {
      const ticket = current;
      const open = state.get();
      const waiting = ticket?.waiting ?? null;
      if (ticket === null || open === null || waiting === null) return;
      ticket.waiting = null;
      state.set({ ...open, status: "sending" });
      let settled = false;
      waiting({
        intentId,
        settle(outcome) {
          if (settled) return;
          settled = true;
          // The dialog was closed, or now shows a later request: this outcome is not its own.
          if (current !== ticket) return;
          const shown = state.get();
          if (shown === null) return;
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
  /** Closes the modal; after `invalid` or `failed` it is the only way out (never a loop). */
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
