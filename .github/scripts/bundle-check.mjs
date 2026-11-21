#!/usr/bin/env node
// The build job's bundle checks, and the release's scan of each static artefact (spec 01 §5.3;
// ARCHITECTURE §3.4 FW-C12, §3.5, §11.2, §11.7; FW-C04, FW-C05). A control path.
//   server bundles (apps/<app>/dist/server/**), the release target CI builds by default
//     - no test seam in the JavaScript (ARCHITECTURE §3.5: CI greps the release bundles for the
//       seams' markers): the build-target define left unreplaced (`__FIN_BUILD_TARGET__`), the
//       `fin:test-seam` marker a seam module carries, a `//#region` of packages/testing (the
//       harness bundled in), or an import of @fin/testing left in;
//     - no packages/testing source in a map's `sources` (its sourcesContent, the original text
//       with its comments, is not read);
//   static builds (apps/<app>/dist/static/**), and with --artefacts <dir> each folder in <dir>
//   (release.yml: every staged static artefact, the previous release's carried assets included)
//     - FW-C12's scan: no secret shape and nothing public-safety refuses in any file, read with
//       scripts/public-safety.mjs's own rules (and the overlay's refuse list when FIN_OVERLAY_FILE
//       names one); no server setting's name (`FIN_*`: a build takes public settings only, and
//       env.json's fields are not named so); no server-only marker (a `node:` module import, or
//       Vite's stand-in for one, `__vite-browser-external`); no test seam marker;
//     - no third-party origin in a built HTML, CSS, JavaScript, JSON, SVG or manifest file: every
//       absolute http, https, ws or wss URL (its scheme in any case, its slashes escaped as JSON
//       or a string may write them) and every protocol-relative `//host` where a URL starts has
//       an origin on ALLOWED_ORIGINS, the namespace and message URLs the pinned libraries carry,
//       none of which is fetched; and no URL with a user name or password, whose host is not the
//       one it seems to name;
//     - no source map (`*.map` in any case, or a `sourceMappingURL` comment pointing at one);
//     - nothing a deployment refuses (release-static.mjs's artefactProblems: `_headers` or
//       `env.json`, which the deploy renders, SF-05; a Worker control file; a path read two ways;
//       an asset over 25 MiB);
//   and no link anywhere. The built index.html's inline scripts, handlers and the rest of FW-C04
// are scripts/static-check.mjs's, which the build job runs next; gitleaks scans the same folders
// (gitleaks-static.sh). While no app has been built, the check passes with a notice.
//
// `process.env` is not refused: isomorphic libraries guard it with `typeof process`, and a server
// configuration module is caught by its settings' names instead.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { loadRefuseList, refuseMatcher, scanContent } from "../../scripts/public-safety.mjs";
import { annotate, clean, isMain, say } from "./lib/ci.mjs";
import { artefactProblems, isSourceMap } from "./release-static.mjs";

/** @typedef {{ file: string, rule: string, message: string }} Finding */
/** @typedef {import("../../scripts/public-safety.mjs").RefuseMatcher} RefuseMatcher */

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

/** Markers of server-only code in a client build (FW-C12: no node:* in the client). */
export const SERVER_MARKERS = [
  {
    pattern:
      /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*|\bexport\s*\*\s*from\s*)["'`]node:[^\s"'`]+["'`]/,
    what: "a node: module is imported (FW-C12: client code imports no node:*)",
  },
  {
    pattern: /__vite-browser-external/,
    what: "Vite's stand-in for a Node module (client code imported one)",
  },
];

/** A server setting's name: Fin's settings are `FIN_*` (env.json's fields are not). */
const SETTING_NAME = /\bFIN_[A-Z0-9]+(?:_[A-Z0-9]+)*\b/g;

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
  ".htm",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
  ".svg",
  ".webmanifest",
  ".txt",
  ".xml",
]);
/** An absolute URL with an authority, its scheme in any case (read after unescapeSlashes). */
const ABSOLUTE_URL = /\b(?:https?|wss?):\/\/[^\s"'`<>()\\{}|^]*/gi;
/**
 * A protocol-relative URL where a URL starts: after a quote, an `=` (an unquoted attribute) or a
 * CSS `url(`. Read in the text as written: unescaping would turn a regular expression's `\/\/`
 * after a `(` into one.
 */
const RELATIVE_URL = /(?<=(?:["'`=]|\burl\()\s*)\/\/[A-Za-z0-9][^\s"'`<>()\\{}|^]*/gi;
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
 * A text with the escapes a string or JSON can spell a URL's slash with (`\/`, `/`, `\x2f`)
 * read as the slash.
 * @param {string} text
 */
function unescapeSlashes(text) {
  return text.replace(/\\(?:u002[fF]|x2[fF]|\/)/g, "/");
}

/**
 * The URLs a text names, each read as a browser would: its origin, or null when it has none the
 * text fixes (a host built at run time), and whether it carries a user name or password.
 * @param {string} text
 * @returns {{ url: string, origin: string | null, userinfo: boolean }[]}
 */
export function urlsIn(text) {
  /** @type {Map<string, { url: string, origin: string | null, userinfo: boolean }>} */
  const found = new Map();
  const candidates = [
    ...[...unescapeSlashes(text).matchAll(ABSOLUTE_URL)].map((m) => m[0]),
    ...[...text.matchAll(RELATIVE_URL)].map((m) => `https:${m[0]}`),
  ];
  for (const candidate of candidates) {
    if (found.has(candidate)) continue;
    /** @type {URL | null} */
    let url = null;
    try {
      url = new URL(candidate);
    } catch {
      // A host the text builds at run time, or no host at all: nothing to compare.
    }
    // A host the text builds at run time (`https://${host}`) has no origin to compare here; the
    // page's own policy (connect-src 'self') refuses it in the browser.
    const origin =
      url === null || url.hostname === "" || url.hostname.includes("$") ? null : url.origin;
    found.set(candidate, {
      url: candidate,
      origin,
      userinfo: url !== null && (url.username !== "" || url.password !== ""),
    });
  }
  return [...found.values()];
}

/**
 * The origins named in a text, each once, lower-cased.
 * @param {string} text
 * @returns {string[]}
 */
export function originsIn(text) {
  return [...new Set(urlsIn(text).flatMap((u) => (u.origin === null ? [] : [u.origin])))];
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
 * Checks one static build (or staged artefact) directory.
 * @param {string} label e.g. apps/console/dist/static
 * @param {string} dir
 * @param {{ refused?: RefuseMatcher }} [options] the overlay's refuse list, when given
 * @returns {Finding[]}
 */
export function checkStatic(label, dir, options = {}) {
  /** @type {Finding[]} */
  const findings = [];
  const refused = options.refused ?? refuseMatcher([]);
  const { files, links } = listFiles(dir);
  for (const link of links) {
    findings.push({ file: `${label}/${link}`, rule: "link", message: "a link in a static build" });
  }
  for (const problem of artefactProblems(
    files.map((file) => ({ path: `/${file}`, abs: join(dir, file) })),
    { maps: true },
  )) {
    findings.push({ file: label, rule: "artefact", message: problem });
  }
  for (const file of files) {
    const at = `${label}/${file}`;
    if (isSourceMap(file)) {
      findings.push({ file: at, rule: "source-map", message: "a source map left" });
      continue;
    }
    const bytes = readFileSync(join(dir, file));
    // public-safety's rules, in every reading of the bytes, never printing what matched.
    for (const f of scanContent(at, bytes, refused)) {
      findings.push({
        file: f.line === undefined ? at : `${at}:${f.line}`,
        rule: `public-safety:${f.rule}`,
        message: f.message,
      });
    }
    if (!STATIC_TEXT_FILES.has(extname(file).toLowerCase())) continue;
    const text = bytes.toString("utf8");
    if (/[#@]\s*sourceMappingURL=(?!data:)\S+/.test(text)) {
      findings.push({
        file: at,
        rule: "source-map",
        message: "a sourceMappingURL comment points at a map that is never served",
      });
    }
    for (const marker of SEAM_MARKERS) {
      if (marker.pattern.test(text))
        findings.push({ file: at, rule: "seam", message: marker.what });
    }
    for (const marker of SERVER_MARKERS) {
      if (marker.pattern.test(text)) {
        findings.push({ file: at, rule: "server-only", message: marker.what });
      }
    }
    for (const name of new Set([...text.matchAll(SETTING_NAME)].map((m) => m[0]))) {
      findings.push({
        file: at,
        rule: "setting-name",
        message: `names the server setting ${clean(name, 60)} (FW-C12: a build takes public settings only)`,
      });
    }
    for (const u of urlsIn(text)) {
      if (u.userinfo) {
        findings.push({
          file: at,
          rule: "url-userinfo",
          message: "a URL with a user name or password, whose host is not the one it seems to name",
        });
      }
      if (u.origin !== null && !ALLOWED_ORIGINS.has(u.origin)) {
        findings.push({
          file: at,
          rule: "third-party-origin",
          message: `names ${clean(u.origin, 120)}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Runs both checks over every built app under <root>/apps.
 * @param {string} root
 * @param {{ refused?: RefuseMatcher }} [options]
 * @returns {{ server: number, static: number, findings: Finding[] }}
 */
export function checkBundles(root, options = {}) {
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
      findings.push(...checkStatic(`apps/${app.name}/dist/static`, staticDir, options));
    }
  }
  return { server, static: statics, findings };
}

/**
 * Checks every static artefact staged under a directory, one per folder (release.yml).
 * @param {string} dir
 * @param {{ refused?: RefuseMatcher }} [options]
 * @returns {{ server: number, static: number, findings: Finding[] }}
 */
export function checkArtefacts(dir, options = {}) {
  /** @type {Finding[]} */
  const findings = [];
  let statics = 0;
  if (!existsSync(dir)) return { server: 0, static: 0, findings };
  for (const name of readdirSync(dir).sort()) {
    const label = `artefact ${name}`;
    const abs = join(dir, name);
    if (!lstatSync(abs).isDirectory()) {
      findings.push({
        file: label,
        rule: "artefact",
        message: "not a folder of a staged artefact",
      });
      continue;
    }
    statics++;
    findings.push(...checkStatic(label, abs, options));
  }
  return { server: 0, static: statics, findings };
}

if (isMain(import.meta)) {
  const argument = (/** @type {string} */ flag) => {
    const index = process.argv.indexOf(flag);
    return index > 0 ? process.argv[index + 1] : undefined;
  };
  const options = { refused: refuseMatcher(loadRefuseList(process.env.FIN_OVERLAY_FILE)) };
  const artefacts = argument("--artefacts");
  const result =
    artefacts === undefined
      ? checkBundles(argument("--root") ?? process.cwd(), options)
      : checkArtefacts(artefacts, options);
  if (result.server + result.static === 0) {
    annotate("notice", "bundle-check", "no app has a built server bundle or static build yet");
  }
  for (const f of result.findings) say(`bundle-check: ${clean(f.file)}: ${f.rule}: ${f.message}`);
  say(
    `bundle-check.result result=${result.findings.length === 0 ? "pass" : "fail"} server=${result.server} static=${result.static} findings=${result.findings.length}`,
  );
  process.exitCode = result.findings.length === 0 ? 0 : 1;
}
