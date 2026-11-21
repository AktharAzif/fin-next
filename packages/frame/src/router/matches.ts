// Reading the router's state the frame needs: the deepest match's static data, the pathname and
// whether a navigation is pending. Kept apart so the frames and the root read them one way.
import { useMatches, useRouterState } from "@tanstack/react-router";
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

export function useRouteStaticData(): FinStaticData | null {
  return useMatches({ select: (matches) => deepestStaticData(matches) });
}

export function usePathname(): string {
  return useRouterState({ select: (state) => state.location.pathname });
}

/** True while a navigation's loaders run; hover preloads never change it (spec 06 §5.1). */
export function useNavigationPending(): boolean {
  return useRouterState({ select: (state) => state.status === "pending" });
}
