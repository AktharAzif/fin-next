// Where a person goes once a sign-in, a factor or an invitation has changed their session (spec 02
// §5.1 step 3, §5.9, §6.2): the viewer is read again and its gate decides. A person with no
// membership gets their first organisation, unless an invitation is waiting in the cookie, which
// they answer first. These are display decisions only: every API route checks the session itself.
import type { ConsoleViewer } from "@fin/app-contracts";
import { type FinRuntime, isApiError, safeNext } from "@fin/frame";
import { waitingInvitation } from "../api/contracts/invitations.ts";
import { createFirstOrganisation } from "../api/contracts/orgs.ts";

/** The next step for a viewer, before any call: a path, or the first organisation to make. */
export type Step = { kind: "go"; href: string } | { kind: "firstOrganisation" };

/** Adds a safe `next` to a sign-in step's path, so it survives the factor step. */
export function withNext(path: string, next: string | null): string {
  if (next === null || next === "" || next === "/") return path;
  return `${path}?${new URLSearchParams({ next }).toString()}`;
}

export function stepFor(
  viewer: ConsoleViewer | null,
  next: string | null,
  matches: (pathname: string) => boolean,
): Step {
  if (viewer === null) return { kind: "go", href: withNext("/sign-in", next) };
  if (viewer.gate === "factor_step") {
    return { kind: "go", href: withNext("/sign-in/two-factor", next) };
  }
  if (viewer.gate === "protect_account") {
    return { kind: "go", href: withNext("/welcome/secure", next) };
  }
  if (viewer.memberships.length === 0) return { kind: "firstOrganisation" };
  if (viewer.currentOrgId === null && viewer.memberships.every((m) => !m.roleKnown)) {
    return { kind: "go", href: "/no-access" };
  }
  return { kind: "go", href: safeNext(next, matches) ?? "/" };
}

/**
 * For a signed-in person with no membership: the waiting invitation's page, or else their first
 * organisation, made now. Resolves with where to go.
 */
export async function ensureOrganisation(
  fin: FinRuntime<ConsoleViewer>,
  next: string | null,
): Promise<string> {
  try {
    await fin.api(waitingInvitation, {});
    return "/invite";
  } catch (error) {
    // 404 invitation_unusable (or none in the cookie): no invitation is waiting.
    if (!isApiError(error) || error.status !== 404) throw error;
  }
  try {
    await fin.api(createFirstOrganisation, {});
  } catch (error) {
    // Made meanwhile in another tab: the person has a membership now, which the viewer shows.
    if (!isApiError(error) || error.status !== 409) throw error;
  }
  const viewer = await fin.viewer.reload();
  const step = stepFor(viewer, next, fin.routeExists);
  if (step.kind === "firstOrganisation") return "/no-access";
  return step.href;
}

/** Reads the viewer again and resolves with the path this person goes to now. */
export async function destinationAfterSignIn(
  fin: FinRuntime<ConsoleViewer>,
  next: string | null,
): Promise<string> {
  const viewer = await fin.viewer.reload();
  const step = stepFor(viewer, next, fin.routeExists);
  return step.kind === "go" ? step.href : ensureOrganisation(fin, next);
}
