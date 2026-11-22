// Which paths are routes of the app (spec 06 §2.5). The router also matches the route a longer path
// starts with (`/customers/cus_1/zzz` under `/customers/$id`, the rest kept as its `**` parameter)
// and draws the not-found page there. Such a path is no route of the app: it is never kept as a
// sign-in's `next`, never a sidebar item's target and never Fin Admin's home.
import type { AnyRoute, AnyRouter } from "@tanstack/react-router";

/**
 * The route a pathname matches exactly, or undefined. A path below a route is the router's own
 * not-found case (router-core's matchRoutesInternal): a found route whose path is not `/` with the
 * rest of the path left over. The tree match is the router's cached one.
 */
export function exactRoute(
  router: Pick<AnyRouter, "getMatchedRoutes">,
  pathname: string,
): AnyRoute | undefined {
  const [, rawParams, found] = router.getMatchedRoutes(pathname);
  if (found === undefined) return undefined;
  return found.path !== "/" && rawParams["**"] !== undefined ? undefined : found;
}

/**
 * Whether the app has a route for a pathname: an exact match, not the root's catch-all not-found
 * and not a path below a route. A path that does not start with a single `/` is never a route of
 * this app, whatever a splat would match: a browser reads `//host` as another origin.
 */
export function routeMatcher(
  router: Pick<AnyRouter, "getMatchedRoutes">,
): (pathname: string) => boolean {
  return (pathname) =>
    pathname.startsWith("/") &&
    !pathname.startsWith("//") &&
    exactRoute(router, pathname) !== undefined;
}
