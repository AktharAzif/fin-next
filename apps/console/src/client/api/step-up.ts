// An intent proved once for an action that takes more than one request (spec 02 §7.6's
// `account.passkey_add`: the options GET checks the intent, the verify POST consumes it). api()
// re-sends one request after the proof; this does the same for a sequence: the first try asks for
// the intent, the root StepUp dialog proves it, and the sequence runs once with it. It never loops:
// a failure after the proof settles the dialog and is thrown to the screen.
import { type StepUpRequired, stepUpRequiredSchema } from "@fin/app-contracts";
import { isApiError, type StepUpController } from "@fin/frame";

/** The step-up the error asks for, or null when it asks for none. */
export function stepUpOf(error: unknown): StepUpRequired | null {
  if (!isApiError(error) || error.code !== "step_up_required" || error.problem === null)
    return null;
  const parsed = stepUpRequiredSchema.safeParse(error.problem);
  return parsed.success ? parsed.data : null;
}

/** The person closed the dialog: nothing changed. */
export class StepUpCancelled extends Error {
  constructor() {
    super("step-up cancelled");
    this.name = "StepUpCancelled";
  }
}

export function isStepUpCancelled(error: unknown): boolean {
  return error instanceof StepUpCancelled;
}

export interface IntentRun<T> {
  /** The first try, without an intent: it succeeds (no factor yet) or asks for one. */
  ask: () => Promise<T>;
  /** The sequence with the proved intent. */
  proved: (intentId: string) => Promise<T>;
  /** An outcome that is the person's own choice (a cancelled passkey prompt), not a failure. */
  settlesAsDone?: (error: unknown) => boolean;
}

/**
 * The frame's reactions for a call made with a ceremony client (which has none): "Add a second
 * factor first" or Protect your account, and "Sign in by email to add a second factor". True when
 * the error was one of them.
 */
export function reactToGate(
  stepUp: StepUpController,
  error: unknown,
  goToProtect: () => void,
): boolean {
  if (!isApiError(error) || error.problem === null) return false;
  if (error.code === "second_factor_required") {
    if ((error.problem as { hold?: unknown }).hold === true) goToProtect();
    else stepUp.notify("second_factor_required");
    return true;
  }
  if (error.code === "fresh_session_required") {
    stepUp.notify("fresh_session_required");
    return true;
  }
  return false;
}

export async function withIntent<T>(stepUp: StepUpController, run: IntentRun<T>): Promise<T> {
  let required: StepUpRequired | null;
  try {
    return await run.ask();
  } catch (error) {
    required = stepUpOf(error);
    if (required === null || required.step_up_kind !== "intent" || !required.intent_id) throw error;
  }
  const proof = await stepUp.request(required);
  if (proof === null || proof.intentId === null) throw new StepUpCancelled();
  try {
    const value = await run.proved(proof.intentId);
    proof.settle("done");
    return value;
  } catch (error) {
    if (run.settlesAsDone?.(error) === true) proof.settle("done");
    else proof.settle(isApiError(error) && error.code === "step_up_invalid" ? "invalid" : "failed");
    throw error;
  }
}
