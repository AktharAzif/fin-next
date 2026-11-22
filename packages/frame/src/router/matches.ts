// Reading the router the frame needs: the router itself, the deepest match's static data, the
// location and whether a navigation is pending. The frame serves three apps, each of which
// registers its own router type, so these read the router as AnyRouter whatever the app
// registered: the frame only ever reads what every router has.
import {
  type AnyRouter,
  type RouterState,
  useMatches,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { type FinStaticData, readStaticData } from "./static-data.ts";

/** The fields of a router match the frame reads, whatever router type an app registered. */
export interface MatchLike {
  readonly staticData?: unknown;
  readonly pathname?: unknown;
  readonly search?: unknown;
  readonly status?: unknown;
  readonly _notFound?: unknown;
}

/**
 * Whether a match draws the not-found page: a path no route matches marks the route it falls under
 * (`_notFound`; the root, unless a route on the way has children or its own not-found component),
 * and a loader's `notFound()` marks the route that draws it (`status: "notFound"`).
 */
export function drawsNotFound(match: MatchLike): boolean {
  return match._notFound === true || match.status === "notFound";
}

/**
 * The matches the router draws: all of them, or those up to the first that draws the not-found
 * page. A path below a route (`/customers/cus_1/zzz` under `/customers/$id`) still matches that
 * route, with the root marked as drawing the not-found page in its outlet; the routes past the
 * mark are never drawn, so their path, static data and search parameters say nothing about the
 * page on screen.
 */
export function drawnMatches<M extends MatchLike>(matches: readonly M[]): readonly M[] {
  const end = matches.findIndex(drawsNotFound);
  return end === -1 ? matches : matches.slice(0, end + 1);
}

/**
 * The deepest drawn match that declares Fin's static data, or null: a path no route matches (the
 * root's not-found page, a path below a route included), a redirect. So the frame, the title, the
 * current sidebar item and what the page needs are always the page drawn's.
 */
export function deepestStaticData(matches: readonly MatchLike[]): FinStaticData | null {
  const drawn = drawnMatches(matches);
  for (let index = drawn.length - 1; index >= 0; index--) {
    const data = readStaticData(drawn[index]?.staticData);
    if (data !== null) return data;
  }
  return null;
}

/**
 * The page drawn, as a key for its entrance (spec 06 §5.1): the deepest drawn match's path. It
 * changes when the router draws another route (its page, or that route's pending component), and
 * never while a navigation is only pending: the router moves `state.location` to the new path as
 * the navigation starts, while the page being left is still drawn. Search parameters are not part
 * of it, so `?tab=`, `?view=` and filters never replay the entrance. The not-found page keys apart
 * from the route that draws it (the root's `/` is Home's path too), and alike for any path that
 * route draws it for, a path below one of its routes included: it is the same page.
 */
export function presentedPage(matches: readonly MatchLike[]): string {
  const leaf = drawnMatches(matches).at(-1);
  if (leaf === undefined) return "";
  const pathname = typeof leaf.pathname === "string" ? leaf.pathname : "";
  return drawsNotFound(leaf) ? `${pathname} (not found)` : pathname;
}

/** The app's router, typed as any router. */
export function useAnyRouter(): AnyRouter {
  return useRouter() as unknown as AnyRouter;
}

// The two hooks as the frame calls them: with a select over any router's state, whatever router
// type the app registered (each app's tsc checks this file under its own registration).
const useAnyRouterState = useRouterState as unknown as <T>(options: {
  select: (state: RouterState) => T;
}) => T;
const useAnyMatches = useMatches as unknown as <T>(options: {
  select: (matches: readonly MatchLike[]) => T;
}) => T;

/** A value read from the router's state, re-rendering only when it changes. */
export function useRouterValue<T>(select: (state: RouterState) => T): T {
  return useAnyRouterState({ select });
}

export function useRouteStaticData(): FinStaticData | null {
  return useAnyMatches({ select: deepestStaticData });
}

/**
 * The location's pathname. While a navigation is pending it already names the path being loaded;
 * for the page on screen, use usePresentedPage.
 */
export function usePathname(): string {
  return useRouterValue((state) => state.location.pathname);
}

/** The key of the page drawn (presentedPage), re-rendering only when it changes. */
export function usePresentedPage(): string {
  return useAnyMatches({ select: presentedPage });
}

/** The search parameters of the page drawn: the deepest drawn match's, or none. */
export function presentedSearch(matches: readonly MatchLike[]): unknown {
  return drawnMatches(matches).at(-1)?.search;
}

/**
 * The parsed search parameters of the page drawn (an object of the route's search params). Like
 * the page key, it follows the presented route, not the pending location, so the environment's
 * cues (the Sandbox strip, EnvironmentSwitch, the title) change with the page they describe.
 */
export function useSearch(): unknown {
  return useAnyMatches({ select: presentedSearch });
}

/** True while a navigation's loaders run; hover preloads never change it (spec 06 §5.1). */
export function useNavigationPending(): boolean {
  return useRouterValue((state) => state.status === "pending");
}
