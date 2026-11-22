// Fin Admin's root route (spec 06 §2.5): the guard that sends a signed-out or part-signed-in member
// of staff to their sign-in step (spec 06 §2.3 step 4), then FrameSwitch around the page, AdminFrame
// for `app` routes and AuthFrame for `auth` routes, and the root StepUp host.
import type { StaffViewer } from "@fin/app-contracts";
import { AdminFrame, FinRoot, type FinRouterContext, guardAdmin, RouteNotFound } from "@fin/frame";
import { createRootRouteWithContext } from "@tanstack/react-router";

export const Route = createRootRouteWithContext<FinRouterContext<StaffViewer>>()({
  beforeLoad: (input): void => guardAdmin(input),
  component: () => <FinRoot appFrame={AdminFrame} fallbackFrame="app" />,
  notFoundComponent: RouteNotFound,
});
