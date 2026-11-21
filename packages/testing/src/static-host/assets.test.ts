import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  contentTypeFor,
  fallbackAsset,
  type Intent,
  readManifest,
  resolveAsset,
} from "./assets.ts";

const FIXTURE = join(import.meta.dirname, "../../test/fixtures/app");
const manifest = readManifest(FIXTURE);

function served(path: string): string {
  const intent: Intent = resolveAsset(manifest, path);
  if (intent.kind === "redirect") return `307 ${intent.location}`;
  if (intent.kind === "none") return "none";
  return `${intent.fallback ? "fallback" : "asset"} ${intent.asset.path}`;
}

describe("readManifest", () => {
  it("lists every file but the deployment's configuration files", () => {
    expect([...manifest.keys()].sort()).toEqual([
      "/about.html",
      "/assets/app.css",
      "/assets/app.js",
      "/assets/app.js.map",
      "/guide/index.html",
      "/index.html",
    ]);
  });

  it("gives each file a content hash ETag and a content type", () => {
    const index = manifest.get("/index.html");
    expect(index?.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(index?.contentType).toBe("text/html; charset=utf-8");
  });

  const scratch = mkdtempSync(join(tmpdir(), "fin-testing-manifest-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("skips symbolic links, so nothing outside the folder is served", () => {
    const root = join(scratch, "root");
    mkdirSync(root);
    writeFileSync(join(scratch, "outside.txt"), "secret-ish");
    writeFileSync(join(root, "index.html"), "<p>x</p>");
    symlinkSync(join(scratch, "outside.txt"), join(root, "link.txt"));
    expect([...readManifest(root).keys()]).toEqual(["/index.html"]);
  });

  it("never descends into a linked folder, inside or outside the root", () => {
    const root = join(scratch, "linked-dirs");
    const outside = join(scratch, "outside-dir");
    mkdirSync(join(root, "assets"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "OUTSIDE");
    writeFileSync(join(root, "index.html"), "<p>x</p>");
    writeFileSync(join(root, "assets", "app.js"), "export {};");
    symlinkSync(outside, join(root, "linked"), "dir");
    symlinkSync(join(root, "assets"), join(root, "assets-again"), "dir");
    expect([...readManifest(root).keys()].sort()).toEqual(["/assets/app.js", "/index.html"]);
  });

  it("serves a root that is itself reached through a link", () => {
    const real = join(scratch, "real-root");
    mkdirSync(join(real, "guide"), { recursive: true });
    writeFileSync(join(real, "index.html"), "<p>x</p>");
    writeFileSync(join(real, "guide", "index.html"), "<p>g</p>");
    symlinkSync(real, join(scratch, "root-link"), "dir");
    expect([...readManifest(join(scratch, "root-link")).keys()].sort()).toEqual([
      "/guide/index.html",
      "/index.html",
    ]);
  });

  it("adds overlay files, which win over the build's", () => {
    const withEnv = readManifest(FIXTURE, { "/env.json": '{"environment":"ci"}' });
    expect(new TextDecoder().decode(withEnv.get("/env.json")?.body)).toBe('{"environment":"ci"}');
    expect(withEnv.get("/env.json")?.contentType).toBe("application/json; charset=utf-8");
    expect(() => readManifest(FIXTURE, { "/_headers": "x" })).toThrow();
    expect(() => readManifest(FIXTURE, { "env.json": "x" })).toThrow();
  });
});

describe("auto-trailing-slash with the single-page fallback", () => {
  it.each([
    ["/", "asset /index.html"],
    ["/index.html", "307 /"],
    ["/index", "307 /"],
    ["/about", "asset /about.html"],
    ["/about.html", "307 /about"],
    ["/about/", "307 /about"],
    ["/guide", "307 /guide/"],
    ["/guide/", "asset /guide/index.html"],
    ["/guide/index.html", "307 /guide/"],
    ["/guide/index", "307 /guide/"],
    ["/guide.html", "307 /guide/"],
    ["/assets/app.js", "asset /assets/app.js"],
    ["/settings/team", "fallback /index.html"],
    ["/assets/missing.js", "fallback /index.html"],
    ["/_headers", "fallback /index.html"],
    ["/api", "fallback /index.html"],
  ])("%s answers %s", (path, answer) => {
    expect(served(path)).toBe(answer);
  });

  it("has nothing to fall back to without an index.html", () => {
    const empty = new Map();
    expect(resolveAsset(empty, "/x")).toEqual({ kind: "none" });
    expect(fallbackAsset(empty)).toEqual({ kind: "none" });
    expect(fallbackAsset(manifest)).toMatchObject({ kind: "asset", fallback: true });
  });
});

describe("contentTypeFor", () => {
  it.each([
    ["/a.js", "text/javascript; charset=utf-8"],
    ["/a.CSS", "text/css; charset=utf-8"],
    ["/a.woff2", "font/woff2"],
    ["/a.svg", "image/svg+xml"],
    ["/site.webmanifest", "application/manifest+json; charset=utf-8"],
    ["/noextension", "application/octet-stream"],
    ["/dir.d/file", "application/octet-stream"],
  ])("%s is %s", (path, type) => {
    expect(contentTypeFor(path)).toBe(type);
  });
});
