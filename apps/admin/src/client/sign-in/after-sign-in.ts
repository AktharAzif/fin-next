// Where a member of staff goes once the realm has answered a sign-in step: the viewer is read again
// (the session changed), and its state picks the next page (spec 02 §6.4): the factor step or
// enrolment for an `aal1` session, Fin Admin's home once the session is `aal2`.
import type { StaffViewer } from "@fin/app-contracts";

export type NextStep = "/" | "/sign-in/factor" | "/sign-in";

/** The page a viewer belongs on; null when the viewer could not be read. */
export function nextStepFor(viewer: StaffViewer | null): NextStep {
  if (viewer === null || viewer.state === "signed_out") return "/sign-in";
  if (viewer.state === "pending" || viewer.state === "factor_step") return "/sign-in/factor";
  return "/";
}
