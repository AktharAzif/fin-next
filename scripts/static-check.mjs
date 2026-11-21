#!/usr/bin/env node
// static:check (EXECUTION §1.5 item 1; spec 01 §7.4; SA-45, UI-10). For each app in
// tools/layout.json with a static output:
//   - its static.json holds only the allowlisted keys and values (compatibility_date,
//     assets.not_found_handling "single-page-application", assets.html_handling
//     "auto-trailing-slash", workers_dev false, preview_urls false): no main, no binding, no
//     run_worker_first;
//   - once built (dist/static, or dist/static/<output> for an app with several outputs):
//     index.html carries <meta property="csp-nonce"> with no nonce attribute and has no inline
//     script, style attribute, event handler or nonce; the CSS starts with `@layer ui-sdk` and
//     holds no data: URL; no *.map is left; the build wrote no _headers or env.json (they are
//     rendered at deploy, SF-05);
//   - with --rendered <dir> (the deploy's rendered copies, <dir>/<output>/_headers), no
//     'unsafe-*' and no data: in any policy, except the docs profile's listed exception
//     (style-src 'unsafe-inline' and img-src data:, SA-45).
// The import side of the rule (no @ui-sdk/* outside packages/ui, no refused SDK entry) is
// imports:check's. While no app has a static build, the check passes with a notice.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isRecord, readJson, report } from "./lib/repo.mjs";

/** @typedef {import("./lib/repo.mjs").Finding} Finding */

const ALLOWED_STATIC_JSON = {
  compatibility_date: (/** @type {unknown} */ v) =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v),
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
  const meta = [...html.matchAll(/<meta\b[^>]*\bproperty\s*=\s*["']?csp-nonce["']?[^>]*>/gi)];
  if (meta.length !== 1) add(0, 'index.html needs exactly one <meta property="csp-nonce">');
  for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) {
    const text = tag[0];
    if (/\snonce\s*=/i.test(text)) add(tag.index, "no nonce attribute anywhere (FW-C04)");
    if (/\sstyle\s*=/i.test(text)) add(tag.index, "no style attribute (style-src 'self')");
    if (/\son[a-z]+\s*=/i.test(text)) add(tag.index, "no inline event handler (script-src 'self')");
  }
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = script[1] ?? "";
    if (!/\ssrc\s*=/i.test(attrs) || (script[2] ?? "").trim() !== "") {
      add(script.index, "no inline script; every script is an external file");
    }
  }
  for (const style of html.matchAll(/<style\b/gi))
    add(style.index, "no <style> element (style-src 'self')");
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
  const body = css.replace(/^﻿/, "").replace(/^(?:\s|\/\*[\s\S]*?\*\/)*/, "");
  if (!/^@layer\s+ui-sdk\b/.test(body)) {
    findings.push({
      file,
      rule: "static-css",
      message: "the stylesheet must start with @layer ui-sdk (FW-C06)",
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
      for (const output of outputs) {
        const headers = join(options.rendered, output, "_headers");
        if (existsSync(headers))
          findings.push(
            ...checkHeaders(`${output}/_headers`, readFileSync(headers, "utf8"), output),
          );
      }
    }
  }
  if (built === 0)
    notices.push("no app has a static build yet; only static.json files were checked");
  return { findings, notices };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const rootIndex = argv.indexOf("--root");
  const renderedIndex = argv.indexOf("--rendered");
  const root = rootIndex >= 0 ? (argv[rootIndex + 1] ?? ".") : process.cwd();
  const rendered = renderedIndex >= 0 ? argv[renderedIndex + 1] : undefined;
  const { findings, notices } = checkStatic(root, rendered === undefined ? {} : { rendered });
  for (const notice of notices) console.log(`static:check: notice: ${notice}`);
  process.exitCode = report("static:check", findings);
}
