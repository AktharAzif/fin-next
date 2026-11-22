// How a page reports an action that did not go through. Some failures are already told elsewhere
// and say nothing more: the person closed the StepUp dialog (nothing changed), the dialog itself
// said "That didn't work", or the frame opened its notice or moved the person on (a second factor
// first, a sign-in by email, the factor step, a lost session). The rest become one sentence.
import { isApiError } from "@fin/frame";
import { toast } from "@fin/ui";
import { failureOf } from "./failures.ts";
import { isStepUpCancelled } from "./step-up.ts";

const TOLD_ELSEWHERE = new Set([
  "step_up_required",
  "step_up_invalid",
  "second_factor_required",
  "fresh_session_required",
  "factor_step_required",
  "unauthenticated",
]);

/** True when the failure was already told to the person (see the file's head). */
export function toldElsewhere(error: unknown): boolean {
  if (isStepUpCancelled(error)) return true;
  return isApiError(error) && error.code !== null && TOLD_ELSEWHERE.has(error.code);
}

/** The second sentence for a failed action, by what failed. */
export function failureSentence(error: unknown): string {
  switch (failureOf(error)) {
    case "offline":
      return "Check your connection and try again.";
    case "rateLimited":
      return "Too many changes in a short time. Try again in a few minutes.";
    case "notAllowed":
      return "Your role doesn’t allow this. Ask someone who can change roles.";
    case "conflict":
      return "Someone else changed this meanwhile. Reload the page and try again.";
    case "notFound":
      return "It no longer exists. Reload the page.";
    default:
      return "Try again in a moment.";
  }
}

/** Shows the failure as an error toast, unless it was told elsewhere. */
export function toastFailure(error: unknown, title: string): void {
  if (toldElsewhere(error)) return;
  toast.error({ title, description: failureSentence(error) });
}
