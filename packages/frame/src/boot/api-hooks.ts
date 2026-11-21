// The frame's reactions to api()'s answers (spec 06 §2.4's table), wired by startApp to the router,
// the viewer and the root StepUp dialog:
//   - `step_up_required` asks the root dialog for a proof (api() re-sends once);
//   - a 401 on a route of the `app` frame clears the viewer and goes to sign-in, keeping a safe
//     `next` (Fin Admin: `/sign-in?ended=1`); on an `auth` route it is the call's own answer;
//   - `second_factor_required` opens the dialog's "Add a second factor first" (with a hold, the
//     console goes to `/welcome/secure`), `fresh_session_required` its "Sign in by email to add a
//     second factor", and `factor_step_required` goes back to the sign-in's factor step;
//   - every `Fin-Release`, an opaque redirect (Fin Admin) and a broken answer go to the frame.
// The frame is the one of the route being loaded, not the one on screen: a loader's call runs
// while the previous page is still drawn, and on a cold load nothing is drawn yet.
import type { AppName } from "@fin/app-contracts";
import type { AnyRouter } from "@tanstack/react-router";
import type { ApiHooks } from "../api/client.ts";
import { deepestStaticData, type MatchLike } from "../router/matches.ts";
import { signInHref } from "../router/next.ts";
import { routeMatcher } from "../router/routes.ts";
import type { FrameKind } from "../router/static-data.ts";
import type { Store } from "../runtime/store.ts";
import type { StepUpController } from "../step-up/step-up.tsx";

/**
 * The frame of the page a pathname draws, from the static data of the matches the router makes for
 * it, deepest first, as FrameSwitch reads them; null when none declares one (a path no route
 * matches, a path below a route included: the router marks where it draws the not-found page).
 */
export function routeFrame(
  router: Pick<AnyRouter, "matchRoutes">,
  pathname: string,
): FrameKind | null {
  const matches: readonly MatchLike[] = router.matchRoutes(pathname);
  return deepestStaticData(matches)?.frame ?? null;
}

export interface FrameApiHooksInput {
  app: AppName;
  router: AnyRouter;
  /** The frame of a path no route matches (`app` for the console and Fin Admin). */
  fallbackFrame: FrameKind;
  viewer: Pick<Store<unknown>, "set">;
  stepUp: StepUpController;
  /** Hears every answer's `Fin-Release` (the release watch). */
  release: (release: string) => void;
  /** Reloads the document (Fin Admin's opaque redirect: Access ended the session). */
  reload: () => void;
  report: NonNullable<ApiHooks["report"]>;
}

export function frameApiHooks(input: FrameApiHooksInput): ApiHooks {
  const { app, router, viewer, stepUp } = input;
  const matches = routeMatcher(router);
  const go = (href: string) => {
    void router.navigate({ href, replace: true });
  };
  return {
    stepUp: (required) => stepUp.request(required),
    unauthenticated: () => {
      // The location being loaded (or the one on screen when no navigation is pending).
      const { pathname, searchStr } = router.latestLocation;
      if ((routeFrame(router, pathname) ?? input.fallbackFrame) !== "app") return;
      viewer.set(null);
      go(
        app === "admin"
          ? "/sign-in?ended=1"
          : signInHref({ pathname, search: searchStr }, matches, { signedOut: true }),
      );
    },
    secondFactorRequired: (hold) => {
      if (hold && app === "console") go("/welcome/secure");
      else stepUp.notify("second_factor_required");
    },
    factorStepRequired: () => go(app === "admin" ? "/sign-in/factor" : "/sign-in/two-factor"),
    freshSessionRequired: () => stepUp.notify("fresh_session_required"),
    release: input.release,
    opaqueRedirect: input.reload,
    report: input.report,
  };
}
