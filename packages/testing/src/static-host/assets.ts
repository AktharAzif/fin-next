// The files of one static deployment and how Cloudflare picks the one to answer with, under the
// invariant every Fin deployment carries (spec 01 §7.4): `html_handling: "auto-trailing-slash"`
// and `not_found_handling: "single-page-application"`.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface Asset {
  readonly path: string;
  readonly body: Uint8Array;
  readonly etag: string;
  readonly contentType: string;
}

export type Manifest = ReadonlyMap<string, Asset>;

/** Files the uploader never sends as assets (they configure the deployment instead). */
const NOT_ASSETS = new Set(["/_headers", "/_redirects", "/.assetsignore"]);

const TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  pdf: "application/pdf",
};

/** The `Content-Type` a deployment sends for a path, by its extension. */
export function contentTypeFor(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  return TYPES[extension] ?? "application/octet-stream";
}

function makeAsset(path: string, body: Uint8Array): Asset {
  const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
  return { path, body, etag, contentType: contentTypeFor(path) };
}

/**
 * Reads every regular file under `root` (symbolic links are skipped, so nothing outside the
 * folder is ever served) and adds `overlay`, which wins over a file of the same path (the harness
 * uses it for the `env.json` the deploy would render).
 */
export function readManifest(
  root: string,
  overlay: Readonly<Record<string, string | Uint8Array>> = {},
): Map<string, Asset> {
  const manifest = new Map<string, Asset>();
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    if (lstatSync(full).isSymbolicLink()) continue;
    const path = `/${relative(root, full).split(sep).join("/")}`;
    if (NOT_ASSETS.has(path)) continue;
    manifest.set(path, makeAsset(path, readFileSync(full)));
  }
  for (const [path, content] of Object.entries(overlay)) {
    if (!path.startsWith("/") || NOT_ASSETS.has(path)) {
      throw new Error(`an overlay path starts with / and is not a configuration file: ${path}`);
    }
    const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
    manifest.set(path, makeAsset(path, body));
  }
  return manifest;
}

export type Intent =
  | { readonly kind: "asset"; readonly asset: Asset; readonly fallback: boolean }
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "none" };

type Exists = (path: string) => Asset | undefined;

function notFound(exists: Exists): Intent {
  const index = exists("/index.html");
  return index === undefined ? { kind: "none" } : { kind: "asset", asset: index, fallback: true };
}

/**
 * Redirects to `destination` only when the file it would serve is `file` itself, and only when
 * `destination` is not an asset of its own.
 */
function safeRedirect(file: string, destination: string, exists: Exists): Intent | undefined {
  if (exists(destination) !== undefined) return undefined;
  const target = resolveWith(destination, exists, true);
  const served = exists(file);
  if (target.kind === "asset" && served !== undefined && target.asset.etag === served.etag) {
    return { kind: "redirect", location: destination };
  }
  return undefined;
}

function resolveWith(pathname: string, exists: Exists, skipRedirects: boolean): Intent {
  const redirect = (file: string, destination: string) =>
    skipRedirects ? undefined : safeRedirect(file, destination, exists);
  const exact = exists(pathname);
  let found: Intent | undefined;
  if (pathname.endsWith("/index")) {
    if (exact !== undefined) return { kind: "asset", asset: exact, fallback: false };
    found =
      redirect(`${pathname}.html`, pathname.slice(0, -"index".length)) ??
      redirect(`${pathname.slice(0, -"/index".length)}.html`, pathname.slice(0, -"/index".length));
    if (found !== undefined) return found;
  } else if (pathname.endsWith("/index.html")) {
    found =
      redirect(pathname, pathname.slice(0, -"index.html".length)) ??
      redirect(
        `${pathname.slice(0, -"/index.html".length)}.html`,
        pathname.slice(0, -"/index.html".length),
      );
    if (found !== undefined) return found;
  } else if (pathname.endsWith("/")) {
    const index = exists(`${pathname}index.html`);
    if (index !== undefined) return { kind: "asset", asset: index, fallback: false };
    found = redirect(`${pathname.slice(0, -1)}.html`, pathname.slice(0, -1));
    if (found !== undefined) return found;
  } else if (pathname.endsWith(".html")) {
    found =
      redirect(pathname, pathname.slice(0, -".html".length)) ??
      redirect(
        `${pathname.slice(0, -".html".length)}/index.html`,
        `${pathname.slice(0, -".html".length)}/`,
      );
    if (found !== undefined) return found;
  }
  if (exact !== undefined) return { kind: "asset", asset: exact, fallback: false };
  const html = exists(`${pathname}.html`);
  if (html !== undefined) return { kind: "asset", asset: html, fallback: false };
  found = redirect(`${pathname}/index.html`, `${pathname}/`);
  if (found !== undefined) return found;
  return notFound(exists);
}

/**
 * What the deployment answers for a decoded path: an asset (with `fallback` set when it is the
 * single-page fallback), a 307 to the canonical path, or nothing (only when there is no
 * index.html at all).
 */
export function resolveAsset(manifest: Manifest, decodedPath: string): Intent {
  const exists: Exists = (path) => manifest.get(path);
  return resolveWith(decodedPath, exists, false);
}

/** The single-page fallback alone, for a path that cannot name any asset. */
export function fallbackAsset(manifest: Manifest): Intent {
  return notFound((path) => manifest.get(path));
}
