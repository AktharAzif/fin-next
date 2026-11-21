// What a refused staff role change says (spec 02 §14.1's codes, §8.4's rules, §8.5's problems). A
// closed step-up dialog says nothing: the person chose not to go on, and nothing changed. A field
// problem goes beside its field; everything else is the dialog's or the editor's alert.
import { isApiError, isUnreachable } from "@fin/frame";
import { OUR_SIDE, TRY_AGAIN, UNREACHABLE } from "../staff/messages.ts";
import { NO_PERMISSION } from "../staff/rules.ts";
import { problemSentence } from "./editor.ts";

export const CONFLICT =
  "Someone else changed this role meanwhile. Reload the page to see their changes.";
export const BEYOND_YOURS = "This role can do more than yours, so you can’t save it.";
export const LIMIT = "Fin Admin has 30 custom roles. Delete one before you make another.";
export const GONE = "This role no longer exists. The list is up to date now.";
export const MOVE_GONE = "The role you picked no longer exists. Pick another.";
export const MOVE_NEEDED = "Pick the role its people move to.";
export const CANT_MOVE = "You can’t move people to another role. Ask someone who can change roles.";

export interface RoleActionError {
  /** The alert, or null when there is nothing to say (the step-up was closed). */
  readonly message: string | null;
  /** Problems beside the name or description field. */
  readonly fields: { readonly name?: string; readonly description?: string };
  readonly requestId: string | null;
}

function extension(error: { problem: unknown }, name: string): unknown {
  const problem = error.problem;
  return typeof problem === "object" && problem !== null
    ? (problem as Record<string, unknown>)[name]
    : undefined;
}

function fieldProblems(fields: unknown): { name?: string; description?: string; other: boolean } {
  const out: { name?: string; description?: string; other: boolean } = { other: false };
  if (!Array.isArray(fields)) return { other: true };
  for (const field of fields) {
    const { path, code } = (field ?? {}) as { path?: unknown; code?: unknown };
    const sentence = typeof code === "string" ? problemSentence(code) : null;
    if (path === "name" && sentence !== null && out.name === undefined) out.name = sentence;
    else if (path === "description" && sentence !== null) out.description = sentence;
    else out.other = true;
  }
  return out;
}

/** The refusal of making, saving or deleting a custom staff role. */
export function roleActionError(error: unknown): RoleActionError {
  if (!isApiError(error)) return { message: OUR_SIDE, fields: {}, requestId: null };
  const requestId = error.requestId;
  const say = (message: string | null): RoleActionError => ({ message, fields: {}, requestId });
  if (isUnreachable(error)) return say(UNREACHABLE);
  switch (error.code) {
    case "step_up_required":
      return say(null);
    case "step_up_invalid":
      return say(TRY_AGAIN);
    case "forbidden":
      return say(extension(error, "permission") === "staff.role" ? CANT_MOVE : NO_PERMISSION);
    case "outranked":
      return say(BEYOND_YOURS);
    case "giving_refused": {
      const problem = extension(error, "problem");
      if (problem === "beyond") return say(BEYOND_YOURS);
      if (problem === "move_required") return say(MOVE_NEEDED);
      if (problem === "gone" || problem === "unknown_role") return say(MOVE_GONE);
      if (problem === "top_only") return say("Only an Admin can give the Admin role.");
      if (problem === "unchanged") return say("Pick a different role for them to move to.");
      return say("You can’t change this role.");
    }
    case "conflict":
      return say(CONFLICT);
    case "limit_reached":
      return say(LIMIT);
    case "not_found":
      return say(GONE);
    case "invalid": {
      const fields = fieldProblems(extension(error, "fields"));
      return {
        message: fields.other ? "Check what you entered and try again." : null,
        fields: {
          ...(fields.name === undefined ? {} : { name: fields.name }),
          ...(fields.description === undefined ? {} : { description: fields.description }),
        },
        requestId,
      };
    }
    case "rate_limited": {
      const wait = error.retryAfterSeconds;
      return say(
        wait === null
          ? "Too many role changes in a short time. Try again later."
          : `Too many role changes in a short time. Try again in ${Math.max(1, Math.ceil(wait / 60))} minutes.`,
      );
    }
    case "factor_step_required":
    case "unauthenticated":
    case "access_mismatch":
      return say("You were signed out. Sign in again.");
    default:
      return say(OUR_SIDE);
  }
}
