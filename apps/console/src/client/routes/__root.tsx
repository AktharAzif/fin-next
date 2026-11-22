// The console's root route (spec 06 §2.5): the guard that decides the first navigation from the
// viewer (spec 06 §2.3 step 4), then FrameSwitch around the page, AppFrame for `app` routes and
// AuthFrame for `auth` routes, and the root StepUp host. A path no route matches draws the
// not-found page inside AppFrame.
import type { ConsoleViewer } from "@fin/app-contracts";
import { AppFrame, FinRoot, type FinRouterContext, guardConsole, RouteNotFound } from "@fin/frame";
import { createRootRouteWithContext } from "@tanstack/react-router";

export const Route = createRootRouteWithContext<FinRouterContext<ConsoleViewer>>()({
  beforeLoad: (input): void => guardConsole(input),
  component: () => <FinRoot appFrame={AppFrame} fallbackFrame="app" />,
  notFoundComponent: RouteNotFound,
});
