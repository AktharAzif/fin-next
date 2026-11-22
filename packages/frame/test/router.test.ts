import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { routeMatcher } from "../src/boot/root.tsx";
import { deepestStaticData } from "../src/router/matches.ts";
import { safeNext, signInHref } from "../src/router/next.ts";
import { isRouterHref } from "../src/router/RouterLink.tsx";
import { readStaticData } from "../src/router/static-data.ts";
import { documentTitle } from "../src/router/titles.ts";

const known = (pathname: string) =>
  ["/", "/settings/team", "/audit-log", "/sign-in"].includes(pathname);

describe("safeNext (FW-C09)", () => {
  it("keeps a path on this app with its query and fragment", () => {
    expect(safeNext("/settings/team?view=invite", known)).toBe("/settings/team?view=invite");
    expect(safeNext("/audit-log#top", known)).toBe("/audit-log#top");
  });

  it("drops anything that could leave the app", () => {
    for (const value of [
      "https://evil.example.com/",
      "//evil.example.com",
      "/\\evil.example.com",
      "\\\\evil.example.com",
      "/%0a/evil",
      " /settings/team",
      "/settings/team\n",
      "javascript:alert(1)",
      "",
      "settings/team",
      "/api/viewer",
      "/api",
      "/nowhere",
      "/".repeat(3000),
    ]) {
      expect(safeNext(value, (path) => path === "/nowhere" || known(path))).toSatisfy(
        (result: string | null) => result === null || result === "/nowhere",
      );
    }
    expect(safeNext("//evil.example.com", known)).toBeNull();
    expect(safeNext("/api/viewer", () => true)).toBeNull();
    expect(safeNext("/unknown", known)).toBeNull();
    expect(safeNext(42, known)).toBeNull();
  });

  it("checks the path after the URL parser has resolved its dot segments", () => {
    // A matcher that accepts every path, as an app with a root catch-all route does: the check on
    // the normalised path is what keeps `next` on this origin.
    const everything = () => true;
    for (const value of [
      "/..//evil.example.com",
      "/a/../..//evil.example.com",
      "/.//evil.example.com",
      "/%2e%2e//evil.example.com",
      "/%2E//evil.example.com",
      "/x/..//evil.example.com/payments/pay_1",
      "/x/./..//evil.example.com?next=1#a",
    ]) {
      expect(safeNext(value, everything), value).toBeNull();
    }
    // Dot segments that stay on the app resolve to the path they name, checked like any other.
    expect(safeNext("/settings/../audit-log", known)).toBe("/audit-log");
    expect(safeNext("/x/../api/viewer", everything)).toBeNull();
    for (const value of ["/settings/team", "/audit-log?view=aud_1#top"]) {
      const next = safeNext(value, everything);
      expect(next).not.toBeNull();
      expect(new URL(next ?? "", "https://console.example.com").origin).toBe(
        "https://console.example.com",
      );
    }
  });

  it("builds the sign-in redirect with the path only", () => {
    expect(signInHref({ pathname: "/settings/team", search: "?view=invite" }, known)).toBe(
      "/sign-in?next=%2Fsettings%2Fteam%3Fview%3Dinvite",
    );
    expect(signInHref({ pathname: "/", search: "" }, known)).toBe("/sign-in");
    expect(signInHref({ pathname: "/unknown", search: "" }, known)).toBe("/sign-in");
  });
});

describe("isRouterHref", () => {
  it("routes the app's own paths only", () => {
    expect(isRouterHref("/settings/team")).toBe(true);
    expect(isRouterHref("/settings/team?view=invite")).toBe(true);
    expect(isRouterHref("/api/health")).toBe(false);
    expect(isRouterHref("/api")).toBe(false);
    expect(isRouterHref("//cdn.example.com/x")).toBe(false);
    expect(isRouterHref("https://docs.example.com/")).toBe(false);
  });

  it("reads the path as the URL parser resolves it", () => {
    expect(isRouterHref("/x/../api/viewer")).toBe(false);
    expect(isRouterHref("/%2e%2e/api")).toBe(false);
    expect(isRouterHref("/..//cdn.example.com/x")).toBe(false);
    expect(isRouterHref("/\\cdn.example.com/x")).toBe(false);
    expect(isRouterHref("/settings/../audit-log")).toBe(true);
  });
});

describe("routeMatcher", () => {
  it("never matches a path that would read as another origin", () => {
    const rootRoute = createRootRoute();
    const splat = createRoute({ getParentRoute: () => rootRoute, path: "$" });
    const router = createRouter({ routeTree: rootRoute.addChildren([splat]) });
    const matches = routeMatcher(router);
    expect(matches("/anything/at/all")).toBe(true);
    expect(matches("//evil.example.com")).toBe(false);
    expect(safeNext("/x/..//evil.example.com", matches)).toBeNull();
  });
});

describe("static data", () => {
  it("reads Fin's fields and refuses half-declared ones", () => {
    expect(readStaticData({ frame: "app", navId: "home", pageName: "Home" })).toEqual({
      frame: "app",
      navId: "home",
      pageName: "Home",
    });
    expect(
      readStaticData({
        frame: "auth",
        navId: null,
        pageName: "Sign in",
        needs: ["x"],
        sandboxOnly: true,
      }),
    ).toEqual({
      frame: "auth",
      navId: null,
      pageName: "Sign in",
      needs: ["x"],
      sandboxOnly: true,
    });
    expect(readStaticData({ frame: "modal", navId: null, pageName: "X" })).toBeNull();
    expect(readStaticData({ frame: "app", pageName: "" })).toBeNull();
    expect(readStaticData(undefined)).toBeNull();
  });

  it("takes the deepest match that declares it", () => {
    expect(
      deepestStaticData([
        { staticData: {} },
        { staticData: { frame: "app", navId: "settings", pageName: "Settings" } },
        { staticData: { frame: "app", navId: "settings", pageName: "Team" } },
      ])?.pageName,
    ).toBe("Team");
    expect(deepestStaticData([{ staticData: {} }])).toBeNull();
  });
});

describe("documentTitle (S6-07)", () => {
  it("prefixes the console's Sandbox pages, never its signed-out ones", () => {
    expect(
      documentTitle({ app: "console", frame: "app", pageName: "Team", environment: "sandbox" }),
    ).toBe("Sandbox · Team · Fin");
    expect(
      documentTitle({ app: "console", frame: "app", pageName: "Team", environment: "production" }),
    ).toBe("Team · Fin");
    expect(documentTitle({ app: "console", frame: "auth", pageName: "Sign in" })).toBe(
      "Sign in · Fin",
    );
  });

  it("names Fin Admin", () => {
    expect(documentTitle({ app: "admin", frame: "app", pageName: "Staff" })).toBe(
      "Staff · Fin Admin",
    );
    expect(documentTitle({ app: "admin", frame: "auth", pageName: "Sign in" })).toBe(
      "Sign in · Fin Admin",
    );
  });
});
