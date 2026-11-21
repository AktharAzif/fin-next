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

/** The deepest match that declares Fin's static data, or null (the root's not-found, a redirect). */
export function deepestStaticData(
  matches: readonly { staticData?: unknown }[],
): FinStaticData | null {
  for (let index = matches.length - 1; index >= 0; index--) {
    const data = readStaticData(matches[index]?.staticData);
    if (data !== null) return data;
  }
  return null;
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
  select: (matches: readonly { staticData?: unknown }[]) => T;
}) => T;

/** A value read from the router's state, re-rendering only when it changes. */
export function useRouterValue<T>(select: (state: RouterState) => T): T {
  return useAnyRouterState({ select });
}

export function useRouteStaticData(): FinStaticData | null {
  return useAnyMatches({ select: deepestStaticData });
}

export function usePathname(): string {
  return useRouterValue((state) => state.location.pathname);
}

/** The parsed search of the current location (an object of the route's search params). */
export function useSearch(): unknown {
  return useRouterValue((state) => state.location.search as unknown);
}

/** True while a navigation's loaders run; hover preloads never change it (spec 06 §5.1). */
export function useNavigationPending(): boolean {
  return useRouterValue((state) => state.status === "pending");
}
