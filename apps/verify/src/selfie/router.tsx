// The selfie host's router (spec 06 §7.3, FW-C20): one page, `/s`, in AuthFrame, with the frame's
// route states as defaults. The routes are declared here in code rather than as file routes: the
// selfie document is its own entry with one page, and its routes never mix with verify's.
import {
  FinRoot,
  type FinRouterContext,
  RouteError,
  RouteNotFound,
  RoutePending,
} from "@fin/frame";
import { createRootRouteWithContext, createRoute, createRouter } from "@tanstack/react-router";
import { AuthPageStub } from "../client/components/RouteStub.tsx";

const rootRoute = createRootRouteWithContext<FinRouterContext<unknown>>()({
  component: () => <FinRoot fallbackFrame="auth" />,
  notFoundComponent: RouteNotFound,
});

// `/s`: the selfie hand-off (spec 03 §2.6). The ticket arrived in the fragment and is already gone
// from the address bar (./ticket.ts); L-SUN-06 builds the page that redeems it and runs the WebSDK.
const selfieRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s",
  staticData: { frame: "auth", navId: null, pageName: "Selfie" },
  component: () => <AuthPageStub title="Selfie" />,
});

const routeTree = rootRoute.addChildren([selfieRoute]);

export function createSelfieRouter(context: FinRouterContext<unknown>) {
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
