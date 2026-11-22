// The signed-out routes' guards and search readers. They run in a route's `beforeLoad` and
// `validateSearch`, which stay in the app's first bundle while the pages are split off, so this
// module imports no UI and no ceremony code (spec 06 §1.5's first-route budget). Display decisions
// only: every API route checks the session itself.
import type { ConsoleViewer } from "@fin/app-contracts";
import { type FinRouterContext, signInHref } from "@fin/frame";
import { redirect } from "@tanstack/react-router";
import { stepFor } from "./after-sign-in.ts";

function go(href: string): never {
  throw redirect({ href, replace: true } as unknown as Parameters<typeof redirect>[0]);
}

/** `?next=`, kept only when it is a non-empty string (the pages check it is safe before use). */
export function readNext(search: Record<string, unknown>): { next?: string } {
  return typeof search.next === "string" && search.next !== "" ? { next: search.next } : {};
}

/** Only a session at the factor step stays; everyone else goes where their gate says. */
export function guardFactorStep({
  context,
  search,
}: {
  context: FinRouterContext<ConsoleViewer>;
  search: { next?: string };
}): void {
  const viewer = context.fin.viewer.get();
  if (viewer === null) go(signInHref({ pathname: "/", search: "" }, context.fin.routeExists));
  else if (viewer.gate !== "factor_step") {
    const step = stepFor(viewer, search.next ?? null, context.fin.routeExists);
    go(step.kind === "go" ? step.href : "/");
  }
}

/** Whether the viewer allows the "Trust this browser" box (absent at the factor step: no). */
export function canTrust(viewer: ConsoleViewer | null): boolean {
  if (viewer === null) return false;
  return "canTrustBrowser" in viewer && viewer.canTrustBrowser === true;
}
