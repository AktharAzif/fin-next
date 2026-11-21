// A rendered static artefact on disk: the built files plus the `_headers` and `env.json` that
// `pnpm fin static render` wrote into it (spec 01 §7.4). Read here into the asset manifest
// Cloudflare's upload session takes (SP-26): each file's path, byte size and hash, where the hash
// is the first 32 hex characters of SHA-256 over the file's base64 text followed by its extension.
//
// Refused: links, source maps, any file over Cloudflare's 25 MiB asset limit, more than 20,000
// files, and the control files a Worker deployment would read (`_worker.js`, `_routes.json`,
// `_redirects`); `_headers` is not an asset but the deployment's headers configuration.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, posix, relative, sep } from "node:path";
import { StaticConfigError } from "./config.ts";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 20_000;
const REFUSED_NAMES = new Set(["_worker.js", "_routes.json", "_redirects"]);
/** The files the deploy renders, which the release's built-files hash leaves out. */
export const RENDERED_FILES = new Set(["/_headers", "/env.json"]);

export interface AssetFile {
  /** The URL path, `/index.html`. */
  path: string;
  abs: string;
  size: number;
  hash: string;
  contentType: string;
}

export interface Artefact {
  dir: string;
  files: AssetFile[];
  /** The rendered `_headers`, sent as the deployment's headers configuration. */
  headers: string;
  /** The rendered `env.json`, as text (it is also one of the files). */
  env: string | undefined;
}

const TYPES: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  txt: "text/plain",
  xml: "application/xml",
  webmanifest: "application/manifest+json",
  wasm: "application/wasm",
};

/** SP-26's hash: sha256(base64(content) + extension), first 32 hex characters. */
export function assetHash(content: Buffer, path: string): string {
  const extension = extname(path).slice(1);
  return createHash("sha256")
    .update(content.toString("base64") + extension)
    .digest("hex")
    .slice(0, 32);
}

export function contentTypeOf(path: string): string {
  return TYPES[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";
}

/** Reads a rendered artefact directory. */
export function readArtefact(dir: string): Artefact {
  const files: AssetFile[] = [];
  let headers: string | undefined;
  let env: string | undefined;
  let root: ReturnType<typeof lstatSync> | undefined;
  try {
    root = lstatSync(dir);
  } catch {
    root = undefined;
  }
  if (root === undefined || !root.isDirectory())
    throw new StaticConfigError("no rendered build (run pnpm fin static render)");
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(current, entry.name);
      const stat = lstatSync(abs);
      const path = `/${relative(dir, abs).split(sep).join(posix.sep)}`;
      if (stat.isSymbolicLink())
        throw new StaticConfigError(`${path} is a link; an artefact holds files only`);
      if (stat.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!stat.isFile()) throw new StaticConfigError(`${path} is not a regular file`);
      if (path === "/_headers") {
        headers = readFileSync(abs, "utf8");
        continue;
      }
      if (REFUSED_NAMES.has(entry.name))
        throw new StaticConfigError(`${path} is refused: a deployment has no Worker control file`);
      if (path.endsWith(".map"))
        throw new StaticConfigError(
          `${path} is a source map; maps never reach a static deployment`,
        );
      if (stat.size > MAX_FILE_BYTES)
        throw new StaticConfigError(`${path} is over the 25 MiB asset limit`);
      const content = readFileSync(abs);
      if (path === "/env.json") env = content.toString("utf8");
      files.push({
        path,
        abs,
        size: content.length,
        hash: assetHash(content, path),
        contentType: contentTypeOf(path),
      });
      if (files.length > MAX_FILES)
        throw new StaticConfigError(`the artefact holds more than ${MAX_FILES} files`);
    }
  };
  walk(dir);
  if (headers === undefined)
    throw new StaticConfigError(
      "the artefact has no rendered _headers (run pnpm fin static render)",
    );
  if (!files.some((f) => f.path === "/index.html"))
    throw new StaticConfigError("the artefact has no /index.html");
  return { dir, files, headers, env };
}

/**
 * The checks the upload makes on the two rendered files, which the release's built-files hash leaves
 * out, so a `_headers` or `env.json` changed after the render cannot ride along: `env.json` carries
 * this release and environment, and `_headers` holds a Content-Security-Policy for `/*`, no
 * cross-origin (CORS) header and no line over 2,000 characters. `pnpm fin static deploy` also
 * renders both again and compares them byte for byte; this is the floor the CI entry point keeps.
 */
export function checkRenderedFiles(artefact: Artefact, release: string, environment: string): void {
  if (artefact.env === undefined)
    throw new StaticConfigError(
      "the artefact has no rendered env.json (run pnpm fin static render)",
    );
  let env: unknown;
  try {
    env = JSON.parse(artefact.env);
  } catch {
    throw new StaticConfigError("the rendered env.json is not valid JSON");
  }
  if (typeof env !== "object" || env === null || Array.isArray(env))
    throw new StaticConfigError("the rendered env.json is not an object");
  const record = env as Record<string, unknown>;
  if (record.release !== release)
    throw new StaticConfigError("the rendered env.json does not carry this release");
  if (record.environment !== environment)
    throw new StaticConfigError("the rendered env.json does not carry this environment");
  const lines = artefact.headers.split("\n");
  if (lines.some((line) => line.length > 2000))
    throw new StaticConfigError("a rendered _headers line is over 2,000 characters");
  if (lines.some((line) => /^\s*access-control-/i.test(line)))
    throw new StaticConfigError("the rendered _headers sets a cross-origin (CORS) header");
  let inRoot = false;
  let csp = false;
  for (const line of lines) {
    if (/^\S/.test(line)) inRoot = line.trim() === "/*";
    else if (inRoot && /^\s+content-security-policy:\s*\S/i.test(line)) csp = true;
  }
  if (!csp)
    throw new StaticConfigError("the rendered _headers has no Content-Security-Policy for /*");
}

/** The upload session's manifest: path to hash and size. */
export function uploadManifest(
  files: readonly AssetFile[],
): Record<string, { hash: string; size: number }> {
  return Object.fromEntries(files.map((f) => [f.path, { hash: f.hash, size: f.size }]));
}

/**
 * The hash the release manifest records for a static build (`assetManifestHash`): SHA-256 over the
 * sorted `path hash size` lines of the built files, the rendered `_headers` and `env.json` left out
 * so the same build hashes the same in every environment.
 */
export function assetManifestHash(files: readonly AssetFile[]): string {
  const lines = files
    .filter((f) => !RENDERED_FILES.has(f.path))
    .map((f) => `${f.path} ${f.hash} ${f.size}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
