#!/usr/bin/env node
// layout:check (spec 01 §4.3; ARCHITECTURE §3.1). tools/layout.json is the one source for names,
// tiers, areas, lanes and control paths. This check fails when:
//   - tools/layout.json is malformed;
//   - a file maps to no entry (longest path prefix wins; root files are listed by name);
//   - an apps/* or packages/* directory has no entry of its own;
//   - an "active" entry's path does not exist;
//   - a document under docs/plan/ names an @fin/* package, an apps/* or a packages/* path that no
//     entry lists;
//   - CODEOWNERS and controlPaths differ, a CODEOWNERS line names anyone but the one owner of
//     the control paths (spec 01 §3.6), a pattern appears twice, or the file holds a carriage
//     return or another control character;
//   - an app with a static output whose directory exists (planned or active) has no static.json,
//     or a static.json or a header profile in packages/web-host/src/static/ is outside
//     controlPaths;
//   - a package's name differs from its entry's, or a manifest is not package.json (pnpm also
//     reads package.yaml, package.yml and package.json5);
//   - a package's test or test:db script runs Vitest other than through the root configuration,
//     which alone keeps integration tests and Playwright journeys out of the unit run (spec 01
//     §4.7), or a package holds a Vitest configuration of its own, which that run would ignore.
// A "planned" entry whose path exists is a warning, not a failure (orchestrator decision BD-08):
// parallel lanes create their packages without editing this control path, and a steward pull
// request flips them to "active" at the Phase 0 exit. BD-08 relaxes that rule only.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { coveredBy, isRecord, listFiles, readJson, report } from "./lib/repo.mjs";

/** @typedef {import("./lib/repo.mjs").Finding} Finding */

/** The one owner of every control path (spec 01 §3.6; DECISIONS CI-14). */
export const CONTROL_PATH_OWNER = "@aktharazif";
/** How a package runs its tests: through the root vitest.config.ts (spec 01 §4.7). */
export const VITEST_SCRIPTS = {
  test: "vitest run --config ../../vitest.config.ts",
  "test:db": "vitest run --config ../../vitest.config.ts --mode db",
};
const OTHER_MANIFESTS = new Set(["package.yaml", "package.yml", "package.json5"]);

/**
 * @typedef {{
 *   path: string, name?: string, kind: string, status: string, lane: string,
 *   tiers: Record<string, string>, areas: string[], files?: string[], image?: string,
 *   static?: string | string[],
 * }} Entry
 * @typedef {{ version: 1, controlPaths: string[], notFin: { path: string, why: string }[],
 *   entries: Entry[] }} Layout
 */

const LAYOUT = "tools/layout.json";
const KINDS = new Set(["root", "app", "package", "dir", "file"]);
const STATUSES = new Set(["active", "planned"]);
const TIERS = new Set(["S", "N", "D"]);
const STATIC_PROFILES_DIR = "packages/web-host/src/static/";
// A mention is a whole token: not part of a URL path, a longer path or a word.
const MENTION = /(?<![\w./@-])(@fin\/[a-z0-9][a-z0-9-]*|(?:apps|packages)\/[a-z0-9][a-z0-9-]*)/g;

/**
 * Validates the parsed layout file, returning findings for every problem.
 * @param {unknown} raw
 * @returns {{ layout?: Layout, findings: Finding[] }}
 */
export function validateLayout(raw) {
  /** @type {Finding[]} */
  const findings = [];
  /** @param {string} message */
  const bad = (message) => findings.push({ file: LAYOUT, rule: "layout-schema", message });
  if (!isRecord(raw)) {
    bad("the file must hold one JSON object");
    return { findings };
  }
  if (raw.version !== 1) bad('"version" must be 1');
  const controlPaths = raw.controlPaths;
  if (!Array.isArray(controlPaths) || controlPaths.some((p) => typeof p !== "string" || !p)) {
    bad('"controlPaths" must be an array of non-empty strings');
  } else if (new Set(controlPaths).size !== controlPaths.length) {
    bad('"controlPaths" lists a path twice');
  }
  const notFin = raw.notFin ?? [];
  if (
    !Array.isArray(notFin) ||
    notFin.some((n) => !isRecord(n) || typeof n.path !== "string" || typeof n.why !== "string")
  ) {
    bad('"notFin" must be an array of { "path", "why" } objects');
  }
  if (!Array.isArray(raw.entries)) {
    bad('"entries" must be an array');
    return { findings };
  }
  const paths = new Set();
  const names = new Set();
  let roots = 0;
  for (const [index, entry] of raw.entries.entries()) {
    const at = `entry ${index}`;
    if (!isRecord(entry)) {
      bad(`${at} must be an object`);
      continue;
    }
    const { path, name, kind, status, lane, tiers, areas } = entry;
    if (typeof path !== "string" || path === "" || path.startsWith("/") || path.endsWith("/")) {
      bad(`${at}: "path" must be a relative path with no leading or trailing slash`);
      continue;
    }
    if (path.split("/").some((part) => part === ".." || (part === "." && path !== "."))) {
      bad(`${at} (${path}): "path" must not contain "." or ".." segments`);
    }
    if (paths.has(path)) bad(`${at}: the path ${path} is listed twice`);
    paths.add(path);
    if (typeof kind !== "string" || !KINDS.has(kind)) {
      bad(`${path}: "kind" must be one of ${[...KINDS].join(", ")}`);
    }
    if (typeof status !== "string" || !STATUSES.has(status)) {
      bad(`${path}: "status" must be "active" or "planned"`);
    }
    if (typeof lane !== "string" || lane === "") bad(`${path}: "lane" must name the owning lane`);
    if (
      !isRecord(tiers) ||
      !("**" in tiers) ||
      Object.values(tiers).some((t) => typeof t !== "string" || !TIERS.has(t))
    ) {
      bad(`${path}: "tiers" must map globs to S, N or D and include "**"`);
    }
    if (!Array.isArray(areas) || areas.some((a) => typeof a !== "string" || a === "")) {
      bad(`${path}: "areas" must be an array of area names`);
    }
    if (kind === "app" || kind === "package") {
      if (typeof name !== "string" || !/^@fin\/[a-z0-9][a-z0-9-]*$/.test(name)) {
        bad(`${path}: an ${kind} entry needs a "name" of the form @fin/<name>`);
      } else if (names.has(name)) {
        bad(`${path}: the name ${name} is listed twice`);
      } else {
        names.add(name);
      }
    } else if (name !== undefined) {
      bad(`${path}: only app and package entries have a "name"`);
    }
    if (kind === "root") {
      roots++;
      if (path !== ".") bad('the root entry\'s "path" must be "."');
      if (
        !Array.isArray(entry.files) ||
        entry.files.some((f) => typeof f !== "string" || f.includes("/"))
      ) {
        bad('the root entry needs "files": the root files by name');
      }
    } else if (path === ".") {
      bad('only the root entry may have the path "."');
    }
    if (entry.static !== undefined) {
      const outputs = Array.isArray(entry.static) ? entry.static : [entry.static];
      if (
        kind !== "app" ||
        outputs.length === 0 ||
        outputs.some((o) => typeof o !== "string" || !o)
      ) {
        bad(`${path}: "static" names an app's static outputs (a string or an array of strings)`);
      }
    }
  }
  if (roots !== 1) bad("there must be exactly one root entry");
  if (findings.length > 0) return { findings };
  return { layout: /** @type {Layout} */ (/** @type {unknown} */ (raw)), findings };
}

/**
 * The entry a file belongs to: a root file by name, otherwise the longest path prefix.
 * @param {Layout} layout
 * @param {string} file
 * @returns {Entry | undefined}
 */
export function entryFor(layout, file) {
  if (!file.includes("/")) {
    const root = layout.entries.find((e) => e.kind === "root");
    if (root?.files?.includes(file)) return root;
  }
  /** @type {Entry | undefined} */
  let best;
  for (const entry of layout.entries) {
    if (entry.kind === "root") continue;
    if (file === entry.path || file.startsWith(`${entry.path}/`)) {
      if (best === undefined || entry.path.length > best.path.length) best = entry;
    }
  }
  return best;
}

/**
 * Reads CODEOWNERS into its patterns (leading slash removed), with findings for bad lines. GitHub
 * applies the last line that matches a path, so every line names exactly the control paths'
 * owner, and no pattern appears twice. Lines are split where any line break falls, and a carriage
 * return or another control character is refused, so no line can hide inside another.
 * @param {string} text
 * @param {string} [owner] the one owner every line names
 * @returns {{ patterns: { pattern: string, line: number }[], findings: Finding[] }}
 */
export function parseCodeowners(text, owner = CONTROL_PATH_OWNER) {
  /** @type {Finding[]} */
  const findings = [];
  /**
   * @param {number} line
   * @param {string} rule
   * @param {string} message
   */
  const add = (line, rule, message) => findings.push({ file: "CODEOWNERS", line, rule, message });
  const patterns = [];
  const seen = new Set();
  let lineNumber = 0;
  for (const lineBreak of text.matchAll(/\r\n|\r|\n/g)) {
    lineNumber++;
    if (lineBreak[0] !== "\n") {
      add(lineNumber, "codeowners-format", "a carriage return: line endings must be LF");
    }
  }
  for (const [index, raw] of text.split(/\r\n|\r|\n/).entries()) {
    if (/(?!\t)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(raw)) {
      add(index + 1, "codeowners-format", "a control or invisible character");
    }
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [pattern = "", ...owners] = line.split(/[ \t]+/);
    if (owners.length !== 1 || owners[0]?.toLowerCase() !== owner.toLowerCase()) {
      add(
        index + 1,
        "codeowners-owner",
        `each line names one path and exactly the control paths' owner, ${owner}`,
      );
    }
    const normalized = pattern.replace(/^\//, "");
    if (seen.has(normalized)) {
      add(index + 1, "codeowners-owner", `/${normalized} appears twice; GitHub applies the last`);
    }
    seen.add(normalized);
    patterns.push({ pattern: normalized, line: index + 1 });
  }
  return { patterns, findings };
}

/**
 * Runs every layout rule over the repository at `root`.
 * @param {string} root
 * @returns {{ findings: Finding[], warnings: Finding[] }}
 */
export function checkLayout(root) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Finding[]} */
  const warnings = [];
  if (!existsSync(join(root, LAYOUT))) {
    return {
      findings: [{ file: LAYOUT, rule: "layout-missing", message: "the file is missing" }],
      warnings,
    };
  }
  /** @type {unknown} */
  let raw;
  try {
    raw = readJson(join(root, LAYOUT));
  } catch {
    return {
      findings: [{ file: LAYOUT, rule: "layout-schema", message: "not valid JSON" }],
      warnings,
    };
  }
  const validated = validateLayout(raw);
  if (validated.layout === undefined) return { findings: validated.findings, warnings };
  const layout = validated.layout;
  const files = listFiles(root, { untracked: true });
  const exists = (/** @type {string} */ path) =>
    files.some((file) => file === path || file.startsWith(`${path}/`));

  // Every file belongs to an entry, and every apps/* and packages/* directory has its own.
  const ownDirs = new Set();
  for (const file of files) {
    const entry = entryFor(layout, file);
    if (entry === undefined) {
      findings.push({
        file,
        rule: "unmapped-file",
        message: "no entry in tools/layout.json covers this file",
      });
    }
    const top = /^(apps|packages)\/([^/]+)\//.exec(file);
    if (top && !ownDirs.has(`${top[1]}/${top[2]}`)) {
      ownDirs.add(`${top[1]}/${top[2]}`);
      if (!layout.entries.some((e) => e.path === `${top[1]}/${top[2]}`)) {
        findings.push({
          file: `${top[1]}/${top[2]}`,
          rule: "unlisted-package-dir",
          message: "this directory has no entry of its own in tools/layout.json",
        });
      }
    }
  }

  // Status: active paths exist; a planned path that exists is only a warning (BD-08).
  for (const entry of layout.entries) {
    if (entry.kind === "root") continue;
    if (entry.status === "active" && !exists(entry.path)) {
      findings.push({
        file: entry.path,
        rule: "active-missing",
        message: "an active entry's path does not exist",
      });
    }
    if (entry.status === "planned" && exists(entry.path)) {
      warnings.push({
        file: entry.path,
        rule: "planned-exists",
        message:
          'a planned entry\'s path exists; the steward flips it to "active" at the Phase 0 exit',
      });
    }
  }

  // Names in docs/plan/ must all be listed.
  const names = new Set(layout.entries.map((e) => e.name).filter(Boolean));
  const paths = new Set(layout.entries.map((e) => e.path));
  const foreign = new Set(layout.notFin.map((n) => n.path));
  for (const file of files.filter((f) => f.startsWith("docs/plan/") && f.endsWith(".md"))) {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(MENTION)) {
        const mention = match[1] ?? "";
        const listed = mention.startsWith("@fin/") ? names.has(mention) : paths.has(mention);
        if (!listed && !foreign.has(mention)) {
          findings.push({
            file,
            line: index + 1,
            rule: "plan-unlisted",
            message: `the plan names ${mention}, which no entry in tools/layout.json lists`,
          });
        }
      }
    }
  }

  // CODEOWNERS and controlPaths list the same paths.
  if (!files.includes("CODEOWNERS")) {
    findings.push({
      file: "CODEOWNERS",
      rule: "codeowners-missing",
      message: "the file is missing",
    });
  } else {
    const parsed = parseCodeowners(readFileSync(join(root, "CODEOWNERS"), "utf8"));
    findings.push(...parsed.findings);
    const owned = new Set(parsed.patterns.map((p) => p.pattern));
    for (const { pattern, line } of parsed.patterns) {
      if (!layout.controlPaths.includes(pattern)) {
        findings.push({
          file: "CODEOWNERS",
          line,
          rule: "codeowners-drift",
          message: `/${pattern} is not in tools/layout.json controlPaths`,
        });
      }
    }
    for (const controlPath of layout.controlPaths) {
      if (!owned.has(controlPath)) {
        findings.push({
          file: LAYOUT,
          rule: "codeowners-drift",
          message: `the control path ${controlPath} has no CODEOWNERS line`,
        });
      }
    }
  }

  // Static outputs: static.json exists as soon as the app does (planned or active: BD-08 relaxes
  // only the planned-exists rule) and is a control path, as is every header profile.
  const isControl = (/** @type {string} */ file) =>
    layout.controlPaths.some((cp) => coveredBy(file, cp));
  for (const entry of layout.entries.filter((e) => e.static !== undefined)) {
    const staticJson = `${entry.path}/static.json`;
    if (exists(entry.path) && !files.includes(staticJson)) {
      findings.push({
        file: staticJson,
        rule: "static-json-missing",
        message: "an app with a static output needs its static.json",
      });
    }
    if (!isControl(staticJson)) {
      findings.push({
        file: staticJson,
        rule: "static-not-control",
        message: "static.json must be a control path",
      });
    }
  }
  for (const file of files) {
    const isStaticJson = /^apps\/[^/]+\/static\.json$/.test(file);
    if ((isStaticJson || file.startsWith(STATIC_PROFILES_DIR)) && !isControl(file)) {
      findings.push({
        file,
        rule: "static-not-control",
        message: isStaticJson
          ? "static.json must be a control path"
          : "a header profile or its renderer must be a control path",
      });
    }
  }

  // Manifests are package.json only: pnpm reads the other formats too, and nothing checks them.
  // The root vitest.config.ts is the only Vitest configuration: the package scripts name it with
  // --config, so a package's own would be passed by without a word. Names are compared in lower
  // case, as a case-insensitive file system (macOS, Windows) matches them.
  for (const file of files) {
    const base = (file.split("/").pop() ?? "").toLowerCase();
    if (OTHER_MANIFESTS.has(base)) {
      findings.push({
        file,
        rule: "manifest-format",
        message: "pnpm reads this file as a package manifest; manifests are package.json only",
      });
    }
    if (file.includes("/") && /^vitest\.(?:config|workspace|projects)\.[cm]?[jt]s$/.test(base)) {
      findings.push({
        file,
        rule: "vitest-config",
        message:
          "the root vitest.config.ts is the only Vitest configuration; a setting a package needs goes there",
      });
    }
  }

  // A package's name matches its entry, and its tests run through the root Vitest configuration.
  for (const entry of layout.entries.filter((e) => e.name !== undefined)) {
    const manifest = `${entry.path}/package.json`;
    if (!files.includes(manifest)) continue;
    /** @type {unknown} */
    let parsed;
    try {
      parsed = readJson(join(root, manifest));
    } catch {
      findings.push({ file: manifest, rule: "package-name", message: "not valid JSON" });
      continue;
    }
    if (!isRecord(parsed) || parsed.name !== entry.name) {
      findings.push({
        file: manifest,
        rule: "package-name",
        message: `the package's name must be ${entry.name}, as tools/layout.json lists it`,
      });
    }
    findings.push(...checkTestScripts(manifest, isRecord(parsed) ? parsed.scripts : undefined));
  }
  return { findings, warnings };
}

/**
 * Checks that a package runs Vitest only through the root configuration: run from a package's
 * own directory, Vitest would otherwise use its defaults, which collect integration tests and
 * Playwright journeys into the unit run.
 * @param {string} manifest
 * @param {unknown} scripts
 * @returns {Finding[]}
 */
export function checkTestScripts(manifest, scripts) {
  /** @type {Finding[]} */
  const findings = [];
  if (!isRecord(scripts)) return findings;
  for (const [name, script] of Object.entries(scripts)) {
    if (typeof script !== "string" || !/\bvitest\b/.test(script)) continue;
    const expected = VITEST_SCRIPTS[/** @type {keyof typeof VITEST_SCRIPTS} */ (name)];
    if (script.trim() !== expected) {
      findings.push({
        file: manifest,
        rule: "vitest-config",
        message:
          expected === undefined
            ? `only the test and test:db scripts run Vitest (${name} does)`
            : `the ${name} script must be exactly "${expected}", so the root vitest.config.ts applies`,
      });
    }
  }
  return findings;
}

if (import.meta.main) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex > 0 ? (process.argv[rootIndex + 1] ?? ".") : process.cwd();
  const { findings, warnings } = checkLayout(root);
  process.exitCode = report("layout:check", findings, warnings);
}
