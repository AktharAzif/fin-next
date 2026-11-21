// What each app's `routes/__root.tsx` renders and runs (spec 06 §2.5): the frame switch around the
// outlet, the root StepUp host, and the root's effects: the document title from the route's
// `pageName` (S6-07), focus to the page's <h1> and its title announced after a navigation (S6-17),
// and `data-ready` on <body> once the first route has resolved (FW-C16). The guards run in the root
// route's `beforeLoad`; the back-forward cache's check (FW-C14) is installed by startApp, which
// holds the element the app renders into.
import type { ConsoleViewer, StaffViewer } from "@fin/app-contracts";
import { ReportFailures, Toaster, TooltipProvider } from "@fin/ui";
import { Outlet, redirect } from "@tanstack/react-router";
import { type ComponentType, type ReactNode, useEffect, useRef } from "react";
import { consoleEnvironment } from "../frames/AppFrame.tsx";
import { AuthFrame } from "../frames/AuthFrame.tsx";
import { adminNav } from "../nav/admin/index.ts";
import { filterNav } from "../nav/filter.ts";
import { reportBrowserError } from "../report/report.ts";
import { FrameSwitch } from "../router/FrameSwitch.tsx";
import {
  deepestStaticData,
  type MatchLike,
  useRouterValue,
  useRouteStaticData,
  useSearch,
} from "../router/matches.ts";
import type { FrameKind } from "../router/static-data.ts";
import { documentTitle } from "../router/titles.ts";
import { type FinRouterContext, useFin } from "../runtime/runtime.tsx";
import { useStore } from "../runtime/store.ts";
import { type StepUpContentProps, StepUpHost } from "../step-up/step-up.tsx";
import { adminGate, consoleGate } from "./gates.ts";
import { focusNewPage } from "./page-effects.ts";

interface GuardInput<V> {
  context: FinRouterContext<V>;
  location: { pathname: string; searchStr: string };
  /** The matches being loaded, the not-found marks included: the frame is the page drawn's. */
  matches: readonly MatchLike[];
}

function throwRedirect(href: string | null): void {
  if (href === null) return;
  // An internal href resolves to a client navigation (router-core's resolveRedirect).
  throw redirect({ href, replace: true } as unknown as Parameters<typeof redirect>[0]);
}

/** The console root's `beforeLoad`. */
export function guardConsole(input: GuardInput<ConsoleViewer>): void {
  const frame = deepestStaticData(input.matches)?.frame ?? "app";
  const { fin } = input.context;
  throwRedirect(
    consoleGate(
      fin.viewer.get(),
      frame,
      { pathname: input.location.pathname, search: input.location.searchStr },
      (pathname) => fin.routeExists(pathname),
    ),
  );
}

/** Fin Admin root's `beforeLoad`. */
export function guardAdmin(input: GuardInput<StaffViewer>): void {
  const frame = deepestStaticData(input.matches)?.frame ?? "app";
  throwRedirect(adminGate(input.context.fin.viewer.get(), frame));
}

/**
 * Fin Admin's home, `/` (spec 06 §7.2; S6-25): the first list the staff role can open whose screen
 * exists (Staff on Saturday, Production access once Sunday's screens land). Null when there is none.
 */
export function adminHome(fin: FinRouterContext<StaffViewer>["fin"]): string | null {
  const viewer = fin.viewer.get();
  if (viewer === null || viewer.state !== "ok") return null;
  const permissions = new Set(viewer.permissions);
  const tree = filterNav(adminNav, {
    can: (permission) => permissions.has(permission),
    hasRoute: (path) => fin.routeExists(path),
    environment: "production",
  });
  return [...tree.groups.flatMap((group) => group.items), ...tree.footer][0]?.href ?? null;
}

/** Fin Admin's `/` route `beforeLoad`: on to its home, when the role has one. */
export function guardAdminHome(input: { context: FinRouterContext<StaffViewer> }): void {
  throwRedirect(adminHome(input.context.fin));
}

function useRootEffects(fallbackFrame: FrameKind): void {
  const fin = useFin();
  const staticData = useRouteStaticData();
  const search = useSearch();
  const status = useRouterValue((state) => state.status);
  const resolved = useRouterValue((state) => state.resolvedLocation?.pathname ?? null);
  const viewer = useStore(fin.viewer);
  const firstPath = useRef<string | null>(null);

  // The title, from the page's name, never a record's.
  const frame = staticData?.frame ?? fallbackFrame;
  const pageName = staticData?.pageName ?? "Page not found";
  let environment: "sandbox" | "production" = "sandbox";
  if (fin.app === "console") {
    const consoleViewer = viewer as ConsoleViewer | null;
    const membership =
      consoleViewer !== null && consoleViewer.gate !== "factor_step"
        ? consoleViewer.memberships.find((m) => m.orgId === consoleViewer.currentOrgId)
        : undefined;
    environment = consoleEnvironment(search, membership?.liveStatus === "live");
  }
  const title = documentTitle({ app: fin.app, frame, pageName, environment });
  useEffect(() => {
    document.title = title;
  }, [title]);

  // data-ready once the first route has resolved; on each later new path, focus to the page's <h1>
  // and its title announced once (S6-17). A change of search parameters only never gets here: the
  // resolved pathname is the same.
  useEffect(() => {
    if (status !== "idle" || resolved === null) return;
    if (firstPath.current === null) {
      firstPath.current = resolved;
      document.body.setAttribute("data-ready", "");
      return;
    }
    if (firstPath.current === resolved) return;
    firstPath.current = resolved;
    focusNewPage(document, title);
  }, [status, resolved, title]);
}

export interface FinRootProps {
  /** AppFrame (console), AdminFrame (Fin Admin), or none (verify). */
  appFrame?: ComponentType<{ children: ReactNode }>;
  /** The frame for a path no route matches. */
  fallbackFrame: FrameKind;
  /** The app's StepUp modal content (spec 02 §15), once its lane adds it. */
  stepUpContent?: (props: StepUpContentProps) => ReactNode;
}

/**
 * The app's root: the providers every page shares, mounted once here and never by a page (the
 * report seam for every control that throws, AC-UI-29; tooltips; the toast region), the frame
 * around the outlet, and the root StepUp dialog.
 */
export function FinRoot({ appFrame, fallbackFrame, stepUpContent }: FinRootProps) {
  const fin = useFin();
  useRootEffects(fallbackFrame);
  return (
    <ReportFailures report={reportBrowserError}>
      <TooltipProvider>
        <FrameSwitch
          frames={{ ...(appFrame === undefined ? {} : { app: appFrame }), auth: AuthFrame }}
          fallback={fallbackFrame}
        >
          <Outlet />
        </FrameSwitch>
        <StepUpHost controller={fin.stepUp} content={stepUpContent} />
        <Toaster />
      </TooltipProvider>
    </ReportFailures>
  );
}
