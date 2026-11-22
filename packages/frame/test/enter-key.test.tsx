// What the frames key the page's entrance by (spec 06 §5.1: Enter remounts on a new path, and the
// entrance belongs to the new page). The router moves `state.location` to the new path as soon as a
// navigation starts, while the page being left is still drawn; the key must follow the page drawn.
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  presentedPage,
  presentedSearch,
  usePathname,
  usePresentedPage,
  useRouteStaticData,
  useSearch,
} from "../src/router/matches.ts";

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

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !check(); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}

/** A page that prints the readings, so static markup shows what each hook returns. */
function Readings() {
  const staticData = useRouteStaticData();
  return (
    <p
      data-page={usePresentedPage()}
      data-location={usePathname()}
      data-search={JSON.stringify(useSearch())}
      data-name={staticData?.pageName ?? "none"}
      data-nav={staticData?.navId ?? "none"}
      data-needs={(staticData?.needs ?? []).join(",")}
    />
  );
}

function app(initial: string) {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rootRoute = createRootRoute();
  const page = (path: string, loader?: () => Promise<void>) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      staticData: { frame: "app", navId: path, pageName: `Page ${path}`, needs: [`${path}.read`] },
      ...(loader === undefined ? {} : { loader }),
    });
  // A route with a child of its own: a path below the child is drawn in this route's outlet.
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    staticData: { frame: "app", navId: "settings", pageName: "Settings" },
  });
  const team = createRoute({
    getParentRoute: () => settings,
    path: "/team",
    staticData: { frame: "app", navId: "team", pageName: "Team", needs: ["member.read"] },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      page("/"),
      page("/a"),
      page("/b", () => held),
      page("/customers/$id"),
      settings.addChildren([team]),
    ]),
    history: createMemoryHistory({ initialEntries: [initial] }),
    isServer: false,
  }) as unknown as AnyRouter;
  // The router in context without RouterProvider's transitioner, which only a live root drives:
  // the hooks read the same stores the frames read.
  const render = () =>
    renderToStaticMarkup(
      <RouterContextProvider router={router}>
        <Readings />
      </RouterContextProvider>,
    );
  return { router, release: () => release(), render };
}

describe("the page key (spec 06 §5.1)", () => {
  it("stays on the page being left while a navigation is pending", async () => {
    const { router, release, render } = app("/a");
    await router.load();
    expect(presentedPage(router.state.matches)).toBe("/a");

    const navigation = router.navigate({ href: "/b" });
    await until(() => router.state.status === "pending" && router.state.location.pathname === "/b");
    // The location already names /b; the page drawn, and its key, are still /a's.
    expect(presentedPage(router.state.matches)).toBe("/a");
    expect(render()).toContain('data-page="/a" data-location="/b"');

    release();
    await navigation;
    await until(() => router.state.status === "idle");
    expect(presentedPage(router.state.matches)).toBe("/b");
    expect(render()).toContain('data-page="/b" data-location="/b"');
  });

  it("changes with the path only: never with search parameters", async () => {
    const { router } = app("/customers/cus_1");
    await router.load();
    expect(presentedPage(router.state.matches)).toBe("/customers/cus_1");
    await router.navigate({ href: "/customers/cus_1?tab=money&view=trf_1" });
    expect(presentedPage(router.state.matches)).toBe("/customers/cus_1");
    await router.navigate({ href: "/customers/cus_2" });
    expect(presentedPage(router.state.matches)).toBe("/customers/cus_2");
  });

  it("keys the not-found page apart from Home, and the same for any unknown path", async () => {
    const { router } = app("/");
    await router.load();
    const home = presentedPage(router.state.matches);
    expect(home).toBe("/");
    await router.navigate({ href: "/nowhere" });
    const notFound = presentedPage(router.state.matches);
    expect(notFound).not.toBe(home);
    await router.navigate({ href: "/elsewhere/entirely" });
    expect(presentedPage(router.state.matches)).toBe(notFound);
  });

  it("keys a path below a route as the not-found page, never as that route", async () => {
    // The router still matches the route a path starts with, and marks the root as drawing the
    // not-found page in its outlet: the route below the mark is never drawn.
    const { router, render } = app("/customers/cus_1");
    await router.load();
    expect(presentedPage(router.state.matches)).toBe("/customers/cus_1");
    await router.navigate({ href: "/nowhere" });
    const notFound = presentedPage(router.state.matches);
    for (const href of ["/customers/cus_1/zzz", "/a/zzz", "/a/b/c", "/customers/cus_1/zzz?x=1"]) {
      await router.navigate({ href });
      expect(presentedPage(router.state.matches), href).toBe(notFound);
      // Neither that route's name for the title, nor its sidebar item, nor what it needs.
      expect(render(), href).toContain('data-name="none" data-nav="none" data-needs=""');
    }
    expect(notFound).not.toBe("/customers/cus_1");
    expect(notFound).not.toBe("/a");
  });

  it("keys a path below a nested route as the not-found page its parent route draws", async () => {
    const { router, render } = app("/settings/team");
    await router.load();
    expect(presentedPage(router.state.matches)).toBe("/settings/team");
    expect(render()).toContain('data-name="Team" data-nav="team" data-needs="member.read"');
    await router.navigate({ href: "/settings/team/extra" });
    const below = presentedPage(router.state.matches);
    expect(below).not.toBe("/settings/team");
    // The settings route is drawn, with the not-found page in its outlet; Team is not.
    expect(render()).toContain('data-name="Settings" data-nav="settings" data-needs=""');
    await router.navigate({ href: "/settings/elsewhere" });
    expect(presentedPage(router.state.matches)).toBe(below);
  });

  it("is empty before anything is drawn", () => {
    expect(presentedPage([])).toBe("");
  });
});

describe("the frame's search parameters", () => {
  it("are the page drawn's, so the environment's cues change with the page, never before it", async () => {
    // Production to Sandbox: until Sandbox's page is drawn, the page on screen is Production's, and
    // the strip, the switch and the title must keep saying so.
    const { router, release, render } = app("/a?env=production");
    await router.load();
    expect(render()).toContain('data-search="{&quot;env&quot;:&quot;production&quot;}"');
    const navigation = router.navigate({ href: "/b" });
    await until(() => router.state.status === "pending" && router.state.location.pathname === "/b");
    expect(router.state.location.search).toEqual({});
    expect(render()).toContain('data-search="{&quot;env&quot;:&quot;production&quot;}"');
    release();
    await navigation;
    await until(() => router.state.status === "idle");
    expect(render()).toContain('data-search="{}"');
  });

  it("are the not-found page's on a path below a route, never that route's", () => {
    expect(
      presentedSearch([
        { search: { env: "production" }, _notFound: true },
        { search: { env: "production", tab: "overview" } },
      ]),
    ).toEqual({ env: "production" });
    expect(presentedSearch([{ search: {} }, { search: { tab: "overview" } }])).toEqual({
      tab: "overview",
    });
  });
});
