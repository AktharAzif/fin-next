// Fin Admin's router (spec 06 §2.5): file routes, preloading on intent, the router's own pending
// timings (FW-C11), scroll restoration on <main>, and the frame's route states as defaults.
import type { StaffViewer } from "@fin/app-contracts";
import { type FinRouterContext, RouteError, RouteNotFound, RoutePending } from "@fin/frame";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";

export function createAppRouter(context: FinRouterContext<StaffViewer>) {
  return createRouter({
    routeTree,
    context,
    defaultPreload: "intent",
    defaultPendingMs: 1000,
    defaultPendingMinMs: 500,
    defaultViewTransition: false,
    scrollRestoration: true,
    scrollToTopSelectors: ["[data-app-shell-main]"],
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
