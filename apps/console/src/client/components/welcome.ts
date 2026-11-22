// Who the two "welcome" pages (Protect your account, Set up your authenticator) are for: a signed-in
// person with no second factor. Anyone else goes where their gate says (spec 02 §6.2).
import type { ConsoleViewer } from "@fin/app-contracts";
import { type FinRouterContext, safeNext, signInHref } from "@fin/frame";
import { redirect } from "@tanstack/react-router";

export function hasFactor(viewer: ConsoleViewer | null): boolean {
  if (viewer === null || viewer.gate === "factor_step") return false;
  return viewer.factors.passkeys > 0 || viewer.factors.authenticator;
}

/** Where a viewer who is not for these pages goes, or null to stay. */
export function welcomeRedirect(
  viewer: ConsoleViewer | null,
  next: string | null,
  matches: (pathname: string) => boolean,
): string | null {
  if (viewer === null) return signInHref({ pathname: "/welcome/secure", search: "" }, matches);
  if (viewer.gate === "factor_step") return "/sign-in/two-factor";
  if (hasFactor(viewer)) return safeNext(next, matches) ?? "/";
  return null;
}

export function guardWelcome({
  context,
  search,
}: {
  context: FinRouterContext<ConsoleViewer>;
  search: { next?: string };
}): void {
  const href = welcomeRedirect(
    context.fin.viewer.get(),
    search.next ?? null,
    context.fin.routeExists,
  );
  if (href !== null) {
    throw redirect({ href, replace: true } as unknown as Parameters<typeof redirect>[0]);
  }
}
