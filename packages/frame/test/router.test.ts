import { describe, expect, it } from "vitest";
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
