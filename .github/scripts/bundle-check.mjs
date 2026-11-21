#!/usr/bin/env node
// The build job's bundle checks (spec 01 §5.3; ARCHITECTURE §3.5, §11.2; FW-C04, FW-C05). A
// control path. After `turbo run build`, over every app under apps/:
//   server bundles (apps/<app>/dist/server/**), the release target CI builds by default
//     - no test seam in the JavaScript (ARCHITECTURE §3.5: CI greps the release bundles for the
//       seams' markers): the build-target define left unreplaced (`__FIN_BUILD_TARGET__`), the
//       `fin:test-seam` marker a seam module carries, a `//#region` of packages/testing (the
//       harness bundled in), or an import of @fin/testing left in;
//     - no packages/testing source in a map's `sources` (its sourcesContent, the original text
//       with its comments, is not read);
//   static builds (apps/<app>/dist/static/**)
//     - no source map left (`*.map`, or a `sourceMappingURL` comment pointing at one);
//     - no third-party origin in a built HTML, CSS, JavaScript, JSON, SVG or manifest file: every
//       absolute http(s) URL's origin is on ALLOWED_ORIGINS, the namespace and message URLs the
//       pinned libraries carry, none of which is fetched; the app's own API is same-origin and
//       relative, and environment values arrive at deploy in env.json (S0-05);
//     - no `_headers` or `env.json` (the deploy renders them, SF-05);
//   and no link anywhere. The built index.html's inline scripts, handlers and the rest of FW-C04
// are scripts/static-check.mjs's, which the build job runs next. While no app has been built, the
// check passes with a notice.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { annotate, clean, say } from "./lib/ci.mjs";

/** @typedef {{ file: string, rule: string, message: string }} Finding */

/** Seam markers in a bundle's JavaScript. */
export const SEAM_MARKERS = [
  { pattern: /\b__FIN_BUILD_TARGET__\b/, what: "the build target was not compiled in" },
  { pattern: /fin:test-seam/, what: "a test seam's marker" },
  {
    pattern: /^\/\/#region\s+\S*packages\/testing\//m,
    what: "the test harness (packages/testing) is bundled",
  },
  {
    pattern: /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']@fin\/testing(?:\/[^"']*)?["']/,
    what: "the test harness (@fin/testing) is imported",
  },
];

/**
 * Origins a static build may name: XML namespaces (never fetched), React's error-decoder links
 * in its messages, TanStack Router's documentation links in its warnings, and the placeholder
 * origin TanStack Router parses relative URLs against. Each new one is a reviewed change here.
 */
export const ALLOWED_ORIGINS = new Set([
  "http://www.w3.org",
  "https://www.w3.org",
  "https://react.dev",
  "https://tanstack.com",
  "http://localhost",
]);

const SERVER_FILES = new Set([".js", ".mjs", ".cjs", ".map"]);
const STATIC_TEXT_FILES = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".svg",
  ".webmanifest",
  ".txt",
  ".xml",
]);
const URL = /\bhttps?:\/\/[A-Za-z0-9.-]+(?::\d+)?/g;
const MAX_FILES = 50_000;

/**
 * Every file under a directory, as paths relative to it with `/` separators. Links are returned
 * as findings, never followed.
 * @param {string} dir
 * @returns {{ files: string[], links: string[] }}
 */
export function listFiles(dir) {
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const links = [];
  /** @param {string} current */
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      const rel = relative(dir, abs).split(sep).join("/");
      if (lstatSync(abs).isSymbolicLink()) links.push(rel);
      else if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) files.push(rel);
      if (files.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} files under ${dir}`);
    }
  };
  visit(dir);
  return { files: files.sort(), links: links.sort() };
}

/**
 * The origins named in a text.
 * @param {string} text
 * @returns {string[]}
 */
export function originsIn(text) {
  return [...new Set([...text.matchAll(URL)].map((m) => m[0].toLowerCase()))];
}

/**
 * Checks one app's server bundle directory.
 * @param {string} label e.g. apps/api/dist/server
 * @param {string} dir
 * @returns {Finding[]}
 */
export function checkServer(label, dir) {
  /** @type {Finding[]} */
  const findings = [];
  const { files, links } = listFiles(dir);
  for (const link of links) {
    findings.push({ file: `${label}/${link}`, rule: "link", message: "a link in a bundle" });
  }
  for (const file of files) {
    if (!SERVER_FILES.has(extname(file))) continue;
    const text = readFileSync(join(dir, file), "utf8");
    if (file.endsWith(".map")) {
      // A map's sources name every module bundled; its sourcesContent is the original text, whose
      // comments may name anything, so only the paths are read.
      const sources = mapSources(text);
      if (sources === null) {
        findings.push({ file: `${label}/${file}`, rule: "map", message: "a map that is not JSON" });
      } else if (sources.some((s) => s.includes("packages/testing/"))) {
        findings.push({
          file: `${label}/${file}`,
          rule: "seam",
          message: "the test harness (packages/testing) is bundled",
        });
      }
      continue;
    }
    for (const marker of SEAM_MARKERS) {
      if (marker.pattern.test(text)) {
        findings.push({ file: `${label}/${file}`, rule: "seam", message: marker.what });
      }
    }
  }
  return findings;
}

/**
 * The `sources` of a source map, or null when the text is not one.
 * @param {string} text
 * @returns {string[] | null}
 */
export function mapSources(text) {
  try {
    const map = JSON.parse(text);
    if (typeof map !== "object" || map === null || !Array.isArray(map.sources)) return null;
    return map.sources.filter((/** @type {unknown} */ s) => typeof s === "string");
  } catch {
    return null;
  }
}

/**
 * Checks one app's static build directory.
 * @param {string} label e.g. apps/console/dist/static
 * @param {string} dir
 * @returns {Finding[]}
 */
export function checkStatic(label, dir) {
  /** @type {Finding[]} */
  const findings = [];
  const { files, links } = listFiles(dir);
  for (const link of links) {
    findings.push({ file: `${label}/${link}`, rule: "link", message: "a link in a static build" });
  }
  for (const file of files) {
    const name = file.split("/").pop() ?? "";
    if (file.endsWith(".map")) {
      findings.push({ file: `${label}/${file}`, rule: "source-map", message: "a source map left" });
      continue;
    }
    if (name === "_headers" || name === "env.json") {
      findings.push({
        file: `${label}/${file}`,
        rule: "rendered-file",
        message: `${name} is rendered at deploy, never built (SF-05)`,
      });
    }
    if (!STATIC_TEXT_FILES.has(extname(file).toLowerCase())) continue;
    const text = readFileSync(join(dir, file), "utf8");
    if (/[#@]\s*sourceMappingURL=(?!data:)\S+/.test(text)) {
      findings.push({
        file: `${label}/${file}`,
        rule: "source-map",
        message: "a sourceMappingURL comment points at a map that is never served",
      });
    }
    for (const origin of originsIn(text)) {
      if (!ALLOWED_ORIGINS.has(origin)) {
        findings.push({
          file: `${label}/${file}`,
          rule: "third-party-origin",
          message: `names ${clean(origin, 120)}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Runs both checks over every built app under <root>/apps.
 * @param {string} root
 * @returns {{ server: number, static: number, findings: Finding[] }}
 */
export function checkBundles(root) {
  const appsDir = join(root, "apps");
  /** @type {Finding[]} */
  const findings = [];
  let server = 0;
  let statics = 0;
  if (!existsSync(appsDir)) return { server, static: statics, findings };
  for (const app of readdirSync(appsDir, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const serverDir = join(appsDir, app.name, "dist", "server");
    if (existsSync(serverDir)) {
      server++;
      findings.push(...checkServer(`apps/${app.name}/dist/server`, serverDir));
    }
    const staticDir = join(appsDir, app.name, "dist", "static");
    if (existsSync(staticDir)) {
      statics++;
      findings.push(...checkStatic(`apps/${app.name}/dist/static`, staticDir));
    }
  }
  return { server, static: statics, findings };
}

if (import.meta.main) {
  const index = process.argv.indexOf("--root");
  const root = index > 0 ? (process.argv[index + 1] ?? ".") : process.cwd();
  const result = checkBundles(root);
  if (result.server + result.static === 0) {
    annotate("notice", "bundle-check", "no app has a built server bundle or static build yet");
  }
  for (const f of result.findings) say(`bundle-check: ${clean(f.file)}: ${f.rule}: ${f.message}`);
  say(
    `bundle-check.result result=${result.findings.length === 0 ? "pass" : "fail"} server=${result.server} static=${result.static} findings=${result.findings.length}`,
  );
  process.exitCode = result.findings.length === 0 ? 0 : 1;
}
