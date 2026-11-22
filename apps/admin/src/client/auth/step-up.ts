// A library call that the realm answers `403 step_up_required` (spec 02 §7.1, §7.5), run through the
// root StepUp dialog the way api() runs Fin's own routes: ask for the proof of the named intent,
// then send the call again once with `Fin-Step-Up-Intent`, and tell the dialog how that went, so it
// closes, or says "That didn't work. Try again." and never loops.
import { type StepUpRequired, stepUpRequiredSchema } from "@fin/app-contracts";
import type { StepUpController } from "@fin/frame";
import type { AuthAnswer, AuthFailure } from "./http.ts";

export type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: AuthFailure }
  /** The browser's own part did not finish (a passkey prompt closed): no refusal from Fin. */
  | { readonly ok: false; readonly stopped: string };

export type SteppedUp<T> =
  | Attempt<T>
  /** The person closed the dialog: nothing was done. */
  | { readonly ok: false; readonly cancelled: true };

/** The `step_up_required` document in a failure, or null. */
export function stepUpRequiredOf(failure: AuthFailure): StepUpRequired | null {
  if (failure.kind !== "problem" || failure.problem.code !== "step_up_required") return null;
  const parsed = stepUpRequiredSchema.safeParse(failure.problem);
  return parsed.success ? parsed.data : null;
}

/** Turns one realm answer into an attempt. */
export function attemptOf(answer: AuthAnswer): Attempt<unknown> {
  return answer.ok ? { ok: true, value: answer.data } : { ok: false, failure: answer };
}

/**
 * Runs `attempt` with no intent; on `step_up_required` asks the dialog for the proof and runs it
 * once more with the proved intent. `askIntent` supplies the intent when the first answer names
 * none (a passkey's options are a GET, and a GET makes no intent).
 */
export async function withStepUp<T>(
  stepUp: Pick<StepUpController, "request">,
  attempt: (intentId: string | null) => Promise<Attempt<T>>,
  askIntent?: () => Promise<AuthAnswer>,
): Promise<SteppedUp<T>> {
  const first = await attempt(null);
  if (first.ok || !("failure" in first)) return first;
  let required = stepUpRequiredOf(first.failure);
  if (required === null) return first;
  if (required.step_up_kind === "intent" && required.intent_id === undefined) {
    if (askIntent === undefined) return first;
    const asked = await askIntent();
    if (asked.ok) return first;
    required = stepUpRequiredOf(asked);
    if (required === null) return { ok: false, failure: asked };
    if (required.step_up_kind === "intent" && required.intent_id === undefined) return first;
  }
  const proof = await stepUp.request(required);
  if (proof === null) return { ok: false, cancelled: true };
  let second: Attempt<T>;
  try {
    second = await attempt(proof.intentId);
  } catch (error) {
    proof.settle("failed");
    throw error;
  }
  if (second.ok) {
    proof.settle("done");
    return second;
  }
  const invalid =
    "failure" in second &&
    second.failure.kind === "problem" &&
    second.failure.problem.code === "step_up_invalid";
  proof.settle(invalid ? "invalid" : "failed");
  return second;
}
