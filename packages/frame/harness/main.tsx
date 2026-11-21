// The frame's browser harness (a test build only, never deployed): the console's boot sequence,
// root and AppFrame from @fin/frame, with routes for what only a browser shows. The entrance across
// a slow navigation, focus and the spoken title, the report seam behind a throwing button, a 401 on
// the route being loaded and the back-forward cache's check. The Playwright spec answers /env.json
// and /api/* itself (e2e/serve.ts); `window.__harness` lets it read what the page did. Like each
// app's stylesheet, it loads boot.css first, which holds the back-forward cache's lock.
import "../boot/boot.css";
import "../src/report/index.ts";
import { type ConsoleViewer, consoleViewer, defineContract, noInput, z } from "@fin/app-contracts";
import { AuthCard, Button, PageHeader } from "@fin/ui";
import { createRootRouteWithContext, createRoute, createRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { FinRoot, guardConsole } from "../src/boot/root.tsx";
import { startApp } from "../src/boot/start.tsx";
import { AppFrame } from "../src/frames/AppFrame.tsx";
import { pendingReports } from "../src/report/report.ts";
import { RouterLink } from "../src/router/RouterLink.tsx";
import type { FinRouterContext } from "../src/runtime/runtime.tsx";
import { RouteError, RouteNotFound, RoutePending } from "../src/states/RouteStates.tsx";

interface Harness {
  /** Each page's mounts and unmounts, in order. */
  mounts: string[];
  pendingReports: () => number;
  /** Lets the slow page's loader finish. */
  releaseSlow: () => void;
}

declare global {
  interface Window {
    __harness?: Harness;
  }
}

let releaseSlow: () => void = () => {};
const harness: Harness = { mounts: [], pendingReports, releaseSlow: () => releaseSlow() };
window.__harness = harness;

const teamList = defineContract({
  name: "team.list",
  method: "GET",
  path: "/team/members",
  input: noInput,
  output: z.object({ members: z.array(z.string()) }),
});

const invitation = defineContract({
  name: "invitation.get",
  method: "GET",
  path: "/invitation",
  input: noInput,
  output: z.object({ organisation: z.string() }),
});

function useMountLog(name: string): void {
  useEffect(() => {
    harness.mounts.push(`mount ${name}`);
    return () => {
      harness.mounts.push(`unmount ${name}`);
    };
  }, [name]);
}

function PageA() {
  useMountLog("A");
  const [note, setNote] = useState("");
  return (
    <>
      <PageHeader title="Page A" linkAs={RouterLink} />
      <label>
        Note
        <input data-testid="note" value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <RouterLink href="/slow">Go to the slow page</RouterLink>
      <RouterLink href="/a?tab=details">Details tab</RouterLink>
      {/* A path below this page's route: the router matches /a, and draws the not-found page. */}
      <RouterLink href="/a/missing">A page below this one</RouterLink>
    </>
  );
}

function SlowPage() {
  useMountLog("Slow");
  return <PageHeader title="Slow page" linkAs={RouterLink} />;
}

function BreakPage() {
  return (
    <>
      <PageHeader title="Break" linkAs={RouterLink} />
      <Button
        onClick={() => {
          // A failure carrying a value a person typed: it must reach the report seam, and the
          // console only reduced.
          throw new TypeError(["nothing for maya.rivera", "example.com"].join("@"));
        }}
      >
        Break it
      </Button>
    </>
  );
}

function createHarnessRouter(context: FinRouterContext<ConsoleViewer>) {
  const rootRoute = createRootRouteWithContext<FinRouterContext<ConsoleViewer>>()({
    beforeLoad: (input) => guardConsole(input),
    component: () => <FinRoot appFrame={AppFrame} fallbackFrame="app" />,
    notFoundComponent: RouteNotFound,
  });
  const app = (path: string, pageName: string) => ({
    getParentRoute: () => rootRoute,
    path,
    staticData: { frame: "app" as const, navId: null, pageName },
  });
  const auth = (path: string, pageName: string) => ({
    getParentRoute: () => rootRoute,
    path,
    staticData: { frame: "auth" as const, navId: null, pageName },
  });
  const routeTree = rootRoute.addChildren([
    createRoute({
      ...app("/", "Home"),
      component: () => <PageHeader title="Home" linkAs={RouterLink} />,
    }),
    createRoute({ ...app("/a", "Page A"), component: PageA }),
    createRoute({
      ...app("/slow", "Slow page"),
      loader: () =>
        new Promise<void>((resolve) => {
          releaseSlow = resolve;
        }),
      component: SlowPage,
    }),
    createRoute({ ...app("/break", "Break"), component: BreakPage }),
    createRoute({
      ...app("/settings/team", "Team"),
      loader: ({ context: route }) => route.fin.api(teamList, {}),
      component: () => <PageHeader title="Team" linkAs={RouterLink} />,
    }),
    createRoute({
      ...auth("/invite", "Invitation"),
      // Invite answers its own 401: a signed-out person sees the invitation's signed-out state.
      loader: ({ context: route }) => route.fin.api(invitation, {}).catch(() => null),
      component: () => (
        <AuthCard title="Invitation">
          <RouterLink href="/settings/team">Open Team</RouterLink>
        </AuthCard>
      ),
    }),
    createRoute({
      ...auth("/sign-in", "Sign in"),
      component: () => (
        <AuthCard title="Sign in to Fin">
          <p>Signed out.</p>
        </AuthCard>
      ),
    }),
  ]);
  return createRouter({
    routeTree,
    context,
    defaultPreload: "intent",
    defaultPendingMs: 1000,
    defaultPendingMinMs: 500,
    defaultViewTransition: false,
    defaultPendingComponent: RoutePending,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
  });
}

void startApp({
  app: "console",
  viewer: consoleViewer,
  fallbackFrame: "app",
  createRouter: createHarnessRouter,
});
