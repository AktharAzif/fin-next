// What a refused staff change says (spec 02 §14.1's codes, §8.5's problems, §10.8's last Admin). A
// closed step-up dialog says nothing: the person chose not to go on, and nothing changed. A refusal
// that shows the page's data is out of date (the member gone, a change meanwhile, the role picked
// gone) says so (`stale`), and the page reads it again before the dialog shows the sentence, so
// "The list is up to date now." is true when it is read.
import { type ApiError, isApiError, isUnreachable } from "@fin/frame";
import { BEYOND, LAST_ADMIN, NO_PERMISSION, OUTRANKED, TOP_ONLY } from "./rules.ts";

export const UNREACHABLE = "Couldn’t reach Fin. Check your connection and try again.";
export const OUR_SIDE = "Something went wrong on our side. Nothing was changed.";
export const TRY_AGAIN = "That didn’t work. Try again.";

export interface ActionError {
  /** The dialog's alert, or null when there is nothing to say (the step-up was closed). */
  readonly message: string | null;
  /** For the email field, when the address itself is the problem. */
  readonly emailError?: string;
  readonly requestId: string | null;
  /** The staff list or the roles changed meanwhile: the page reads them again first. */
  readonly stale?: true;
}

function field(problem: ApiError["problem"], name: string): unknown {
  return problem === null ? undefined : (problem as Record<string, unknown>)[name];
}

/** The refusal of `POST /api/staff`, `PATCH /api/staff/:id`, `POST .../remove` or `.../enrolment-code`. */
export function staffActionError(error: unknown, email?: string): ActionError {
  if (!isApiError(error)) return { message: OUR_SIDE, requestId: null };
  const requestId = error.requestId;
  if (isUnreachable(error)) return { message: UNREACHABLE, requestId };
  switch (error.code) {
    case "step_up_required":
      // api() throws the first answer when the person closed the dialog.
      return { message: null, requestId };
    case "step_up_invalid":
      return { message: TRY_AGAIN, requestId };
    case "forbidden":
      return { message: NO_PERMISSION, requestId };
    case "outranked":
      return { message: OUTRANKED, requestId };
    case "giving_refused": {
      const problem = field(error.problem, "problem");
      const message =
        problem === "top_only"
          ? TOP_ONLY
          : problem === "self"
            ? "You can’t change your own role or remove yourself."
            : problem === "unchanged"
              ? "They already have that role."
              : problem === "gone" || problem === "unknown_role"
                ? "That role no longer exists. Choose another."
                : BEYOND;
      // A custom role deleted meanwhile: the roles are read again, so the picker leaves it out.
      const gone = problem === "gone" || problem === "unknown_role";
      return { message, requestId, ...(gone ? { stale: true as const } : {}) };
    }
    case "last_top_role":
      return { message: LAST_ADMIN, requestId };
    case "already_staff":
      return {
        message: null,
        emailError:
          email === undefined ? "They’re already on staff." : `${email} is already on staff.`,
        requestId,
      };
    case "invalid": {
      const fields = field(error.problem, "fields");
      const paths = Array.isArray(fields)
        ? fields.map((f) =>
            typeof f === "object" && f !== null ? (f as { path?: unknown }).path : f,
          )
        : [];
      if (paths.some((p) => p === "email" || (Array.isArray(p) && p[0] === "email"))) {
        return { message: null, emailError: "Enter a work email address.", requestId };
      }
      return { message: "Check what you entered and try again.", requestId };
    }
    case "not_found":
      return {
        message: "They’re no longer on staff. The list is up to date now.",
        requestId,
        stale: true,
      };
    case "conflict":
    case "already_done":
      return {
        message: "Someone changed this just now. The list is up to date now.",
        requestId,
        stale: true,
      };
    case "rate_limited": {
      const wait = error.retryAfterSeconds;
      return {
        message:
          wait === null
            ? "Too many changes in a short time. Try again in a moment."
            : `Too many changes in a short time. Try again in ${Math.max(1, wait)} seconds.`,
        requestId,
      };
    }
    case "factor_step_required":
    case "unauthenticated":
    case "access_mismatch":
      return { message: "You were signed out. Sign in again.", requestId };
    default:
      return { message: OUR_SIDE, requestId };
  }
}
