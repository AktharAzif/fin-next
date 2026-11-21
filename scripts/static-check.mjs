#!/usr/bin/env node
// static:check (EXECUTION §1.5 item 1; spec 01 §7.4; SA-45, UI-10). For each app in
// tools/layout.json with a static output:
//   - its static.json holds only the allowlisted keys and values (compatibility_date
//     "2026-11-20", the one every deployment shares, assets.not_found_handling
//     "single-page-application", assets.html_handling "auto-trailing-slash", workers_dev false,
//     preview_urls false): no main, no binding, no run_worker_first;
//   - once built (dist/static, or dist/static/<output> for an app with several outputs):
//     index.html carries <meta property="csp-nonce"> with no nonce attribute and has no inline
//     script, style attribute, event handler or nonce, read with the browser's tokenizer rules
//     (`/` between attributes, `>` inside quoted values, `</script >`, comments and raw text);
//     the CSS's first statement is `@layer ui-sdk` and it holds no data: URL; no *.map is left;
//     the build wrote no _headers or env.json (they are rendered at deploy, SF-05);
//   - with --rendered <dir> (the deploy's rendered copies, <dir>/<output>/_headers), every output
//     of an app that exists has its _headers, with no 'unsafe-*' and no data: in any policy,
//     except the docs profile's listed exception (style-src 'unsafe-inline' and img-src data:,
//     SA-45).
// The import side of the rule (no @ui-sdk/* outside packages/ui, no refused SDK entry) is
// imports:check's. While no app has a static build, the check passes with a notice.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isRecord, readJson, report } from "./lib/repo.mjs";

/** @typedef {import("./lib/repo.mjs").Finding} Finding */

/** Every static deployment's compatibility date (spec 01 §7.4's invariant). */
export const COMPATIBILITY_DATE = "2026-11-20";
const ALLOWED_STATIC_JSON = {
  compatibility_date: (/** @type {unknown} */ v) => v === COMPATIBILITY_DATE,
  workers_dev: (/** @type {unknown} */ v) => v === false,
  preview_urls: (/** @type {unknown} */ v) => v === false,
};
const ALLOWED_ASSETS = {
  not_found_handling: "single-page-application",
  html_handling: "auto-trailing-slash",
};

/**
 * Checks one static.json against the allowlist.
 * @param {string} file
 * @param {unknown} json
 * @returns {Finding[]}
 */
export function checkStaticJson(file, json) {
  /** @type {Finding[]} */
  const findings = [];
  /** @param {string} message */
  const add = (message) => findings.push({ file, rule: "static-json", message });
  if (!isRecord(json)) {
    add("static.json must be a JSON object");
    return findings;
  }
  for (const [key, value] of Object.entries(json)) {
    if (key === "assets") continue;
    const valid = ALLOWED_STATIC_JSON[/** @type {keyof typeof ALLOWED_STATIC_JSON} */ (key)];
    if (valid === undefined)
      add(`the key ${key} is not allowed (no main, bindings, run_worker_first, routes or crons)`);
    else if (!valid(value)) add(`${key} has a value outside the allowlist`);
  }
  for (const key of [...Object.keys(ALLOWED_STATIC_JSON), "assets"]) {
    if (!(key in json)) add(`the key ${key} is required`);
  }
  const assets = json.assets;
  if (assets !== undefined) {
    if (!isRecord(assets)) add("assets must be an object");
    else {
      for (const [key, value] of Object.entries(assets)) {
        const expected = ALLOWED_ASSETS[/** @type {keyof typeof ALLOWED_ASSETS} */ (key)];
        if (expected === undefined)
          add(`assets.${key} is not allowed (no run_worker_first, no binding)`);
        else if (value !== expected) add(`assets.${key} must be "${expected}"`);
      }
      for (const key of Object.keys(ALLOWED_ASSETS))
        if (!(key in assets)) add(`assets.${key} is required`);
    }
  }
  return findings;
}

/**
 * @typedef {{ name: string, attributes: Map<string, string>, index: number, text?: string }} StartTag
 */

const WHITESPACE = new Set(["\t", "\n", "\f", "\r", " "]);
// Elements whose content is text up to their own end tag, as the HTML tokenizer reads them.
const RAW_TEXT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript"]);
const RCDATA = new Set(["title", "textarea"]);

/**
 * Reads the start tags of an HTML document the way a browser's tokenizer does, for what the page
 * policy cares about: tag and attribute names (lowercased), attribute values (quoted, unquoted or
 * absent), `/` as a separator between attributes, `>` inside a quoted value, comments and bogus
 * comments, end tags, and the text of raw-text elements (a script's own text is kept as `text`).
 * A tag cut off by the end of the file is still returned, so the check fails closed.
 * @param {string} html
 * @returns {StartTag[]}
 */
export function htmlStartTags(html) {
  /** @type {StartTag[]} */
  const tags = [];
  const lower = html.toLowerCase();
  let i = 0;
  const isLetter = (/** @type {string} */ c) => /^[A-Za-z]$/.test(c);
  const atBoundary = () =>
    i >= html.length || WHITESPACE.has(html.charAt(i)) || "/>".includes(html.charAt(i));
  /**
   * Reads a tag's attributes from `i`, up to and past its `>`.
   * @returns {Map<string, string>}
   */
  const readAttributes = () => {
    /** @type {Map<string, string>} */
    const attributes = new Map();
    while (i < html.length) {
      const c = html.charAt(i);
      if (WHITESPACE.has(c) || c === "/") {
        i++;
        continue;
      }
      if (c === ">") {
        i++;
        break;
      }
      let name = c; // the first character may be `=`
      i++;
      while (i < html.length && !atBoundary() && html.charAt(i) !== "=") name += html.charAt(i++);
      while (WHITESPACE.has(html.charAt(i))) i++;
      let value = "";
      if (html.charAt(i) === "=") {
        i++;
        while (WHITESPACE.has(html.charAt(i))) i++;
        const quote = html.charAt(i);
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, i + 1);
          value = html.slice(i + 1, end < 0 ? html.length : end);
          i = end < 0 ? html.length : end + 1;
        } else {
          const start = i;
          while (i < html.length && !WHITESPACE.has(html.charAt(i)) && html.charAt(i) !== ">") i++;
          value = html.slice(start, i);
        }
      }
      const key = name.toLowerCase();
      if (!attributes.has(key)) attributes.set(key, value); // the first one wins, as in a browser
    }
    return attributes;
  };
  while (i < html.length) {
    const open = html.indexOf("<", i);
    if (open < 0) break;
    i = open + 1;
    if (html.startsWith("!--", i)) {
      // A comment; `<!-->` and `<!--->` end at once, as browsers read them.
      const body = i + 3;
      if (html.startsWith(">", body) || html.startsWith("->", body)) {
        i = html.indexOf(">", body) + 1;
        continue;
      }
      const close = html.indexOf("-->", body);
      const bang = html.indexOf("--!>", body);
      if (close < 0 && bang < 0) i = html.length;
      else if (bang < 0 || (close >= 0 && close < bang)) i = close + 3;
      else i = bang + 4;
      continue;
    }
    const next = html.charAt(i);
    if (next === "!" || next === "?" || (next === "/" && !isLetter(html.charAt(i + 1)))) {
      const end = html.indexOf(">", i); // a doctype or a bogus comment
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (next === "/") {
      i++;
      while (!atBoundary()) i++;
      readAttributes(); // an end tag's attributes are read and dropped
      continue;
    }
    if (!isLetter(next)) continue; // a `<` that starts no tag is text
    let name = "";
    while (!atBoundary()) name += html.charAt(i++);
    name = name.toLowerCase();
    /** @type {StartTag} */
    const tag = { name, attributes: readAttributes(), index: open };
    tags.push(tag);
    if (RAW_TEXT.has(name) || RCDATA.has(name) || name === "plaintext") {
      const closing = new RegExp(`</${name}[\\t\\n\\f\\r />]`, "g");
      closing.lastIndex = i;
      const end = name === "plaintext" ? null : closing.exec(lower);
      const stop = end === null ? html.length : end.index;
      if (name === "script") tag.text = html.slice(i, stop);
      i = stop;
    }
  }
  return tags;
}

/**
 * Checks a built index.html.
 * @param {string} file
 * @param {string} html
 * @returns {Finding[]}
 */
export function checkIndexHtml(file, html) {
  /** @type {Finding[]} */
  const findings = [];
  /**
   * @param {number} index
   * @param {string} message
   */
  const add = (index, message) =>
    findings.push({
      file,
      line: html.slice(0, index).split("\n").length,
      rule: "static-html",
      message,
    });
  const tags = htmlStartTags(html);
  const meta = tags.filter(
    (t) => t.name === "meta" && t.attributes.get("property")?.toLowerCase() === "csp-nonce",
  );
  if (meta.length !== 1) add(0, 'index.html needs exactly one <meta property="csp-nonce">');
  for (const tag of tags) {
    const names = [...tag.attributes.keys()];
    if (names.includes("nonce")) add(tag.index, "no nonce attribute anywhere (FW-C04)");
    if (names.includes("style")) add(tag.index, "no style attribute (style-src 'self')");
    if (names.some((n) => n.startsWith("on"))) {
      add(tag.index, "no inline event handler (script-src 'self')");
    }
    if (tag.name === "style") add(tag.index, "no <style> element (style-src 'self')");
    if (tag.name === "script" && (!tag.attributes.has("src") || (tag.text ?? "").trim() !== "")) {
      add(tag.index, "no inline script; every script is an external file");
    }
  }
  return findings;
}

/**
 * Checks a built stylesheet.
 * @param {string} file
 * @param {string} css
 * @returns {Finding[]}
 */
export function checkCss(file, css) {
  /** @type {Finding[]} */
  const findings = [];
  const body = css.replace(/^\u{FEFF}/u, "").replace(/^(?:\s|\/\*[\s\S]*?\*\/)*/, "");
  // The first statement declares the layer `ui-sdk` itself, alone or first in a list or block,
  // never a longer name such as `ui-sdk-overrides`.
  if (!/^@layer\s+ui-sdk\s*[;,{]/.test(body)) {
    findings.push({
      file,
      rule: "static-css",
      message: "the stylesheet's first statement must be @layer ui-sdk (FW-C06)",
    });
  }
  if (/url\(\s*["']?data:/i.test(css)) {
    findings.push({
      file,
      rule: "static-css",
      message: "no data: URL in CSS (assetsInlineLimit: 0)",
    });
  }
  return findings;
}

/**
 * Checks a rendered _headers file.
 * @param {string} file
 * @param {string} text
 * @param {string} output the static output's name (docs has the listed exception)
 * @returns {Finding[]}
 */
export function checkHeaders(file, text, output) {
  /** @type {Finding[]} */
  const findings = [];
  for (const [index, line] of text.split("\n").entries()) {
    const csp = /^\s*Content-Security-Policy(?:-Report-Only)?:\s*(.*)$/i.exec(line);
    if (!csp) continue;
    for (const directive of (csp[1] ?? "").split(";")) {
      const [name = "", ...values] = directive.trim().split(/\s+/);
      for (const value of values) {
        const unsafe = /^'unsafe-/i.test(value);
        const data = /^data:$/i.test(value);
        if (!unsafe && !data) continue;
        const excepted =
          output === "docs" &&
          ((name === "style-src" && value === "'unsafe-inline'") || (name === "img-src" && data));
        if (!excepted) {
          findings.push({
            file,
            line: index + 1,
            rule: "static-headers",
            message: `${name} allows ${value}, outside SA-45's listed exceptions`,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Lists files under a directory, recursively, as paths relative to it.
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path).map((p) => `${name}/${p}`));
    else out.push(name);
  }
  return out;
}

/**
 * Runs static:check over the repository at `root`.
 * @param {string} root
 * @param {{ rendered?: string }} [options]
 * @returns {{ findings: Finding[], notices: string[] }}
 */
export function checkStatic(root, options = {}) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const notices = [];
  const layout = readJson(join(root, "tools/layout.json"));
  const entries = isRecord(layout) && Array.isArray(layout.entries) ? layout.entries : [];
  let built = 0;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.static === undefined || typeof entry.path !== "string") continue;
    const outputs = /** @type {string[]} */ (
      Array.isArray(entry.static) ? entry.static : [entry.static]
    );
    const staticJson = join(root, entry.path, "static.json");
    if (existsSync(staticJson)) {
      /** @type {unknown} */
      let json;
      try {
        json = readJson(staticJson);
        findings.push(...checkStaticJson(`${entry.path}/static.json`, json));
      } catch {
        findings.push({
          file: `${entry.path}/static.json`,
          rule: "static-json",
          message: "not valid JSON",
        });
      }
    }
    for (const output of outputs) {
      const dir = join(root, entry.path, "dist", "static", ...(outputs.length > 1 ? [output] : []));
      const label = relative(root, dir);
      if (!existsSync(join(dir, "index.html"))) continue;
      built++;
      for (const file of walk(dir)) {
        const path = `${label}/${file}`;
        if (file.endsWith(".map"))
          findings.push({
            file: path,
            rule: "static-map",
            message: "source maps never stay in dist/static",
          });
        if (file === "_headers" || file === "env.json") {
          findings.push({
            file: path,
            rule: "static-rendered-in-build",
            message: "builds are environment-neutral; this file is rendered at deploy (SF-05)",
          });
        }
        if (file.endsWith(".css"))
          findings.push(...checkCss(path, readFileSync(join(dir, file), "utf8")));
        if (
          file.endsWith(".js") &&
          /["'(]data:[a-z]+\/[a-z0-9.+-]+[;,]/i.test(readFileSync(join(dir, file), "utf8"))
        ) {
          findings.push({
            file: path,
            rule: "static-data-url",
            message: "no data: URL in built JavaScript",
          });
        }
      }
      findings.push(
        ...checkIndexHtml(`${label}/index.html`, readFileSync(join(dir, "index.html"), "utf8")),
      );
    }
    if (options.rendered !== undefined) {
      // Every output of an app that exists is deployed, so each has its rendered _headers: a
      // renderer that wrote elsewhere, or nothing, must not pass for one with no policy to check.
      const appExists = existsSync(join(root, entry.path));
      for (const output of outputs) {
        const headers = join(options.rendered, output, "_headers");
        if (existsSync(headers)) {
          findings.push(
            ...checkHeaders(`${output}/_headers`, readFileSync(headers, "utf8"), output),
          );
        } else if (appExists) {
          findings.push({
            file: `${output}/_headers`,
            rule: "static-headers-missing",
            message: `the rendered copy of ${entry.path}'s ${output} output has no _headers`,
          });
        }
      }
    }
  }
  if (built === 0)
    notices.push("no app has a static build yet; only static.json files were checked");
  return { findings, notices };
}

/**
 * Reads the command's arguments: `--root <dir>` and `--rendered <dir>`, each at most once.
 * @param {string[]} argv
 * @returns {{ root: string, rendered?: string }}
 */
export function parseArgs(argv) {
  /** @type {{ root: string, rendered?: string }} */
  const args = { root: process.cwd() };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    const value = argv[i + 1];
    if (flag !== "--root" && flag !== "--rendered") throw new Error(`unknown argument ${flag}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (!existsSync(value) || !statSync(value).isDirectory()) {
      throw new Error(`${flag}: no such directory`);
    }
    if (flag === "--root") args.root = value;
    else args.rendered = value;
  }
  return args;
}

if (import.meta.main) {
  try {
    const { root, rendered } = parseArgs(process.argv.slice(2));
    const { findings, notices } = checkStatic(root, rendered === undefined ? {} : { rendered });
    for (const notice of notices) console.log(`static:check: notice: ${notice}`);
    process.exitCode = report("static:check", findings);
  } catch (error) {
    console.error(`static:check: ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 2;
  }
}
