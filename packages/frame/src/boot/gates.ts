// The first navigation, from the viewer's answer (spec 06 §2.3 step 4). On a route of the `app`
// frame the API is the guard (FW-C10): with no session the person goes to sign-in, keeping a safe
// `next`; a person part-way through signing in goes to the step they are at. On an `auth` route a
// 401 is the expected answer and nothing redirects; whether a signed-in viewer stays on an auth page
// is that page's own rule (spec 02 §15). These are display decisions only: every API route checks
// the session and the permission itself.
import type { ConsoleViewer, StaffViewer } from "@fin/app-contracts";
import { signInHref } from "../router/next.ts";
import type { FrameKind } from "../router/static-data.ts";

export interface GateLocation {
  pathname: string;
  search: string;
}

/** Where the console sends this viewer before rendering, or null to render the route. */
export function consoleGate(
  viewer: ConsoleViewer | null,
  frame: FrameKind,
  location: GateLocation,
  matches: (pathname: string) => boolean,
): string | null {
  if (frame !== "app") return null;
  if (viewer === null) return signInHref(location, matches);
  if (viewer.gate === "factor_step") return "/sign-in/two-factor";
  if (viewer.gate === "protect_account") return "/welcome/secure";
  if (
    viewer.currentOrgId === null &&
    viewer.memberships.length > 0 &&
    viewer.memberships.every((membership) => !membership.roleKnown)
  ) {
    return "/no-access";
  }
  return null;
}

/** Where Fin Admin sends this member of staff before rendering, or null to render the route. */
export function adminGate(viewer: StaffViewer | null, frame: FrameKind): string | null {
  if (frame !== "app") return null;
  if (viewer === null || viewer.state === "signed_out") return "/sign-in";
  if (viewer.state === "pending" || viewer.state === "factor_step") return "/sign-in/factor";
  return null;
}
