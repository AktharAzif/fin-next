// The frames composed with a real router in memory, rendered to static markup: the root's guard,
// FrameSwitch, AppFrame and AdminFrame with the sidebar filtered by the viewer, and the route states.
import type { ConsoleViewer, StaffViewer } from "@fin/app-contracts";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { FinRoot, guardAdmin, guardConsole, routeMatcher } from "../src/boot/root.tsx";
import { AdminFrame } from "../src/frames/AdminFrame.tsx";
import { AppFrame } from "../src/frames/AppFrame.tsx";
import {
  type FinRouterContext,
  type FinRuntime,
  FinRuntimeProvider,
} from "../src/runtime/runtime.tsx";
import { createStore } from "../src/runtime/store.ts";
import { createViewerStore } from "../src/runtime/viewer.ts";
import { RouteError, RouteNotFound, RoutePending } from "../src/states/RouteStates.tsx";
import { createStepUpController } from "../src/step-up/step-up.tsx";

// The router runs in its browser mode (`isServer: false`) so a guard's redirect is followed as it
// is in the app; it reads only `window.origin` here, with memory history.
beforeAll(() => {
  vi.stubGlobal("window", {
    origin: "https://console.example.com",
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const env = {
  environment: "ci" as const,
  release: "test",
  docsOrigin: "https://docs.example.com",
  consoleOrigin: "https://console.example.com",
};

function runtime<V>(
  app: "console" | "admin",
  viewer: V | null,
  routes: readonly string[] = [],
): FinRuntime<V> {
  const client = createApiClient({ app, fetch: async () => new Response(null, { status: 204 }) });
  return {
    app,
    env,
    api: client.api,
    configureApi: client.configure,
    viewer: createViewerStore<V>(viewer, async () => viewer),
    stepUp: createStepUpController(),
    newRelease: createStore<string | null>(null),
    routeExists: (pathname) => routes.includes(pathname),
  };
}

const maya: ConsoleViewer = {
  gate: "ok",
  user: { id: "usr_1", name: "Maya Rivera", email: "maya@example.com" },
  assurance: "aal2",
  factors: { passkeys: 1, authenticator: false, backupCodesLeft: null },
  canSkipProtect: false,
  canTrustBrowser: true,
  memberships: [
    {
      orgId: "org_1",
      name: "Acme Remit",
      roleKey: "super_admin",
      roleLabel: "Super admin",
      roleKnown: true,
      liveStatus: "sandbox",
    },
  ],
  currentOrgId: "org_1",
  permissions: ["auditLog.read"],
  invitations: [],
};

async function renderConsole(path: string, viewer: ConsoleViewer | null) {
  const fin = runtime<ConsoleViewer>("console", viewer, [
    "/",
    "/audit-log",
    "/sign-in",
    "/settings/team",
  ]);
  const rootRoute = createRootRouteWithContext<FinRouterContext<ConsoleViewer>>()({
    beforeLoad: (input) => guardConsole(input),
    component: () => <FinRoot appFrame={AppFrame} fallbackFrame="app" />,
    notFoundComponent: RouteNotFound,
  });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    staticData: { frame: "app", navId: "home", pageName: "Home" },
    component: () => <h1>Welcome</h1>,
  });
  const auditLog = createRoute({
    getParentRoute: () => rootRoute,
    path: "/audit-log",
    staticData: {
      frame: "app",
      navId: "audit-log",
      pageName: "Audit log",
      needs: ["auditLog.read"],
    },
    component: () => <h1>Audit log</h1>,
  });
  const team = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/team",
    staticData: { frame: "app", navId: "settings", pageName: "Team", needs: ["member.read"] },
    component: () => <h1>Team</h1>,
  });
  const signIn = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sign-in",
    staticData: { frame: "auth", navId: null, pageName: "Sign in" },
    component: () => <h1>Sign in to Fin</h1>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, auditLog, team, signIn]),
    context: { fin },
    history: createMemoryHistory({ initialEntries: [path] }),
    isServer: false,
    defaultPendingComponent: RoutePending,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
  });
  await router.load();
  const html = renderToStaticMarkup(
    <FinRuntimeProvider runtime={fin as FinRuntime}>
      <RouterProvider router={router} />
    </FinRuntimeProvider>,
  );
  return { html, router };
}

describe("the console's root and AppFrame", () => {
  it("draws Home inside the frame with the sidebar the viewer may open", async () => {
    const { html, router } = await renderConsole("/", maya);
    expect(router.state.location.pathname).toBe("/");
    expect(html).toContain('data-app-shell="console"');
    expect(html).toContain('data-strip="sandbox"');
    expect(html).toContain(">Welcome</h1>");
    expect(html).toContain('data-nav-item="home"');
    expect(html).toContain('data-nav-item="audit-log"');
    expect(html).toContain('data-nav-item="api-docs"');
    // Customers has no route yet; Settings' route does not exist in this tree either.
    expect(html).not.toContain('data-nav-item="customers"');
    expect(html).toContain('aria-label="Account menu, Maya Rivera"');
    expect(html).toContain('aria-label="Switch organisation, current: Acme Remit"');
    expect(html).toContain("fin-ico--LockSimple");
    expect(html).toContain("fin-enter");
  });

  it("sends a signed-out viewer to sign-in with a safe next", async () => {
    const { router, html } = await renderConsole("/audit-log", null);
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.searchStr).toBe("?next=%2Faudit-log");
    expect(html).toContain('data-slot="auth-layout"');
    expect(html).toContain(">Sign in to Fin</h1>");
  });

  it("lets a signed-out viewer stay on an auth page", async () => {
    const { router } = await renderConsole("/sign-in", null);
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  it("draws the not-allowed state in the frame when the role lacks the route's needs", async () => {
    const { html } = await renderConsole("/settings/team", maya);
    expect(html).toContain("You can’t open this page");
    expect(html).not.toContain(">Team</h1>");
  });

  it("draws the not-found page inside the frame", async () => {
    const { html } = await renderConsole("/nowhere", maya);
    expect(html).toContain("Page not found");
    expect(html).toContain('data-app-shell="console"');
  });
});

describe("Fin Admin's root and AdminFrame", () => {
  const nadia: StaffViewer = {
    state: "ok",
    staff: { id: "stf_1", email: "nadia.brooks@example.org", roleKey: "admin", roleLabel: "Admin" },
    permissions: ["staff.read"],
    environment: "staging",
  };

  async function renderAdmin(path: string, viewer: StaffViewer | null) {
    const fin = runtime<StaffViewer>("admin", viewer);
    const rootRoute = createRootRouteWithContext<FinRouterContext<StaffViewer>>()({
      beforeLoad: (input) => guardAdmin(input),
      component: () => <FinRoot appFrame={AdminFrame} fallbackFrame="app" />,
    });
    const staff = createRoute({
      getParentRoute: () => rootRoute,
      path: "/staff",
      staticData: { frame: "app", navId: "staff", pageName: "Staff", needs: ["staff.read"] },
      component: () => <h1>Staff</h1>,
    });
    const signIn = createRoute({
      getParentRoute: () => rootRoute,
      path: "/sign-in",
      staticData: { frame: "auth", navId: null, pageName: "Sign in" },
      component: () => <h1>Fin Admin sign in</h1>,
    });
    const factor = createRoute({
      getParentRoute: () => rootRoute,
      path: "/sign-in/factor",
      staticData: { frame: "auth", navId: null, pageName: "Second factor" },
      component: () => <h1>Second factor</h1>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([staff, signIn, factor]),
      context: { fin },
      history: createMemoryHistory({ initialEntries: [path] }),
      isServer: false,
    });
    await router.load();
    const html = renderToStaticMarkup(
      <FinRuntimeProvider runtime={fin as FinRuntime}>
        <RouterProvider router={router} />
      </FinRuntimeProvider>,
    );
    return { html, router, matches: routeMatcher(router) };
  }

  it("draws Staff alone in the Settings group, the deployment badge and the staff menu", async () => {
    const { html, matches } = await renderAdmin("/staff", nadia);
    expect(html).toContain('data-app-shell="admin"');
    expect(html).not.toContain("data-strip");
    expect(html).toContain('data-deployment="staging"');
    expect(html).toContain('data-nav-item="staff"');
    expect(html).toContain(">Settings</p>");
    expect(html).toContain('aria-label="Account menu, nadia.brooks@example.org"');
    expect(html).toContain("top-4");
    expect(matches("/staff")).toBe(true);
    expect(matches("/go-live")).toBe(false);
  });

  it("sends a pending member of staff to the factor step and a signed-out one to sign-in", async () => {
    expect(
      (await renderAdmin("/staff", { state: "pending", email: "a@example.org" })).router.state
        .location.pathname,
    ).toBe("/sign-in/factor");
    expect((await renderAdmin("/staff", null)).router.state.location.pathname).toBe("/sign-in");
  });
});
