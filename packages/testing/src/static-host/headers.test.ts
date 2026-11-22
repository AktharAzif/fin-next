import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyHeaderRules,
  compileHeaders,
  MAX_LINE_LENGTH,
  MAX_RULES,
  parseHeaders,
  parseHeadersStrict,
} from "./headers.ts";

const FIXTURE = readFileSync(join(import.meta.dirname, "../../test/fixtures/app/_headers"), "utf8");

function served(
  text: string,
  path: string,
  initial: Record<string, string> = {},
  host = "app.example.com",
) {
  const headers = new Headers(initial);
  applyHeaderRules(headers, compileHeaders(parseHeadersStrict(text)).match(host, path));
  return headers;
}

describe("parseHeaders", () => {
  it("reads the app profile of spec 01 §7.4 with no issue", () => {
    const { rules, issues } = parseHeaders(FIXTURE);
    expect(issues).toEqual([]);
    expect(rules.map((r) => r.pattern)).toEqual(["/*", "/assets/*"]);
    expect(rules[0]?.set.map(([name]) => name)).toContain("content-security-policy");
    expect(rules[1]?.unset).toEqual(["cache-control"]);
  });

  it("skips comments and blank lines, lower-cases names and keeps values whole", () => {
    const { rules } = parseHeaders("# c\n\n/a\n  X-Thing: a: b : c\n");
    expect(rules).toEqual([{ pattern: "/a", line: 3, set: [["x-thing", "a: b : c"]], unset: [] }]);
  });

  it("does not need indentation, as Cloudflare's parser does not", () => {
    expect(parseHeaders("/a\nX-A: 1\n").rules[0]?.set).toEqual([["x-a", "1"]]);
  });

  it("joins a header named twice in one rule", () => {
    expect(parseHeaders("/a\n X-A: 1\n x-a: 2\n").rules[0]?.set).toEqual([["x-a", "1, 2"]]);
  });

  it("accepts absolute https patterns", () => {
    expect(parseHeaders("https://app.example.com/*\n X-A: 1\n").issues).toEqual([]);
  });

  it.each([
    ["X-A: 1\n", 1, "a header comes after a URL pattern"],
    ["/a\n", 1, "a rule sets or detaches at least one header"],
    ["/a\n Not A Header\n", 2, "a header line is `Name: value`"],
    ["/a\n Bad Name: 1\n", 2, "a header name is one token with no spaces"],
    ["/a\n X-A:\n", 2, "a header has a value"],
    ["/a\n !\n", 2, "a detach line is `! Header-Name`"],
    ["/a/*/b/*\n X-A: 1\n", 1, "a URL pattern holds at most one *"],
    ["//a\n X-A: 1\n", 1, "a path pattern starts with exactly one /"],
    ["https://app.example.com:8443/a\n X-A: 1\n", 1, "an absolute URL pattern names no port"],
  ])("refuses %j at line %i", (text, line, message) => {
    expect(parseHeaders(text).issues).toContainEqual({ line, message });
    expect(() => parseHeadersStrict(text)).toThrow(message);
  });

  it("refuses more than 100 rules and over-long lines", () => {
    const many = Array.from({ length: MAX_RULES + 1 }, (_, i) => `/r${i}\n X-A: 1`).join("\n");
    expect(parseHeaders(many).rules).toHaveLength(MAX_RULES);
    expect(parseHeaders(many).issues).toHaveLength(1);
    const long = `/a\n X-A: ${"v".repeat(MAX_LINE_LENGTH)}\n`;
    expect(parseHeaders(long).issues[0]?.message).toContain("at most 2000 characters");
  });
});

describe("matching", () => {
  it("matches a splat across slashes and fills :splat", () => {
    const matcher = compileHeaders(parseHeadersStrict("/files/*\n X-From: /static/:splat\n"));
    expect(matcher.match("h", "/files/a/b.txt")[0]?.set).toEqual([["x-from", "/static/a/b.txt"]]);
    expect(matcher.match("h", "/files")).toEqual([]);
  });

  it("matches a placeholder within one segment", () => {
    const matcher = compileHeaders(parseHeadersStrict("/blog/:post/\n X-Post: :post\n"));
    expect(matcher.match("h", "/blog/hello/")[0]?.set).toEqual([["x-post", "hello"]]);
    expect(matcher.match("h", "/blog/a/b/")).toEqual([]);
  });

  it("matches an absolute pattern against the request's host, a placeholder within one label", () => {
    const matcher = compileHeaders(
      parseHeadersStrict("https://:sub.example.com/*\n X-Sub: :sub\n/only-path\n X-B: 1\n"),
    );
    expect(matcher.match("console.example.com", "/x")[0]?.set).toEqual([["x-sub", "console"]]);
    expect(matcher.match("a.b.example.com", "/x")).toEqual([]);
    expect(matcher.match("other.example.org", "/x")).toEqual([]);
  });

  it("treats regular-expression characters literally", () => {
    const matcher = compileHeaders(parseHeadersStrict("/a.b(c)\n X-A: 1\n"));
    expect(matcher.match("h", "/a.b(c)")).toHaveLength(1);
    expect(matcher.match("h", "/aXb(c)")).toEqual([]);
  });

  it("refuses a pattern that uses one placeholder twice", () => {
    expect(() => compileHeaders(parseHeadersStrict("/:a/:a\n X-A: 1\n"))).toThrow("_headers:1");
  });
});

describe("applying rules as Cloudflare does", () => {
  it("replaces the answer's own value the first time a rule names a header", () => {
    const headers = served(FIXTURE, "/", { "cache-control": "public, max-age=0, must-revalidate" });
    expect(headers.get("cache-control")).toBe("no-cache");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("detaches with ! so an asset carries the immutable value exactly once (SP-26)", () => {
    const headers = served(FIXTURE, "/assets/app.js", { "cache-control": "public, max-age=0" });
    expect(headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("joins a later rule's value when nothing detaches it", () => {
    const text = "/*\n Cache-Control: no-cache\n/assets/*\n Cache-Control: immutable\n";
    expect(served(text, "/assets/a.js").get("cache-control")).toBe("no-cache, immutable");
  });

  it("removes a header an earlier rule set when a later one only detaches it", () => {
    const text = "/*\n X-Robots-Tag: noindex\n/public/*\n ! X-Robots-Tag\n";
    expect(served(text, "/public/a").has("x-robots-tag")).toBe(false);
    expect(served(text, "/private/a").get("x-robots-tag")).toBe("noindex");
  });

  it("applies rules in file order", () => {
    const text = "/a/*\n ! X-A\n/*\n X-A: later\n";
    expect(served(text, "/a/b").get("x-a")).toBe("later");
  });
});
