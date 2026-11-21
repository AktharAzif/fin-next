// The root StepUp host (spec 06 §2.4; spec 02 §7.1, §7.5): one modal at the root, above every other
// dialog, completing the intent it was opened for. `api()` asks it for a proof when an answer is
// `403 step_up_required`; the app's own modal content (spec 02 §15, `src/client/step-up/**`, the
// identity lanes') runs the passkey or code ceremony and calls `prove` with the proved intent, or
// `cancel`. The host then hears the re-sent request's outcome: done (close), invalid ("That didn't
// work. Try again."), or failed. One request at a time; a second asks while one is open are refused.
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

export function createStepUpController(): StepUpController {
  const state = createStore<StepUpState | null>(null);
  let attached = false;
  let resolve: ((proof: StepUpProof | null) => void) | null = null;

  const finish = (proof: StepUpProof | null) => {
    const done = resolve;
    resolve = null;
    done?.(proof);
  };

  return {
    state,
    attach(next) {
      attached = next;
      if (!next && resolve !== null) {
        finish(null);
        state.set(null);
      }
    },
    request(required) {
      if (!attached || resolve !== null) return Promise.resolve(null);
      state.set({ required, status: "asking" });
      return new Promise<StepUpProof | null>((settle) => {
        resolve = settle;
      });
    },
    prove(intentId) {
      const current = state.get();
      if (current === null || resolve === null) return;
      state.set({ ...current, status: "sending" });
      let settled = false;
      finish({
        intentId,
        settle(outcome) {
          if (settled) return;
          settled = true;
          const open = state.get();
          if (open === null) return;
          state.set(outcome === "done" ? null : { ...open, status: outcome });
        },
      });
    },
    cancel() {
      finish(null);
      state.set(null);
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
