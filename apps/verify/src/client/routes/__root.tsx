// Verify's root route (spec 06 §2.5, §7.3): every page in AuthFrame, a path no route matches too,
// and the root StepUp host (unused by verify, which has no sign-in).
import { FinRoot, type FinRouterContext, RouteNotFound } from "@fin/frame";
import { createRootRouteWithContext } from "@tanstack/react-router";

export const Route = createRootRouteWithContext<FinRouterContext<unknown>>()({
  component: () => <FinRoot fallbackFrame="auth" />,
  notFoundComponent: RouteNotFound,
});
