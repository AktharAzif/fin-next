// What a refused reset says (spec 02 §14.1's codes, §8.5's problems, §10.8's last Admin). The Staff
// page's own sentences for every other refusal; the reset's own for resetting oneself. A closed
// "Confirm it's you" says nothing: the Admin chose not to go on, and nothing changed.
import { isApiError } from "@fin/frame";
import { type ActionError, staffActionError } from "../../../staff/messages.ts";
import { OWN_RESET } from "./rules.ts";

/** Refusals after which the list on screen is out of date, so the page reads it again. */
const STALE = new Set(["not_found", "conflict", "already_done", "last_top_role", "outranked"]);

export function resetError(error: unknown): ActionError & { readonly stale: boolean } {
  if (isApiError(error)) {
    const problem = error.problem as Record<string, unknown> | null;
    if (error.code === "giving_refused" && problem?.problem === "self") {
      return { message: OWN_RESET, requestId: error.requestId, stale: false };
    }
    return { ...staffActionError(error), stale: STALE.has(error.code ?? "") };
  }
  return { ...staffActionError(error), stale: false };
}
