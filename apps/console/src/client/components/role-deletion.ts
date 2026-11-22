// Deleting a custom role from the Roles board (spec 02 §8.4): what the request names and what a
// refusal means for the dialog. The request names the holders the dialog counted (the row's
// `holderIds`), which the server binds to the intent; a refusal that shows the list is out of date
// (the holders changed, a move is now needed, the role picked is gone) has the page read the list
// again before the dialog says so, and a role deleted meanwhile closes the dialog once the list no
// longer shows it. Every other refusal keeps the dialog's "Try again."
import { isApiError } from "@fin/frame";
import type { RoleRow } from "../api/contracts/roles.ts";

export const HOLDERS_CHANGED =
  "The people with this role changed meanwhile. Check how many move now, then try again.";
export const MOVE_NEEDED = "Pick the role its people move to.";
export const MOVE_GONE = "The role you picked no longer exists. Pick another.";
export const TRY_AGAIN = "Try again.";
/** Said once the list has been read again without the role. */
export const GONE = "The list is up to date now.";

/** The deletion's body: the holders the dialog counted, and where they move when anyone does. */
export function deletionInput(role: RoleRow, moveTo: string | null) {
  return {
    roleId: role.roleId ?? role.roleKey,
    holders: [...(role.holderIds ?? [])],
    ...(moveTo === null ? {} : { moveTo }),
  };
}

export interface DeletionRefusal {
  /**
   * `gone`: the role no longer exists (read the list again and close); `list`: the holders or the
   * roles changed meanwhile (read the list again and stay); null: nothing on the page is stale.
   */
  readonly stale: "gone" | "list" | null;
  readonly sentence: string;
}

function problemOf(error: { problem: unknown }): unknown {
  const problem = error.problem;
  return typeof problem === "object" && problem !== null
    ? (problem as Record<string, unknown>).problem
    : undefined;
}

/** What a refused deletion means for the dialog (told-elsewhere refusals are not asked). */
export function deletionRefusal(error: unknown): DeletionRefusal {
  if (!isApiError(error)) return { stale: null, sentence: TRY_AGAIN };
  if (error.code === "not_found") return { stale: "gone", sentence: GONE };
  // A deletion has no version: its conflict is the holders it named, which changed.
  if (error.code === "conflict") return { stale: "list", sentence: HOLDERS_CHANGED };
  if (error.code === "giving_refused") {
    const problem = problemOf(error);
    if (problem === "move_required") return { stale: "list", sentence: MOVE_NEEDED };
    if (problem === "gone" || problem === "unknown_role") {
      return { stale: "list", sentence: MOVE_GONE };
    }
  }
  return { stale: null, sentence: TRY_AGAIN };
}
