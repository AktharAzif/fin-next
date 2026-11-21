// The console's root route (spec 06 §2.5): the guard that decides the first navigation from the
// viewer (spec 06 §2.3 step 4), then FrameSwitch around the page, AppFrame for `app` routes and
// AuthFrame for `auth` routes, and the root StepUp dialog's content (spec 02 §7.5). A signed-in
// person with no membership is given their first organisation before an `app` page draws, unless
// an invitation is waiting for them (spec 02 §5.9). A path no route matches draws the not-found
// page inside AppFrame.
import type { ConsoleViewer } from "@fin/app-contracts";
import {
  AppFrame,
  deepestStaticData,
  FinRoot,
  type FinRouterContext,
  guardConsole,
  RouteNotFound,
  type StepUpContentProps,
} from "@fin/frame";
import { createRootRouteWithContext, redirect } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";
import { ensureOrganisation } from "../auth/after-sign-in.ts";

type GuardInput = Parameters<typeof guardConsole>[0];

/** An `app` page for a signed-in person with no membership: their first organisation first. */
export async function firstOrganisationGate(input: GuardInput): Promise<void> {
  const frame = deepestStaticData(input.matches)?.frame ?? "app";
  if (frame !== "app") return;
  const { fin } = input.context;
  const viewer = fin.viewer.get();
  if (viewer === null || viewer.gate !== "ok" || viewer.memberships.length > 0) return;
  const here = `${input.location.pathname}${input.location.searchStr}`;
  const href = await ensureOrganisation(fin, here);
  if (href === here) return;
  throw redirect({ href, replace: true } as unknown as Parameters<typeof redirect>[0]);
}

// The StepUp dialog and its ceremonies stay out of the first route's bundle (spec 06 §1.5's
// 250 KB): the chunk is fetched once the page has drawn, so it is there before an action asks.
const loadStepUp = () => import("../step-up/StepUpDialog.tsx");
const StepUpDialog = lazy(() => loadStepUp().then((module) => ({ default: module.StepUpDialog })));

function StepUpContent(props: StepUpContentProps) {
  return (
    <Suspense fallback={null}>
      <StepUpDialog {...props} />
    </Suspense>
  );
}

function ConsoleRoot() {
  useEffect(() => {
    const timer = setTimeout(() => {
      loadStepUp().catch(() => {
        // A failed preload is fetched again when a step-up first asks for the dialog.
      });
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  return <FinRoot appFrame={AppFrame} fallbackFrame="app" stepUpContent={StepUpContent} />;
}

export const Route = createRootRouteWithContext<FinRouterContext<ConsoleViewer>>()({
  beforeLoad: async (input): Promise<void> => {
    guardConsole(input);
    await firstOrganisationGate(input);
  },
  component: ConsoleRoot,
  notFoundComponent: RouteNotFound,
});
