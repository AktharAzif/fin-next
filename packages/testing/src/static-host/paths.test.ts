import { describe, expect, it } from "vitest";
import {
  decodeAssetPath,
  encodeAssetPath,
  isApiRoute,
  isSourceMapPath,
  normaliseEdgePath,
  normalisePercentEncoding,
  removeDotSegments,
  splitTarget,
  tunnelMatches,
} from "./paths.ts";

describe("splitTarget", () => {
  it("separates the query and drops a fragment", () => {
    expect(splitTarget("/a/b?x=1&y=2")).toEqual({ path: "/a/b", query: "?x=1&y=2" });
    expect(splitTarget("/a")).toEqual({ path: "/a", query: "" });
    expect(splitTarget("/a?")).toEqual({ path: "/a", query: "?" });
    expect(splitTarget("/a#frag?no")).toEqual({ path: "/a", query: "" });
  });
});

describe("the zone's normalisation (S-01 (g) and (j))", () => {
  it.each([
    ["/", "/"],
    ["/settings/team", "/settings/team"],
    ["/x/../api/ping", "/api/ping"],
    ["//api/ping", "/api/ping"],
    ["/api//ping", "/api/ping"],
    ["\\api\\ping", "/api/ping"],
    ["/%61pi/ping", "/api/ping"],
    ["/./a/./b/", "/a/b/"],
    ["/a/b/..", "/a/"],
    ["/../../etc", "/etc"],
    ["/api/../settings", "/settings"],
    ["/%2e%2e/api/ping", "/api/ping"],
  ])("%s becomes %s", (raw, normalised) => {
    expect(normaliseEdgePath(raw)).toBe(normalised);
  });

  it("keeps an encoded slash encoded and upper-cases it", () => {
    expect(normaliseEdgePath("/api%2fping")).toBe("/api%2Fping");
    expect(isApiRoute(normaliseEdgePath("/api%2Fping"))).toBe(false);
  });

  it("keeps case, so /API/ping is not the API route", () => {
    expect(isApiRoute(normaliseEdgePath("/API/ping"))).toBe(false);
  });

  it("does not treat /api without a slash, or /apix, as the API route", () => {
    expect(isApiRoute("/api")).toBe(false);
    expect(isApiRoute("/apix/y")).toBe(false);
    expect(isApiRoute("/api/")).toBe(true);
  });

  it("decodes only unreserved characters", () => {
    expect(normalisePercentEncoding("/a%7e%20%41")).toBe("/a~%20A");
  });

  it("removes dot segments per RFC 3986 §5.2.4", () => {
    expect(removeDotSegments("/a/b/c/./../../g")).toBe("/a/g");
    expect(removeDotSegments("/mid/content=5/../6")).toBe("/mid/6");
  });
});

describe("the tunnel's own ^/api/ match", () => {
  it("matches the raw path the client sent", () => {
    expect(tunnelMatches("/api/ping")).toBe(true);
    expect(tunnelMatches("/%61pi/ping")).toBe(true);
  });

  it("does not match paths only the zone's normalisation made into /api/", () => {
    expect(tunnelMatches("//api/ping")).toBe(false);
    expect(tunnelMatches("/x/../api/ping")).toBe(false);
  });

  it("does not match a malformed encoding", () => {
    expect(tunnelMatches("/api/%E0%A4%A")).toBe(false);
  });
});

describe("asset paths", () => {
  it("refuses source maps anywhere", () => {
    expect(isSourceMapPath("/assets/app.js.map")).toBe(true);
    expect(isSourceMapPath("/x.map")).toBe(true);
    expect(isSourceMapPath("/assets/map.js")).toBe(false);
  });

  it("decodes each segment and refuses one that decodes to a separator", () => {
    expect(decodeAssetPath("/assets/a%20b.js")).toBe("/assets/a b.js");
    expect(decodeAssetPath("/assets%2Fa.js")).toBeUndefined();
    expect(decodeAssetPath("/a%5Cb")).toBeUndefined();
    expect(decodeAssetPath("/a%00b")).toBeUndefined();
    expect(decodeAssetPath("/bad%E0%A4%A")).toBe("/bad%E0%A4%A");
  });

  it("encodes a redirect's path segment by segment", () => {
    expect(encodeAssetPath("/guide/a b/")).toBe("/guide/a%20b/");
  });
});
