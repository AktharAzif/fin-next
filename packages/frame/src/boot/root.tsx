// What each app's `routes/__root.tsx` renders and runs (spec 06 §2.5): the frame switch around the
// outlet, the root StepUp host, and the root's effects: the document title from the route's
// `pageName` (S6-07), focus to the page's <h1> after a navigation (S6-17), `data-ready` on <body>
// once the first route has resolved (FW-C16), and a check of the session when the page comes back
// from the back-forward cache (FW-C14). The guards run in the root route's `beforeLoad`.
import type { ConsoleViewer, StaffViewer } from "@fin/app-contracts";
import {
  type AnyRouter,
  Outlet,
  redirect,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { type ComponentType, type ReactNode, useEffect, useRef } from "react";
import { consoleEnvironment } from "../frames/AppFrame.tsx";
import { AuthFrame } from "../frames/AuthFrame.tsx";
import { FrameSwitch } from "../router/FrameSwitch.tsx";
import { deepestStaticData, useRouteStaticData } from "../router/matches.ts";
import type { FrameKind } from "../router/static-data.ts";
import { documentTitle } from "../router/titles.ts";
import { type FinRouterContext, useFin } from "../runtime/runtime.tsx";
import { useStore } from "../runtime/store.ts";
import { type StepUpContentProps, StepUpHost } from "../step-up/step-up.tsx";
import { adminGate, consoleGate } from "./gates.ts";

/** Whether the app has a route for a pathname (not counting the root's catch-all not-found). */
export function routeMatcher(
  router: Pick<AnyRouter, "getMatchedRoutes">,
): (pathname: string) => boolean {
  return (pathname) => router.getMatchedRoutes(pathname)[2] !== undefined;
}

interface GuardInput<V> {
  context: FinRouterContext<V>;
  location: { pathname: string; searchStr: string };
  matches: readonly { staticData?: unknown }[];
}

function throwRedirect(href: string | null): void {
  if (href === null) return;
  // An internal href resolves to a client navigation (router-core's resolveRedirect).
  throw redirect({ href, replace: true } as unknown as Parameters<typeof redirect>[0]);
}

/** The console root's `beforeLoad`. */
export function guardConsole(
  input: GuardInput<ConsoleViewer>,
  matches: (pathname: string) => boolean,
): void {
  const frame = deepestStaticData(input.matches)?.frame ?? "app";
  throwRedirect(
    consoleGate(
      input.context.fin.viewer.get(),
      frame,
      { pathname: input.location.pathname, search: input.location.searchStr },
      matches,
    ),
  );
}

/** Fin Admin root's `beforeLoad`. */
export function guardAdmin(input: GuardInput<StaffViewer>): void {
  const frame = deepestStaticData(input.matches)?.frame ?? "app";
  throwRedirect(adminGate(input.context.fin.viewer.get(), frame));
}

function useRootEffects(fallbackFrame: FrameKind): void {
  const fin = useFin();
  const router = useRouter();
  const staticData = useRouteStaticData();
  const search = useRouterState({ select: (state) => state.location.search });
  const status = useRouterState({ select: (state) => state.status });
  const resolved = useRouterState({ select: (state) => state.resolvedLocation?.pathname ?? null });
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

  // data-ready once the first route has resolved; focus to the <h1> on each later new path.
  useEffect(() => {
    if (status !== "idle" || resolved === null) return;
    if (firstPath.current === null) {
      firstPath.current = resolved;
      document.body.setAttribute("data-ready", "");
      return;
    }
    if (firstPath.current === resolved) return;
    firstPath.current = resolved;
    const heading = document.querySelector<HTMLElement>("#main h1");
    heading?.focus({ preventScroll: true });
  }, [status, resolved]);

  // A page restored from the back-forward cache checks the session before anything is used.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      fin.viewer.reload().then(
        () => router.invalidate(),
        () => window.location.reload(),
      );
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [fin, router]);
}

export interface FinRootProps {
  /** AppFrame (console), AdminFrame (Fin Admin), or none (verify). */
  appFrame?: ComponentType<{ children: ReactNode }>;
  /** The frame for a path no route matches. */
  fallbackFrame: FrameKind;
  /** The app's StepUp modal content (spec 02 §15), once its lane adds it. */
  stepUpContent?: (props: StepUpContentProps) => ReactNode;
}

export function FinRoot({ appFrame, fallbackFrame, stepUpContent }: FinRootProps) {
  const fin = useFin();
  useRootEffects(fallbackFrame);
  return (
    <>
      <FrameSwitch
        frames={{ ...(appFrame === undefined ? {} : { app: appFrame }), auth: AuthFrame }}
        fallback={fallbackFrame}
      >
        <Outlet />
      </FrameSwitch>
      <StepUpHost controller={fin.stepUp} content={stepUpContent} />
    </>
  );
}
