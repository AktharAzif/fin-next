// The redirect-target rule of spec 02 §2.3 for Google's `callbackURL`, `errorCallbackURL` and
// `newUserCallbackURL`.
import { describe, expect, it } from "vitest";
import { GOOGLE_RETURN_PAGES, googleReturnUrl, isLocalPath } from "./redirect.ts";

const ORIGIN = "https://console.example.com";
const signIn = GOOGLE_RETURN_PAGES.signIn;

describe("googleReturnUrl", () => {
  it.each([
    ["/sign-in", `${ORIGIN}/sign-in`],
    ["/sign-up", `${ORIGIN}/sign-up`],
    ["/sign-in?via=google", `${ORIGIN}/sign-in?via=google`],
    [
      "/sign-in?via=google&next=%2Fsettings%2Fteam",
      `${ORIGIN}/sign-in?via=google&next=%2Fsettings%2Fteam`,
    ],
    [`${ORIGIN}/sign-in?next=/audit-log`, `${ORIGIN}/sign-in?next=/audit-log`],
  ])("accepts %s", (value, expected) => {
    expect(googleReturnUrl(value, ORIGIN, signIn)).toBe(expected);
  });

  it.each([
    ["another origin", "https://evil.example.org/sign-in"],
    [
      "an origin that only starts like ours",
      "https://console.example.com.evil.example.org/sign-in",
    ],
    ["http instead of https", "http://console.example.com/sign-in"],
    ["a protocol-relative path", "//evil.example.org/sign-in"],
    ["a backslash", "/\\evil.example.org"],
    ["a tab", "/sign-in\t"],
    ["a page outside the flow", "/settings/team"],
    ["the API", "/api/auth/sign-in/social"],
    ["a fragment", "/sign-in#x"],
    ["credentials", "https://user@console.example.com/sign-in"],
    ["an unknown query field", "/sign-in?redirect=/x"],
    ["a via other than google", "/sign-in?via=github"],
    ["a next to another site", "/sign-in?next=https://evil.example.org"],
    ["a protocol-relative next", "/sign-in?next=//evil.example.org"],
    ["an encoded backslash in next", "/sign-in?next=/%5Cevil.example.org"],
    ["a next under /api", "/sign-in?next=/api/viewer"],
    ["two nexts", "/sign-in?next=/a&next=/b"],
    ["an empty value", ""],
    ["a non-string", 42],
    ["something long", `/sign-in?next=/${"a".repeat(3000)}`],
  ])("refuses %s", (_label, value) => {
    expect(googleReturnUrl(value, ORIGIN, signIn)).toBeNull();
  });

  it("keeps a link's targets to Account security", () => {
    expect(googleReturnUrl("/account/security", ORIGIN, GOOGLE_RETURN_PAGES.link)).toBe(
      `${ORIGIN}/account/security`,
    );
    expect(googleReturnUrl("/sign-in", ORIGIN, GOOGLE_RETURN_PAGES.link)).toBeNull();
  });
});

describe("isLocalPath", () => {
  it("accepts an app path and refuses what a browser would read as elsewhere", () => {
    expect(isLocalPath("/settings/team?tab=roles")).toBe(true);
    for (const path of ["//x", "/\\x", "x", "/a b", "/api", "/api/x", "/%0a/x", "/%7f"]) {
      expect(isLocalPath(path), path).toBe(false);
    }
  });
});
