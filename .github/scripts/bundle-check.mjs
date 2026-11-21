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
//       names one); and, in every file a browser reads as text (STATIC_TEXT_FILES) and every
//       other file that is not binary (an unknown extension, or none): no server setting's name
//       (`FIN_*`: a build takes public settings only, and env.json's fields are not named so); no
//       server-only marker (a `node:` module import, or Vite's stand-in for one,
//       `__vite-browser-external`); no test seam marker;
//     - in the same files, no third-party origin: every http, https, ws or wss URL and every
//       protocol-relative one where a URL starts (after a quote, an unquoted attribute's `=` in
//       markup, CSS's url(, or as a srcset candidate) has an origin on ALLOWED_ORIGINS, the
//       namespace and message URLs the pinned libraries carry, none of which is fetched; and no
//       URL with a user name or password, whose host is not the one it seems to name. Each URL is
//       read as a browser reads it, in every reading of the text a browser may apply (readings:
//       JavaScript's and JSON's escapes, CSS's, HTML's character references): its scheme in any
//       case, a backslash as a slash, any run of slashes, no slashes at all where a literal
//       starts (`"wss:host"`), tabs and new lines dropped, and its authority everything up to
//       the first /, \, ? or # or its literal's own end, the host after its last `@`. A host the
//       text builds at run time (`"https://" + host`) is not read here: the page's own policy
//       refuses it in the browser;
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
import {
  decodeContent,
  loadRefuseList,
  refuseMatcher,
  scanContent,
} from "../../scripts/public-safety.mjs";
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
/**
 * Files a browser reads as text, scanned even when they hold a NUL byte. Every other file is
 * scanned unless it is binary (public-safety's decodeContent), so an image's own metadata is not
 * read as a page.
 */
const STATIC_TEXT_FILES = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
  ".svg",
  ".webmanifest",
  ".txt",
  ".xml",
  ".xsl",
]);
/** Script and data files: their strings are read through JavaScript's escapes. */
const SCRIPT_FILES = new Set([".js", ".mjs", ".cjs", ".json", ".webmanifest"]);
const MAX_FILES = 50_000;

// ---- reading a URL as a browser does ---------------------------------------------------------

/**
 * What a reading puts where an escape or a character reference spelled a quote: such a quote is
 * part of the literal and does not end it.
 */
const QUOTE_MARKS = new Map([
  ['"', "\u{e000}"],
  ["'", "\u{e001}"],
  ["`", "\u{e002}"],
]);
const QUOTES = new Set(['"', "'", "`", "\u{e000}", "\u{e001}", "\u{e002}"]);
const JS_ESCAPES = new Map([
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["f", "\f"],
  ["b", "\b"],
]);
/** The named character references that spell a URL's punctuation, white space or a quote. */
const NAMED_REFERENCES = new Map([
  ["sol", "/"],
  ["bsol", "\\"],
  ["colon", ":"],
  ["Tab", "\t"],
  ["NewLine", "\n"],
  ["period", "."],
  ["commat", "@"],
  ["quest", "?"],
  ["num", "#"],
  ["amp", "&"],
  ["AMP", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["QUOT", '"'],
  ["apos", "'"],
  ["grave", "`"],
  ["lpar", "("],
  ["rpar", ")"],
  ["equals", "="],
  ["comma", ","],
  ["semi", ";"],
  ["excl", "!"],
  ["dollar", "$"],
  ["percnt", "%"],
  ["plus", "+"],
  ["ast", "*"],
  ["lowbar", "_"],
  ["Hat", "^"],
  ["verbar", "|"],
  ["vert", "|"],
  ["lsqb", "["],
  ["lbrack", "["],
  ["rsqb", "]"],
  ["rbrack", "]"],
  ["lcub", "{"],
  ["lbrace", "{"],
  ["rcub", "}"],
  ["rbrace", "}"],
  ["nbsp", "\u{a0}"],
]);

/** @param {string} c */
const marked = (c) => QUOTE_MARKS.get(c) ?? c;
/** @param {number} code */
const fromCode = (code) => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\u{fffd}");

/**
 * A text with a JavaScript or JSON string's escapes read (`\/`, `\\`, `\x2f`,
 * `\u{2f}`, `\t` and the rest; a line continuation is dropped).
 * @param {string} text
 */
export function decodeJsEscapes(text) {
  return text.replace(
    /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/g,
    (_m, braced, u4, x2, other) => {
      const hex = braced ?? u4 ?? x2;
      if (hex !== undefined) return marked(fromCode(Number.parseInt(hex, 16)));
      if (/^(?:\r\n|[\n\r\u{2028}\u{2029}])$/u.test(other)) return "";
      if (other === "0") return "\u{fffd}";
      return marked(JS_ESCAPES.get(other) ?? other);
    },
  );
}

/**
 * A text with CSS's escapes read (`\2f`, `\2f ` and `\/`; an escaped new line is dropped).
 * @param {string} text
 */
export function decodeCssEscapes(text) {
  return text.replace(
    /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/g,
    (_m, hex, newline, other) => {
      if (hex !== undefined) return marked(fromCode(Number.parseInt(hex, 16)));
      if (newline !== undefined) return "";
      return marked(other);
    },
  );
}

/**
 * A text with HTML's character references read: every numeric one, and the named ones that
 * spell a URL's punctuation (`&sol;`, `&colon;`, `&commat;`, `&Tab;` and the rest).
 * @param {string} text
 */
export function decodeHtmlReferences(text) {
  return text.replace(
    /&(?:#([0-9]{1,8})|#[xX]([0-9a-fA-F]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));?/g,
    (m, decimal, hex, name) => {
      if (decimal !== undefined) return marked(fromCode(Number.parseInt(decimal, 10)));
      if (hex !== undefined) return marked(fromCode(Number.parseInt(hex, 16)));
      const c = NAMED_REFERENCES.get(name);
      return c === undefined ? m : marked(c);
    },
  );
}

/**
 * Every reading of a text a browser may apply to the strings in it: a script's or JSON's through
 * JavaScript's escapes (and HTML's references, for markup a script writes); a stylesheet's
 * through CSS's escapes; markup, and any other file, as written and through each of them.
 * @param {string} text
 * @param {string} kind "script", "style" or "markup"
 * @returns {string[]}
 */
export function readings(text, kind) {
  if (kind === "script") {
    const js = decodeJsEscapes(text);
    return [...new Set([js, decodeHtmlReferences(js)])];
  }
  if (kind === "style") return [decodeCssEscapes(text)];
  const js = decodeJsEscapes(text);
  return [
    ...new Set([
      text,
      decodeHtmlReferences(text),
      js,
      decodeHtmlReferences(js),
      decodeCssEscapes(text),
    ]),
  ];
}

/** A browser drops every tab and new line in a URL, its scheme's included. */
const SEP = "[\\t\\n\\r]*";
/** A scheme whose URLs name a host (special schemes: a backslash is a slash, slashes optional). */
const SCHEME = new RegExp(
  `(?<![A-Za-z0-9+.\\-])(h${SEP}t${SEP}t${SEP}p(?:${SEP}s)?|w${SEP}s(?:${SEP}s)?)${SEP}:`,
  "gi",
);
/** A run of slashes or backslashes, as a browser skips before a special URL's host. */
const SLASH_RUN = /[\t\n\r]*(?:[/\\][\t\n\r]*)+/y;
/** Two slashes or backslashes: a protocol-relative URL where a URL starts. */
const TWO_SLASHES = /[/\\][\t\n\r]*[/\\]/g;
const SRCSET = /srcset[ \t\n\r\f]*=[ \t\n\r\f]*(["'\u{e000}\u{e001}])/giu;
const MAX_AUTHORITY = 512;

/**
 * @typedef {{ kind: "quoted", end: string } | { kind: "attribute" | "css" | "none" }} UrlContext
 */

/**
 * What stands before a URL, which decides where its text ends: a quote (or a quote an escape
 * spelled), the `=` of an unquoted attribute in markup, CSS's `url(`, or nothing known.
 * @param {string} text
 * @param {number} index where the URL starts
 * @param {boolean} markup
 * @returns {UrlContext}
 */
function contextBefore(text, index, markup) {
  let i = index - 1;
  while (i >= 0 && /[ \t\n\r\f]/.test(text[i] ?? "")) i--;
  const c = text[i] ?? "";
  if (QUOTES.has(c)) return { kind: "quoted", end: c };
  if (c === "=" && markup) return { kind: "attribute" };
  if (c === "(" && /url[ \t\n\r\f]*$/i.test(text.slice(Math.max(0, i - 16), i))) {
    return { kind: "css" };
  }
  return { kind: "none" };
}

/**
 * A URL's authority as a browser reads it: everything up to the first `/`, `\`, `?` or `#`, or the
 * end of its literal, with tabs and new lines dropped in a quoted one. Only the literal's own end
 * stops it short: a closing quote, white space or `>` after an unquoted attribute, white space or
 * `)` in CSS's url(). Where nothing known starts the URL (it is not a literal's start), white
 * space, quotes and brackets end it too.
 * @param {string} text
 * @param {number} start
 * @param {UrlContext} context
 */
function readAuthority(text, start, context) {
  let authority = "";
  for (let i = start; i < text.length && i - start < MAX_AUTHORITY; i++) {
    const c = text[i] ?? "";
    if (c === "\t" || c === "\n" || c === "\r") {
      if (context.kind === "quoted") continue;
      break;
    }
    if ("/\\?#".includes(c)) break;
    if (context.kind === "quoted") {
      if (c === context.end) break;
    } else if (/\s/.test(c)) {
      break;
    } else if (context.kind === "attribute") {
      if (c === ">") break;
    } else if (context.kind === "css") {
      if (c === ")" || QUOTES.has(c)) break;
    } else if (QUOTES.has(c) || "<>()[]{},;".includes(c)) {
      break;
    }
    authority += c;
  }
  return authority;
}

/**
 * The URLs of a srcset value, as a browser splits it: each candidate's URL runs to white space,
 * its trailing commas dropped, and its descriptors to the next comma.
 * @param {string} value
 * @returns {string[]}
 */
function srcsetUrls(value) {
  /** @type {string[]} */
  const urls = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i] ?? "")) i++;
    const start = i;
    while (i < value.length && !/\s/.test(value[i] ?? "")) i++;
    const token = value.slice(start, i);
    const url = token.replace(/,+$/, "");
    if (url !== "") urls.push(url);
    if (url === token) while (i < value.length && value[i] !== ",") i++;
  }
  return urls;
}

/**
 * @typedef {{ url: string, origin: string | null, userinfo: boolean }} FoundUrl
 */

/**
 * A URL from its scheme and authority: its origin, or null when it has none the text fixes (a
 * host built at run time, or none a browser could load), and whether it carries a user name or
 * password.
 * @param {string} scheme
 * @param {string} authority
 * @returns {FoundUrl | null}
 */
function foundUrl(scheme, authority) {
  if (authority === "") return null;
  /** @type {URL | null} */
  let url = null;
  try {
    url = new URL(`${scheme}://${authority}/`);
  } catch {
    // No host a browser could load either.
  }
  // A host the text builds at run time (`https://${host}`) has no origin to compare here; the
  // page's own policy (connect-src 'self') refuses it in the browser. Nor does a host of dots
  // alone (a device path's `//./`), which no browser loads.
  if (url === null) return { url: `${scheme}://${authority}`, origin: null, userinfo: false };
  const runTime = !/[A-Za-z0-9]/.test(url.hostname) || url.hostname.includes("$");
  return {
    url: `${scheme}://${authority}`,
    origin: runTime ? null : url.origin,
    userinfo: url.username !== "" || url.password !== "",
  };
}

/**
 * The URLs one reading of a text names: every http, https, ws or wss URL (its scheme in any case,
 * with slashes or backslashes or, where a literal starts, none), every protocol-relative one
 * (two or more slashes or backslashes) where a URL starts, and every srcset candidate.
 * @param {string} text
 * @param {boolean} markup whether `=` starts an unquoted attribute's value
 * @param {Map<string, FoundUrl>} found
 */
function scanReading(text, markup, found) {
  /** @param {FoundUrl | null} u */
  const keep = (u) => {
    if (u !== null && !found.has(u.url)) found.set(u.url, u);
  };
  for (const m of text.matchAll(SCHEME)) {
    const scheme = (m[1] ?? "").replace(/[\t\n\r]/g, "").toLowerCase();
    const after = (m.index ?? 0) + m[0].length;
    const context = contextBefore(text, m.index ?? 0, markup);
    SLASH_RUN.lastIndex = after;
    const run = SLASH_RUN.exec(text)?.[0] ?? "";
    // With no slash, only where a literal starts (`"wss:host"`): `{https:443}` names no URL.
    if (run === "" && context.kind === "none") continue;
    keep(foundUrl(scheme, readAuthority(text, after + run.length, context)));
  }
  for (const m of text.matchAll(TWO_SLASHES)) {
    const start = m.index ?? 0;
    if (/[/\\:]/.test(text[start - 1] ?? "")) continue; // inside a run, or a scheme's slashes
    const context = contextBefore(text, start, markup);
    if (context.kind === "none") continue;
    SLASH_RUN.lastIndex = start;
    const from = start + (SLASH_RUN.exec(text)?.[0].length ?? 0);
    if (/\s/.test(text[from] ?? "")) continue;
    keep(foundUrl("https", readAuthority(text, from, context)));
  }
  for (const m of text.matchAll(SRCSET)) {
    const open = m[1] ?? '"';
    const from = (m.index ?? 0) + m[0].length;
    const close = text.indexOf(open, from);
    const value = text.slice(from, close === -1 ? from + 4096 : close);
    for (const url of srcsetUrls(value)) {
      const scheme = /^(https?|wss?):/i.exec(url);
      const rest = scheme === null ? url : url.slice(scheme[0].length);
      const slashes = /^[/\\]*/.exec(rest)?.[0] ?? "";
      if (scheme === null && slashes.length < 2) continue;
      const authority = rest.slice(slashes.length).split(/[/\\?#]/)[0] ?? "";
      keep(foundUrl((scheme?.[1] ?? "https").toLowerCase(), authority));
    }
  }
}

/**
 * The URLs a text names, each read as a browser would, in every reading of the text (readings):
 * its origin, or null when it has none the text fixes (a host built at run time), and whether it
 * carries a user name or password.
 * @param {string} text
 * @param {{ kind?: string }} [options] "script", "style" or "markup" (the default)
 * @returns {FoundUrl[]}
 */
export function urlsIn(text, options = {}) {
  const kind = options.kind ?? "markup";
  /** @type {Map<string, FoundUrl>} */
  const found = new Map();
  for (const reading of readings(text, kind)) scanReading(reading, kind === "markup", found);
  return [...found.values()];
}

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
 * The origins named in a text, each once, lower-cased.
 * @param {string} text
 * @param {{ kind?: string }} [options] as urlsIn's
 * @returns {string[]}
 */
export function originsIn(text, options = {}) {
  return [...new Set(urlsIn(text, options).flatMap((u) => (u.origin === null ? [] : [u.origin])))];
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
    findings.push(...textFindings(at, file, bytes));
  }
  return findings;
}

/**
 * The text rules for one file of a static build: every file a browser reads as text, and every
 * other file that is not binary (an unknown extension, or none, included).
 * @param {string} at the finding's label
 * @param {string} file the path within the build
 * @param {Buffer} bytes
 * @returns {Finding[]}
 */
function textFindings(at, file, bytes) {
  const ext = extname(file).toLowerCase();
  const decoded = decodeContent(bytes);
  const texts = decoded.binary
    ? STATIC_TEXT_FILES.has(ext)
      ? [bytes.toString("utf8")]
      : []
    : decoded.texts;
  const kind = SCRIPT_FILES.has(ext) ? "script" : ext === ".css" ? "style" : "markup";
  /** @type {Map<string, Finding>} */
  const found = new Map();
  /**
   * @param {string} rule
   * @param {string} message
   */
  const add = (rule, message) => {
    found.set(`${rule}\u{0}${message}`, { file: at, rule, message });
  };
  for (const text of texts) {
    if (/[#@]\s*sourceMappingURL=(?!data:)\S+/.test(text)) {
      add("source-map", "a sourceMappingURL comment points at a map that is never served");
    }
    for (const marker of SEAM_MARKERS) {
      if (marker.pattern.test(text)) add("seam", marker.what);
    }
    for (const marker of SERVER_MARKERS) {
      if (marker.pattern.test(text)) add("server-only", marker.what);
    }
    for (const name of new Set([...text.matchAll(SETTING_NAME)].map((m) => m[0]))) {
      add(
        "setting-name",
        `names the server setting ${clean(name, 60)} (FW-C12: a build takes public settings only)`,
      );
    }
    for (const u of urlsIn(text, { kind })) {
      if (u.userinfo) {
        add(
          "url-userinfo",
          "a URL with a user name or password, whose host is not the one it seems to name",
        );
      }
      if (u.origin !== null && !ALLOWED_ORIGINS.has(u.origin)) {
        add("third-party-origin", `names ${clean(u.origin, 120)}`);
      }
    }
  }
  return [...found.values()];
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
