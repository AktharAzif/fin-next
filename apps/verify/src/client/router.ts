// Verify's router (spec 06 §2.5): file routes under AuthFrame, the router's own pending timings
// (FW-C11), and the frame's route states as defaults.
import { type FinRouterContext, RouteError, RouteNotFound, RoutePending } from "@fin/frame";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";

export function createAppRouter(context: FinRouterContext<unknown>) {
  return createRouter({
    routeTree,
    context,
    defaultPreload: "intent",
    defaultPendingMs: 1000,
    defaultPendingMinMs: 500,
    defaultViewTransition: false,
    scrollRestoration: true,
    defaultPendingComponent: RoutePending,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
