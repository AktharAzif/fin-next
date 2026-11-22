// The frame's reactions to api()'s answers (spec 06 §2.4), as startApp wires them, against a real
// router in memory: a 401 on an `app` route goes to sign-in even while the previous (auth) page is
// still on screen, a 401 on an `auth` route stays the page's own answer, and the gates that need a
// factor open the root StepUp dialog's notices.
import {
  type ConsoleViewer,
  defineContract,
  noInput,
  type StaffViewer,
  z,
} from "@fin/app-contracts";
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { frameApiHooks } from "../src/boot/api-hooks.ts";
import { guardAdmin, guardConsole } from "../src/boot/root.tsx";
import type { FinRouterContext, FinRuntime } from "../src/runtime/runtime.tsx";
import { createStore } from "../src/runtime/store.ts";
import { createViewerStore } from "../src/runtime/viewer.ts";
import { createStepUpController } from "../src/step-up/step-up.tsx";

// The router runs in its browser mode, as in the app; with memory history it reads only
// `window.origin`.
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

const env = {
  environment: "ci" as const,
  release: "test",
  docsOrigin: "https://docs.example.com",
  consoleOrigin: "https://console.example.com",
};

function problem(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ type: "about:blank", title: code, status, code, ...extra }),
    { status, headers: { "Content-Type": "application/problem+json" } },
  );
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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
  permissions: [],
  invitations: [],
};

type Answers = Record<string, () => Response>;

/** The console's routes with the frame's guard, and api() wired as startApp wires it. */
function consoleApp(path: string, answers: Answers) {
  const stepUp = createStepUpController();
  const client = createApiClient({
    app: "console",
    fetch: (async (url: string | URL | Request) => {
      const answer = answers[String(url)];
      if (answer === undefined) throw new TypeError(`no answer for ${String(url)}`);
      return answer();
    }) as typeof fetch,
  });
  const routes: string[] = [];
  // A viewer still held from before: the session has ended on the server since.
  const viewer = createViewerStore<ConsoleViewer>(maya, async () => null);
  const fin: FinRuntime<ConsoleViewer> = {
    app: "console",
    env,
    api: client.api,
    configureApi: client.configure,
    viewer,
    stepUp,
    newRelease: createStore<string | null>(null),
    routeExists: (pathname) => routes.includes(pathname),
  };
  const rootRoute = createRootRouteWithContext<FinRouterContext<ConsoleViewer>>()({
    beforeLoad: (input) => guardConsole(input),
  });
  const page = (
    routePath: string,
    frame: "app" | "auth",
    loader?: (fin: FinRuntime<ConsoleViewer>) => Promise<unknown>,
  ) => {
    routes.push(routePath);
    return createRoute({
      getParentRoute: () => rootRoute,
      path: routePath,
      staticData: { frame, navId: null, pageName: routePath },
      ...(loader === undefined ? {} : { loader: ({ context }) => loader(context.fin) }),
    });
  };
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      page("/", "app"),
      page("/settings/team", "app", (f) => f.api(teamList, {})),
      // Invite answers a 401 itself: a signed-out person sees the invitation's own state.
      page("/invite", "auth", (f) => f.api(invitation, {}).catch(() => null)),
      page("/sign-in", "auth"),
      page("/sign-in/two-factor", "auth"),
      page("/welcome/secure", "auth"),
    ]),
    context: { fin },
    history: createMemoryHistory({ initialEntries: [path] }),
    isServer: false,
  });
  client.configure(
    frameApiHooks({
      app: "console",
      router: router as unknown as AnyRouter,
      fallbackFrame: "app",
      viewer,
      stepUp,
      release: () => {},
      reload: () => {},
      report: () => {},
    }),
  );
  return { router, fin, stepUp };
}

/** Waits until the router has settled on `pathname`, or fails with where it is instead. */
async function settlesOn(router: AnyRouter, pathname: string): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    if (router.state.status === "idle" && router.state.location.pathname === pathname) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(router.state.location.pathname).toBe(pathname);
  expect(router.state.status).toBe("idle");
}

describe("a 401 (spec 06 §2.4)", () => {
  it("on an app route reached from an auth page, goes to sign-in with the path kept", async () => {
    const { router, fin } = consoleApp("/invite", {
      "/api/invitation": () => problem(401, "unauthenticated"),
      "/api/team/members": () => problem(401, "unauthenticated"),
    });
    await router.load();
    expect(router.state.location.pathname).toBe("/invite");
    // The auth page is on screen while the app route's loader runs and meets the 401.
    void router.navigate({ href: "/settings/team?view=invite" });
    await settlesOn(router as unknown as AnyRouter, "/sign-in");
    expect(router.state.location.searchStr).toBe(
      "?next=%2Fsettings%2Fteam%3Fview%3Dinvite&error=signed_out",
    );
    expect(fin.viewer.get()).toBeNull();
  });

  it("on an auth route reached from an app page, stays the page's own answer", async () => {
    const { router, fin } = consoleApp("/settings/team", {
      "/api/team/members": () => ok({ members: [] }),
      "/api/invitation": () => problem(401, "unauthenticated"),
    });
    await router.load();
    expect(router.state.location.pathname).toBe("/settings/team");
    // The app page is on screen while the auth route's loader meets its expected 401.
    void router.navigate({ href: "/invite" });
    await settlesOn(router as unknown as AnyRouter, "/invite");
    expect(fin.viewer.get()).toEqual(maya);
  });

  it("on the app route on screen, goes to sign-in", async () => {
    const answers: Answers = { "/api/team/members": () => ok({ members: [] }) };
    const { router, fin } = consoleApp("/settings/team", answers);
    await router.load();
    answers["/api/team/members"] = () => problem(401, "unauthenticated");
    await fin.api(teamList, {}).catch(() => null);
    await settlesOn(router as unknown as AnyRouter, "/sign-in");
    expect(router.state.location.searchStr).toBe("?next=%2Fsettings%2Fteam&error=signed_out");
  });

  it("on Fin Admin, goes to its sign-in saying the session ended", async () => {
    const stepUp = createStepUpController();
    const client = createApiClient({
      app: "admin",
      fetch: (async () => problem(401, "unauthenticated")) as typeof fetch,
    });
    const staff: StaffViewer = {
      state: "ok",
      staff: { id: "stf_1", email: "a@example.org", roleKey: "admin", roleLabel: "Admin" },
      permissions: [],
      environment: "staging",
    };
    const viewer = createViewerStore<StaffViewer>(staff, async () => null);
    const fin: FinRuntime<StaffViewer> = {
      app: "admin",
      env,
      api: client.api,
      configureApi: client.configure,
      viewer,
      stepUp,
      newRelease: createStore<string | null>(null),
      routeExists: () => true,
    };
    const rootRoute = createRootRouteWithContext<FinRouterContext<StaffViewer>>()({
      beforeLoad: (input) => guardAdmin(input),
    });
    const staffRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/staff",
      staticData: { frame: "app", navId: "staff", pageName: "Staff" },
    });
    const signIn = createRoute({
      getParentRoute: () => rootRoute,
      path: "/sign-in",
      staticData: { frame: "auth", navId: null, pageName: "Sign in" },
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([staffRoute, signIn]),
      context: { fin },
      history: createMemoryHistory({ initialEntries: ["/staff"] }),
      isServer: false,
    });
    client.configure(
      frameApiHooks({
        app: "admin",
        router: router as unknown as AnyRouter,
        fallbackFrame: "app",
        viewer,
        stepUp,
        release: () => {},
        reload: () => {},
        report: () => {},
      }),
    );
    await router.load();
    await fin.api(teamList, {}).catch(() => null);
    await settlesOn(router as unknown as AnyRouter, "/sign-in");
    expect(router.state.location.searchStr).toBe("?ended=1");
    expect(viewer.get()).toBeNull();
  });
});

describe("the gates that need a factor (spec 06 §2.4, spec 02 §7.5)", () => {
  it("open the root dialog's notices, or send a held person to Protect your account", async () => {
    const answers: Answers = {};
    const { router, fin, stepUp } = consoleApp("/", answers);
    await router.load();
    stepUp.attach(true);

    answers["/api/team/members"] = () => problem(403, "second_factor_required");
    await fin.api(teamList, {}).catch(() => null);
    expect(stepUp.state.get()).toEqual({ kind: "notice", notice: "second_factor_required" });
    stepUp.cancel();

    answers["/api/team/members"] = () => problem(403, "fresh_session_required");
    await fin.api(teamList, {}).catch(() => null);
    expect(stepUp.state.get()).toEqual({ kind: "notice", notice: "fresh_session_required" });
    stepUp.cancel();

    answers["/api/team/members"] = () => problem(403, "second_factor_required", { hold: true });
    await fin.api(teamList, {}).catch(() => null);
    expect(stepUp.state.get()).toBeNull();
    await settlesOn(router as unknown as AnyRouter, "/welcome/secure");

    answers["/api/team/members"] = () => problem(403, "factor_step_required");
    await fin.api(teamList, {}).catch(() => null);
    await settlesOn(router as unknown as AnyRouter, "/sign-in/two-factor");
  });
});
