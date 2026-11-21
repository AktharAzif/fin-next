#!/usr/bin/env node
// supply-chain:check (spec 01 §4.2; ARCHITECTURE §7.13; DECISIONS G-06, SA-02). A control path.
// It refuses, in tracked files:
//   - pnpm-workspace.yaml with a policy key missing or changed, an unknown key, or a key that
//     loosens the policy (minimumReleaseAgeExclude, trustPolicyExclude, trustPolicyIgnoreAfter,
//     dangerouslyAllowAllBuilds, pnpmfile, globalPnpmfile, configDependencies, ...), or any line
//     the strict reader below cannot read as pnpm reads it (a carriage return, a tab, a control
//     character, a construct outside its YAML subset);
//   - an allowBuilds or overrides entry without a dated comment recording the owner's yes in one
//     of the fixed phrases (an allowBuilds entry set to false, meaning "never run this script", is
//     accepted with one);
//   - a catalog entry that is not one exact version;
//   - a pnpmfile or a .npmrc; a manifest pnpm reads other than package.json (package.yaml,
//     package.yml, package.json5); a workspace file or a lockfile below the root, which makes its
//     directory another workspace with its own settings; a symbolic link or a submodule, through
//     which pnpm would read a manifest this check does not; each of these by its name in any case,
//     since a case-insensitive file system gives pnpm `.NPMRC` as `.npmrc` (a manifest whose name
//     is package.json in another case is checked as one, and refused);
//   - a dependency spec that is a git URL, a tarball URL, a local path or an alias, an @fin/*
//     dependency that is not workspace:*, any other dependency, peer dependencies included (pnpm
//     installs peers itself), not taken from the catalog;
//   - a workspace package without "private": true, or a manifest field that bypasses the policy
//     (pnpm, resolutions, overrides, bundledDependencies);
//   - a refused package (FW-C01, OD-5, ARCHITECTURE §3.3's "not used" list) in a manifest, the
//     catalog or the lockfile; wrangler outside tools/static-deploy/package.json; @ui-sdk/*
//     outside packages/ui/package.json; seroval or seroval-plugins below 1.6.11;
//   - a lockfile line outside the one canonical form pnpm writes, a lockfile package resolved
//     from anything but the registry by integrity, an importer whose version is not the registry
//     version (or, for catalog:, not the catalog's), a dependency a snapshot lists by anything but
//     a registry version or alias (a link, a path, a tarball, a git URL), a dependency or a
//     snapshot with no registry package in its document, or a lockfile catalog entry that is not
//     the workspace catalog's;
//   - a root package.json whose pnpm pin is not exact, or lacks devEngines.packageManager with
//     onFail "error" (without it pnpm 12 downloads whatever packageManager names; SP-01);
//   - a `uses:` in .github/ (or in any action.yml) not pinned to a 40-character commit SHA with a
//     version comment, in any YAML spelling, or a local action outside .github/; either path is
//     read segment by segment, so an empty, `.` or `..` segment is refused.
//
// This file is self-contained (Node built-ins only, no import from another file of the
// repository), so every line that decides its verdict is under the control path and the owner's
// review (CI-14). For the same reason CI runs it directly, `node scripts/check-supply-chain.mjs`,
// not through a package.json script, which is not a control path.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

/** @typedef {{ file: string, line?: number, rule: string, message: string }} Finding */
/**
 * @typedef {string | number | boolean | null} Scalar
 * @typedef {{ value: Scalar, line: number, comment?: string, above?: string[] }} Item
 * @typedef {{ kind: "scalar", value: Scalar, line: number, comment?: string }
 *   | { kind: "list", items: Item[], line: number, comment?: string }
 *   | { kind: "map", entries: Map<string, Item>, line: number, comment?: string }} Node
 * @typedef {{ keys: Map<string, Node>, errors: { line: number, message: string }[] }} Policy
 */

const WORKSPACE = "pnpm-workspace.yaml";
const LOCKFILE = "pnpm-lock.yaml";

/** The exact package globs (spec 01 §4.2). */
export const PACKAGE_GLOBS = [
  "apps/*",
  "packages/*",
  "tools/fin-review",
  "tools/static-deploy",
  "ops/fin",
  "ops/monitoring",
  "ops/watcher",
  "ops/backup",
];

/** The policy settings and their only accepted values (spec 01 §4.2). */
export const REQUIRED = {
  minimumReleaseAge: 4320,
  minimumReleaseAgeStrict: true,
  minimumReleaseAgeIgnoreMissingTime: false,
  trustPolicy: "no-downgrade",
  blockExoticSubdeps: true,
  strictDepBuilds: true,
  engineStrict: true,
};

const ALLOWED_KEYS = new Set([
  "packages",
  ...Object.keys(REQUIRED),
  "allowBuilds",
  "catalog",
  "overrides",
]);

/** Keys named by spec 01 §4.2 as loosening the policy, with the reason each is refused. */
const LOOSENING = {
  minimumReleaseAgeExclude: "it exempts packages from the release age",
  trustPolicyExclude: "it exempts packages from the trust policy",
  trustPolicyIgnoreAfter: "it switches the trust policy off for older versions",
  dangerouslyAllowAllBuilds: "it lets every install script run",
  onlyBuiltDependencies: "install scripts are approved only through allowBuilds",
  neverBuiltDependencies: "install scripts are decided only through allowBuilds",
  ignoredBuiltDependencies: "install scripts are decided only through allowBuilds",
  pnpmfile: "a pnpmfile can rewrite any manifest at install time",
  globalPnpmfile: "a pnpmfile can rewrite any manifest at install time",
  configDependencies: "config dependencies run code before the policy applies",
  packageExtensions: "it adds dependencies the manifests do not show",
  patchedDependencies: "patches change package code after the registry's checks",
  catalogs: "one default catalog only, so every package has one version",
};

/**
 * Refused packages: [pattern, reason]. A pattern is an exact name or a glob over the name.
 * The first group is also refused in the lockfile, as a dependency of anything.
 * @type {[string, string][]}
 */
const REFUSED_EVERYWHERE = [
  ["@tanstack/react-start", "FW-C01: no server functions"],
  ["@tanstack/react-start-*", "FW-C01: no server functions"],
  ["@tanstack/start-*", "FW-C01: no server functions"],
  ["@vitejs/plugin-rsc", "FW-C01: no server components"],
  ["react-server-dom-*", "FW-C01: no server components"],
  ["@rsbuild/core", "FW-C01"],
  ["@radix-ui/*", "OD-5: controls come from @fin/ui on the UI SDK"],
  ["radix-ui", "OD-5: controls come from @fin/ui on the UI SDK"],
  ["@phosphor-icons/*", "OD-5: glyph data lives in @fin/icons"],
  ["clsx", "OD-5: use the in-house cn in @fin/ui"],
  ["tailwind-merge", "OD-5: use the in-house cn in @fin/ui"],
  ["@fontsource*", "G-06: the fonts are committed files in @fin/tokens"],
  ["@fontsource*/*", "G-06: the fonts are committed files in @fin/tokens"],
];

/** Refused as a direct dependency or catalog entry (ARCHITECTURE §3.3, "not used"). */
/** @type {[string, string][]} */
const REFUSED_DIRECT = [
  ...REFUSED_EVERYWHERE,
  ["tsx", "Node runs TypeScript itself"],
  ["@logtail/*", "Fin has its own log transport"],
  ["@opentelemetry/*", "no tracing at launch (OB-08)"],
  ["libphonenumber-js", "phones are accepted only in E.164"],
  ["redis", "no Redis"],
  ["ioredis", "no Redis"],
  ["@redis/*", "no Redis"],
  ["pg-boss", "a fallback only, with the owner's yes (P-11)"],
  ["@scalar/hono-api-reference", "it loads Scalar from a CDN"],
  ["@railway/cli", "its postinstall downloads a binary"],
  ["react-router-dom", "FW-C18: TanStack Router is the router"],
  ["@remix-run/*", "FW-C18"],
  ["drizzle-kit", "drafts only, outside the repository (G-06)"],
  ["jsdom", "no DOM test environment without the owner's yes"],
  ["happy-dom", "no DOM test environment without the owner's yes"],
  ["@vitest/browser*", "no DOM test environment without the owner's yes"],
  ["@axe-core/playwright", "only with the owner's yes"],
];

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const BYPASS_FIELDS = {
  pnpm: "pnpm settings belong in pnpm-workspace.yaml, under this check",
  resolutions: "pnpm applies it as overrides, outside this check",
  overrides: "overrides belong in pnpm-workspace.yaml, with a dated comment",
  bundledDependencies: "bundled packages skip the lockfile and the registry's checks",
  bundleDependencies: "bundled packages skip the lockfile and the registry's checks",
};
/** Manifest names pnpm reads besides package.json. */
const OTHER_MANIFESTS = new Set(["package.yaml", "package.yml", "package.json5"]);
/** Settings files a package manager reads from a directory, refused anywhere. */
const SETTINGS_FILES = new Set([".npmrc", ".pnpmrc", ".yarnrc", ".yarnrc.yml", ".yarnrc.yaml"]);
/**
 * The workspace file's name, and the misspellings pnpm looks for beside it (and stops on): below
 * the root, any of them makes its directory another workspace, with its own settings.
 */
const WORKSPACE_FILES = new Set([
  WORKSPACE,
  "pnpm-workspace.yml",
  "pnpm-workspaces.yaml",
  "pnpm-workspaces.yml",
]);

// --- Helpers (kept in this file: see the header) ---------------------------------------------

/**
 * Whether `value` is a plain object (not null, not an array).
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts a simple glob to a regular expression for a whole path or name: `**` matches any
 * number of path segments, `*` anything inside one segment, `?` one character inside a segment.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$+.()|[\]{}]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * The tracked entries of the repository at `root`, with their git modes, as [path, mode] pairs
 * sorted by path. Entries deleted from the working tree are left out; a symbolic link is kept
 * whether or not its target exists, and a submodule whether or not it is checked out.
 * @param {string} root
 * @returns {[string, string][]}
 */
function trackedEntries(root) {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z", "--stage"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  /** @type {Map<string, string>} */
  const entries = new Map();
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    entries.set(record.slice(tab + 1), record.slice(0, record.indexOf(" ")));
  }
  return [...entries]
    .filter(
      ([path, mode]) =>
        mode === "160000" || lstatSync(join(root, path), { throwIfNoEntry: false }) !== undefined,
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Formats a finding as `file:line rule: message`.
 * @param {Finding} finding
 * @returns {string}
 */
function formatFinding(finding) {
  const where = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  return `${where} ${finding.rule}: ${finding.message}`;
}

/**
 * Prints findings and returns the exit code: 0 with no findings, 1 otherwise.
 * @param {Finding[]} findings
 * @returns {number}
 */
function report(findings) {
  for (const finding of findings) console.error(formatFinding(finding));
  if (findings.length > 0) {
    console.error(`supply-chain:check: ${findings.length} finding(s)`);
    return 1;
  }
  console.log("supply-chain:check: ok");
  return 0;
}

/**
 * Splits text into lines the way YAML does (a line ends at LF, CR or CRLF), with an error for
 * every character the policy file and the lockfile may not hold: a carriage return (line endings
 * are LF only), a tab, any other control character, a Unicode line or paragraph separator, a
 * byte-order mark, or a replacement character (an invalid UTF-8 sequence). Line numbers count
 * YAML's lines, so a line a carriage return starts is reported as its own.
 * @param {string} text
 * @returns {{ lines: string[], errors: { line: number, message: string }[] }}
 */
export function yamlLines(text) {
  /** @type {string[]} */
  const lines = [];
  /** @type {{ line: number, message: string }[]} */
  const errors = [];
  let start = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    lines.push(text.slice(start, match.index));
    if (match[0] !== "\n") {
      errors.push({
        line: lines.length,
        message: "a carriage return: line endings must be LF (YAML ends a line at a CR too)",
      });
    }
    start = match.index + match[0].length;
  }
  lines.push(text.slice(start));
  for (const [index, line] of lines.entries()) {
    if (line.includes("\t")) errors.push({ line: index + 1, message: "tabs are not allowed" });
    // Controls (C0 but the tab, DEL, C1), format characters (the byte-order mark, bidirectional
    // controls, zero-width characters), the line and paragraph separators, and U+FFFD.
    const bad = /(?!\t)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{FFFD}]/u.exec(line);
    if (bad) {
      const code = (bad[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
      errors.push({
        line: index + 1,
        message: `the character U+${code} is not allowed (a control, separator or invisible character)`,
      });
    }
  }
  return { lines, errors };
}

// --- The policy file's reader -----------------------------------------------------------------
// pnpm-workspace.yaml is kept to a small subset of YAML so that what this reader sees is exactly
// what pnpm sees: top-level keys with a plain scalar, `{}` or `[]`, a block list of scalars, or a
// block map of scalar values one level deep, each line with an optional trailing `# comment`,
// LF line endings. Anything else (anchors, aliases, tags, flow collections with content,
// multi-line scalars, several documents, deeper nesting, tabs, carriage returns and other
// control characters) is refused, because a construct this reader skipped could change pnpm's
// settings without the check noticing. Lines are split where YAML splits them, so even a
// refused carriage return cannot hide a key from the checks that follow.

/**
 * Splits a line into its content and trailing comment. A `#` starts a comment only at the start
 * of the content or after whitespace, and never inside quotes.
 * @param {string} text
 * @returns {{ content: string, comment?: string }}
 */
function splitComment(text) {
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "#" && (i === 0 || /\s/.test(text.charAt(i - 1)))) {
      return { content: text.slice(0, i).trimEnd(), comment: text.slice(i).trim() };
    }
  }
  return { content: text.trimEnd() };
}

/**
 * Parses a scalar the way YAML 1.2's core schema would for the forms the policy uses.
 * @param {string} text
 * @returns {Scalar | undefined} undefined when the form is outside the subset
 */
export function parseScalar(text) {
  if (/^'([^']|'')*'$/.test(text)) return text.slice(1, -1).replaceAll("''", "'");
  if (/^"[^"\\]*"$/.test(text)) return text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?(0|[1-9][0-9]*)$/.test(text)) return Number(text);
  // Plain scalars: refuse indicators that would mean something else to a full YAML parser.
  if (
    text === "" ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(text) ||
    /: |\s#/.test(text) ||
    text.endsWith(":")
  ) {
    return undefined;
  }
  return text;
}

/**
 * Parses a key (a plain or quoted scalar used as a map key).
 * @param {string} text
 * @returns {string | undefined}
 */
function parseKey(text) {
  if (text !== text.trim()) return undefined; // no space before the colon
  const value = parseScalar(text);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * Finds the `key: value` split outside quotes.
 * @param {string} content
 * @returns {{ key: string, rest: string } | undefined}
 */
function splitKey(content) {
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < content.length; i++) {
    const char = content.charAt(i);
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === ":" && (i === content.length - 1 || content.charAt(i + 1) === " ")) {
      return { key: content.slice(0, i), rest: content.slice(i + 1).trim() };
    }
  }
  return undefined;
}

/**
 * Parses the policy file.
 * @param {string} text
 * @returns {Policy}
 */
export function parsePolicy(text) {
  /** @type {Map<string, Node>} */
  const keys = new Map();
  const { lines, errors } = yamlLines(text);
  /** @type {Node | null} */
  let open = null; // the top-level block list or map being filled
  /** @type {string[]} */
  let pendingComments = []; // whole-line comments just above the next item
  /** @type {number | null} */
  let childIndent = null;

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (raw.includes("\t")) continue; // reported by yamlLines
    if (/^(---|\.\.\.)(\s|$)/.test(raw) || raw.startsWith("%")) {
      errors.push({ line, message: "one document only, with no directives" });
      continue;
    }
    const { content, comment } = splitComment(raw);
    if (content.trim() === "") {
      if (comment !== undefined && raw.trimStart().startsWith("#")) pendingComments.push(comment);
      else pendingComments = [];
      continue;
    }
    const indent = content.length - content.trimStart().length;
    const body = content.trim();
    if (/(^|[\s[{,])[&*!][^\s]/.test(body) || /[|>][-+]?$/.test(body)) {
      errors.push({ line, message: "anchors, aliases, tags and block scalars are not allowed" });
      continue;
    }

    if (indent === 0) {
      open = null;
      childIndent = null;
      pendingComments = [];
      const split = splitKey(body);
      const key = split ? parseKey(split.key) : undefined;
      if (split === undefined || key === undefined) {
        errors.push({ line, message: "expected a top-level `key: value`" });
        continue;
      }
      if (keys.has(key)) {
        errors.push({ line, message: `the key ${key} appears twice` });
        continue;
      }
      /** @type {Node} */
      let node;
      if (split.rest === "") {
        node = { kind: "map", entries: new Map(), line }; // becomes a list if items follow
        open = node;
      } else if (split.rest === "{}") {
        node = { kind: "map", entries: new Map(), line };
      } else if (split.rest === "[]") {
        node = { kind: "list", items: [], line };
      } else {
        const value = parseScalar(split.rest);
        if (value === undefined) {
          // Keep the key, so the checks still see that it is present.
          errors.push({ line, message: `the value of ${key} is outside the supported subset` });
        }
        node = { kind: "scalar", value: value ?? null, line };
      }
      if (comment !== undefined) node.comment = comment;
      keys.set(key, node);
      continue;
    }

    if (open === null) {
      errors.push({ line, message: "an indented line must belong to a top-level list or map" });
      continue;
    }
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) {
      errors.push({ line, message: "only one level of nesting, with one indentation, is allowed" });
      continue;
    }
    /** @type {Item} */
    const item = { value: null, line };
    if (comment !== undefined) item.comment = comment;
    if (pendingComments.length > 0) item.above = pendingComments;
    pendingComments = [];

    if (body.startsWith("- ") || body === "-") {
      if (open.kind === "map" && open.entries.size === 0) {
        const list = /** @type {Node} */ ({ kind: "list", items: [], line: open.line });
        if (open.comment !== undefined) list.comment = open.comment;
        for (const [k, v] of keys) if (v === open) keys.set(k, list);
        open = list;
      }
      const value = parseScalar(body.slice(2).trim());
      if (open.kind !== "list" || value === undefined) {
        errors.push({ line, message: "a list item must be a scalar in a list" });
        continue;
      }
      item.value = value;
      open.items.push(item);
      continue;
    }
    if (open.kind !== "map") {
      errors.push({ line, message: "a list cannot also hold `key: value` lines" });
      continue;
    }
    const split = splitKey(body);
    const key = split ? parseKey(split.key) : undefined;
    const value = split ? parseScalar(split.rest) : undefined;
    if (split === undefined || key === undefined || value === undefined) {
      errors.push({ line, message: "a map entry must be `key: scalar`" });
      continue;
    }
    if (open.entries.has(key)) {
      errors.push({ line, message: `the key ${key} appears twice` });
      continue;
    }
    item.value = value;
    open.entries.set(key, item);
  }
  errors.sort((a, b) => a.line - b.line);
  return { keys, errors };
}

// --- The policy file --------------------------------------------------------------------------

/**
 * @param {string} name
 * @param {[string, string][]} list
 * @returns {string | undefined} the reason when refused
 */
export function refusedReason(name, list) {
  for (const [pattern, why] of list) {
    if (pattern.includes("*") ? globToRegExp(pattern).test(name) : name === pattern) return why;
  }
  return undefined;
}

/**
 * The phrases a dated approval states the owner's yes with, after `# YYYY-MM-DD: `. Each may be
 * followed by a note after a comma, semicolon, colon or parenthesis, but never by a word that
 * takes the yes back.
 */
export const APPROVAL_PHRASES = [
  "approved by the owner",
  "the owner's yes",
  "owner's yes",
  "approved by the orchestrator under the owner's delegation",
];
const NEGATION =
  /\b(?:no|not|never|nor|refused|refuses|refuse|declined|declines|denied|rejected|revoked|withdrawn|withheld|pending|awaiting|waiting|until|unless|without|maybe|tbd|todo|if)\b|n't\b/i;

/**
 * Whether a comment is a dated approval: `# YYYY-MM-DD: <one of APPROVAL_PHRASES>[, note]`, with
 * a real calendar date and no negation anywhere in its text.
 * @param {string | undefined} comment
 * @returns {boolean}
 */
export function isDatedApproval(comment) {
  if (comment === undefined) return false;
  const match = /^#\s*(\d{4})-(\d{2})-(\d{2}):\s*(.+?)\s*$/.exec(comment);
  if (!match) return false;
  const [, y, m, d, raw = ""] = match;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== `${y}-${m}-${d}`)
    return false;
  const text = raw.replaceAll("\u2019", "'").toLowerCase();
  if (NEGATION.test(text)) return false;
  return APPROVAL_PHRASES.some(
    (phrase) =>
      text === phrase ||
      (text.startsWith(phrase) &&
        /^[-.,;:(\u{2013}\u{2014}]/u.test(text.slice(phrase.length).trimStart())),
  );
}

/**
 * The dated comment on an item, trailing or on the line just above.
 * @param {Item} item
 * @returns {boolean}
 */
function hasDatedApproval(item) {
  return isDatedApproval(item.comment) || (item.above ?? []).some(isDatedApproval);
}

/**
 * Classifies a dependency spec that is not a plain version or range.
 * @param {string} spec
 * @returns {string | undefined} what kind of exotic spec it is
 */
export function exoticKind(spec) {
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/.test(spec) || /\.git(#.*)?$/.test(spec))
    return "a git URL";
  if (/^https?:/.test(spec)) return "a tarball URL";
  if (/^(file:|link:|portal:|\.{0,2}\/|~)/.test(spec)) return "a local path";
  if (spec.startsWith("npm:") || spec.startsWith("jsr:")) return "an alias";
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec)) return "a git URL (GitHub shorthand)";
  return undefined;
}

/**
 * Checks pnpm-workspace.yaml.
 * @param {string} text
 * @returns {{ findings: Finding[], catalog: Map<string, Item> }}
 */
export function checkWorkspace(text) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Map<string, Item>} */
  let catalog = new Map();
  /**
   * @param {number | undefined} line
   * @param {string} rule
   * @param {string} message
   */
  const add = (line, rule, message) =>
    findings.push({ file: WORKSPACE, ...(line === undefined ? {} : { line }), rule, message });
  const { keys, errors } = parsePolicy(text);
  for (const error of errors) add(error.line, "policy-syntax", error.message);

  for (const [key, node] of keys) {
    if (key in LOOSENING) {
      add(
        node.line,
        "policy-loosened",
        `${key} is refused: ${LOOSENING[/** @type {keyof typeof LOOSENING} */ (key)]}`,
      );
    } else if (!ALLOWED_KEYS.has(key)) {
      add(
        node.line,
        "policy-unknown-key",
        `${key} is not one of the policy's keys; a new setting needs the owner`,
      );
    }
  }
  for (const [key, expected] of Object.entries(REQUIRED)) {
    const node = keys.get(key);
    if (node === undefined)
      add(undefined, "policy-missing", `${key} is missing (it must be ${expected})`);
    else if (node.kind !== "scalar" || node.value !== expected) {
      add(node.line, "policy-changed", `${key} must be ${expected}`);
    }
  }

  const packages = keys.get("packages");
  const globs = packages?.kind === "list" ? packages.items.map((i) => i.value) : undefined;
  if (globs === undefined || globs.join("\n") !== PACKAGE_GLOBS.join("\n")) {
    add(
      packages?.line,
      "policy-packages",
      `packages must list exactly: ${PACKAGE_GLOBS.join(", ")}`,
    );
  }

  const allowBuilds = keys.get("allowBuilds");
  if (allowBuilds === undefined)
    add(undefined, "policy-missing", "allowBuilds is missing (it must be a map, {} when empty)");
  else if (allowBuilds.kind !== "map")
    add(allowBuilds.line, "policy-changed", "allowBuilds must be a map");
  else {
    for (const [name, item] of allowBuilds.entries) {
      if (typeof item.value !== "boolean") {
        add(item.line, "allow-builds-value", `allowBuilds ${name} must be true or false`);
      }
      if (!hasDatedApproval(item)) {
        add(
          item.line,
          "allow-builds-undated",
          `allowBuilds ${name} needs a dated comment recording the owner's yes (# YYYY-MM-DD: approved by the owner)`,
        );
      }
    }
  }

  const overrides = keys.get("overrides");
  if (overrides !== undefined) {
    if (overrides.kind !== "map") add(overrides.line, "overrides-shape", "overrides must be a map");
    else {
      for (const [name, item] of overrides.entries) {
        if (typeof item.value !== "string" || !EXACT_VERSION.test(item.value)) {
          add(item.line, "overrides-version", `overrides ${name} must pin one exact version`);
        }
        if (!hasDatedApproval(item)) {
          add(
            item.line,
            "overrides-undated",
            `overrides ${name} needs a dated comment recording the owner's yes (# YYYY-MM-DD: approved by the owner)`,
          );
        }
      }
    }
  }

  const catalogNode = keys.get("catalog");
  if (catalogNode !== undefined && catalogNode.kind !== "map") {
    add(catalogNode.line, "catalog-shape", "catalog must be a map of package to exact version");
  } else if (catalogNode !== undefined) {
    catalog = catalogNode.entries;
    for (const [name, item] of catalog) {
      if (typeof item.value !== "string" || !EXACT_VERSION.test(item.value)) {
        add(
          item.line,
          "catalog-version",
          `catalog ${name} must be one exact version, never a range or tag`,
        );
      }
      const why = refusedReason(name, REFUSED_DIRECT);
      if (why !== undefined) add(item.line, "refused-package", `${name} is refused (${why})`);
    }
    // Packages that move together (EX-30, SA-02).
    for (const group of [
      ["@ui-sdk/react", "@ui-sdk/core"],
      ["better-auth", "@better-auth/core", "@better-auth/passkey", "@better-auth/drizzle-adapter"],
    ]) {
      const versions = new Set(
        group.filter((n) => catalog.has(n)).map((n) => catalog.get(n)?.value),
      );
      if (versions.size > 1)
        add(
          catalog.get(group[0] ?? "")?.line,
          "catalog-group",
          `${group.join(", ")} must share one version`,
        );
    }
  }
  if (overrides?.kind === "map") {
    const core = overrides.entries.get("@better-auth/core");
    const betterAuth = catalog.get("better-auth");
    if (core !== undefined && betterAuth !== undefined && core.value !== betterAuth.value) {
      add(
        core.line,
        "overrides-better-auth",
        "the @better-auth/core override must equal better-auth's version (SA-02)",
      );
    }
  }
  return { findings, catalog };
}

// --- Manifests --------------------------------------------------------------------------------

/**
 * Checks one manifest.
 * @param {string} file the manifest's path
 * @param {unknown} manifest
 * @param {Map<string, Item>} catalog
 * @returns {Finding[]}
 */
export function checkManifest(file, manifest, catalog) {
  /** @type {Finding[]} */
  const findings = [];
  /**
   * @param {string} rule
   * @param {string} message
   */
  const add = (rule, message) => findings.push({ file, rule, message });
  if (!isRecord(manifest)) {
    add("manifest-shape", "a manifest must be a JSON object");
    return findings;
  }
  if (manifest.private !== true)
    add("not-private", 'every workspace package needs "private": true');
  for (const [field, why] of Object.entries(BYPASS_FIELDS)) {
    if (field in manifest) add("manifest-bypass", `the "${field}" field is refused: ${why}`);
  }
  for (const field of DEP_FIELDS) {
    const deps = manifest[field];
    if (deps === undefined) continue;
    if (!isRecord(deps)) {
      add("manifest-shape", `${field} must be an object`);
      continue;
    }
    for (const [name, rawSpec] of Object.entries(deps)) {
      const spec = typeof rawSpec === "string" ? rawSpec.trim() : "";
      const at = `${field} ${name}`;
      if (spec === "") {
        add("dependency-spec", `${at} must be a string`);
        continue;
      }
      const why = refusedReason(name, REFUSED_DIRECT);
      if (why !== undefined) add("refused-package", `${at} is refused (${why})`);
      if (name === "wrangler" && file !== "tools/static-deploy/package.json") {
        add(
          "wrangler-outside-static-deploy",
          `${at}: wrangler is allowed only in tools/static-deploy/package.json (FD-19)`,
        );
      }
      if (name.startsWith("@ui-sdk/") && file !== "packages/ui/package.json") {
        add(
          "ui-sdk-outside-ui",
          `${at}: only packages/ui/package.json may list @ui-sdk/* (EXECUTION §1.3)`,
        );
      }
      if (name.startsWith("@fin/")) {
        if (spec !== "workspace:*") {
          add(
            "fin-not-workspace",
            `${at} must be workspace:* (the @fin scope on npm belongs to someone else)`,
          );
        }
        continue;
      }
      const exotic = exoticKind(spec);
      if (exotic !== undefined) {
        add(
          "exotic-dependency",
          `${at} is ${exotic}; dependencies come from the registry through the catalog`,
        );
        continue;
      }
      if (spec.startsWith("workspace:")) {
        add("workspace-not-fin", `${at}: only @fin/* packages are workspace dependencies`);
        continue;
      }
      // Peers too: pnpm installs a missing peer itself (autoInstallPeers), so a peer range is a
      // dependency the catalog never approved.
      if (spec !== "catalog:" && spec !== "catalog:default") {
        add(
          "not-from-catalog",
          field === "peerDependencies"
            ? `${at} must be catalog: (pnpm installs peers itself, so a peer comes from the catalog like any dependency)`
            : `${at} must be catalog: (one exact version per package, in pnpm-workspace.yaml)`,
        );
        continue;
      }
      if (!catalog.has(name)) {
        add("catalog-missing", `${at} uses catalog: but the catalog has no ${name}`);
      }
    }
  }
  return findings;
}

/**
 * Checks the root manifest's pnpm pin. `packageManager`, `engines.pnpm` and
 * `devEngines.packageManager` name one exact version, and `devEngines.packageManager.onFail` is
 * "error": SP-01 showed that pnpm 12.21.0, by default, downloads and runs whatever version
 * `packageManager` names, while with this devEngines entry it never switches and refuses a
 * mismatch instead.
 * @param {string} file
 * @param {unknown} manifest
 * @returns {Finding[]}
 */
export function checkPackageManager(file, manifest) {
  /** @type {Finding[]} */
  const findings = [];
  /** @param {string} message */
  const add = (message) => findings.push({ file, rule: "package-manager", message });
  if (!isRecord(manifest)) return findings;
  const pm = typeof manifest.packageManager === "string" ? manifest.packageManager : "";
  const pin = /^pnpm@(\d+\.\d+\.\d+)(\+sha(256|512)\.[0-9a-f]+)?$/.exec(pm);
  if (pin === null) {
    add("packageManager must pin one exact pnpm version");
    return findings;
  }
  const engines = isRecord(manifest.engines) ? manifest.engines : {};
  if (engines.pnpm !== pin[1]) add("engines.pnpm must equal the packageManager version");
  const dev = isRecord(manifest.devEngines) ? manifest.devEngines.packageManager : undefined;
  if (!isRecord(dev) || dev.name !== "pnpm" || dev.version !== pin[1] || dev.onFail !== "error") {
    add(
      'devEngines.packageManager must be { "name": "pnpm", "version": <the packageManager version>, "onFail": "error" }, so pnpm refuses a mismatch instead of downloading another pnpm',
    );
  }
  return findings;
}

// --- The lockfile -----------------------------------------------------------------------------

/**
 * Compares two versions (major.minor.patch, prerelease below release).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const parse = (/** @type {string} */ v) => {
    const [core = "", pre] = v.split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const LOCK_SECTIONS = new Set([
  "settings",
  "catalogs",
  "overrides",
  "importers",
  "packages",
  "snapshots",
]);
/** The fields pnpm writes on a package (`packages:`) and a snapshot (`snapshots:`) in v9. */
const PACKAGE_FIELDS = new Set([
  "resolution",
  "engines",
  "cpu",
  "os",
  "libc",
  "hasBin",
  "deprecated",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundledDependencies",
]);
/** The package fields pnpm writes as a block below their key. */
const PACKAGE_BLOCK_FIELDS = new Set(["peerDependencies", "peerDependenciesMeta"]);
const SNAPSHOT_FIELDS = new Set([
  "dependencies",
  "optionalDependencies",
  "transitivePeerDependencies",
  "optional",
]);
const IMPORTER_FIELDS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "dependenciesMeta",
  "publishDirectory",
  "configDependencies",
  "packageManagerDependencies",
]);
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const PEERS = String.raw`(?:\([^\s'"]+\))*`;
const NAME = String.raw`(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+`;
const REGISTRY_RESOLUTION = /^\{integrity: sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}\}$/;

/**
 * Whether a lockfile value is one complete single-line YAML scalar or flow collection of the
 * kinds pnpm writes: balanced quotes and brackets, and no indicator that starts a block scalar,
 * an anchor, an alias, a tag, a directive or a comment.
 * @param {string} value
 * @returns {boolean}
 */
function simpleValue(value) {
  if (value === "") return true;
  if (/^[|>&*!%@`#]/.test(value) || /^[-?:](?:\s|$)/.test(value)) return false;
  /** @type {string[]} */
  const stack = [];
  /** @type {string | null} */
  let quote = null;
  let tokenStart = true;
  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i);
    if (quote === "'") {
      if (char === "'") {
        if (value.charAt(i + 1) === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (char === "\\") i++;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === " ") continue;
    if (char === "#" && value.charAt(i - 1) === " ") return false; // a comment
    const inFlow = stack.length > 0;
    if (tokenStart) {
      // Inside a flow collection a token may not start an anchor, alias, tag, explicit key or
      // block scalar either.
      if (inFlow && /[&*!|>%@`?]/.test(char)) return false;
      if (char === "'" || char === '"') {
        quote = char;
        tokenStart = false;
        continue;
      }
    }
    if ((char === "{" || char === "[") && (inFlow || tokenStart)) {
      stack.push(char === "{" ? "}" : "]");
      tokenStart = true;
      continue;
    }
    if (inFlow && (char === "}" || char === "]")) {
      if (stack.pop() !== char) return false;
      tokenStart = false;
      continue;
    }
    if (inFlow && char === ",") {
      tokenStart = true;
      continue;
    }
    if (char === ":" && (value.charAt(i + 1) === " " || i === value.length - 1)) {
      if (!inFlow) return false; // `a: b` or `a:` inside a plain scalar: another mapping
      tokenStart = true;
      continue;
    }
    tokenStart = false; // a quote inside a plain scalar is an ordinary character
  }
  return quote === null && stack.length === 0;
}

/**
 * Reads one lockfile line's content (its indentation removed) in the forms pnpm writes: a key
 * (plain, or single-quoted) with an optional inline value, or a sequence item.
 * @param {string} content
 * @returns {{ key: string, value: string } | { item: string } | undefined}
 */
function lockEntry(content) {
  if (content.startsWith("- ")) {
    const item = content.slice(2);
    return simpleValue(item) && item !== "" ? { item } : undefined;
  }
  const quoted = /^'((?:[^']|'')+)':(?: (.*))?$/.exec(content);
  const plain = quoted
    ? null
    : /^([A-Za-z0-9._~/()+-](?:[^\s:'"#]|:(?=\S))*):(?: (.*))?$/.exec(content);
  const match = quoted ?? plain;
  if (!match) return undefined;
  const key = quoted ? (match[1] ?? "").replaceAll("''", "'") : (match[1] ?? "");
  const value = match[2] ?? "";
  if (match[2] !== undefined && value === "") return undefined; // `key: ` with a trailing space
  if (!simpleValue(value)) return undefined;
  return { key, value };
}

/**
 * Reads a lockfile value pnpm writes as a plain or single-quoted scalar.
 * @param {string} value
 * @returns {string | undefined} undefined for any other form
 */
function lockScalar(value) {
  if (/^'(?:[^']|'')*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'");
  return /^[^'"\s{[]\S*$/.test(value) ? value : undefined;
}

/**
 * Checks the lockfile, every document in it. pnpm writes one canonical form: LF line endings,
 * two spaces per level, `name@version` keys, a `resolution: {integrity: ...}` for every package,
 * one complete value per line. This check reads only that form, and any line it cannot place is
 * a finding, so a hand edit (a quoted key, another indentation, a multi-line value, a field pnpm
 * never writes) cannot hide a package or its resolution from the rules. Every dependency pnpm
 * installs is read, an importer's or a snapshot's: a snapshot's is a registry version (`1.2.3`,
 * with any peer suffix) or a registry alias (`name@1.2.3`), never a link, a path, a tarball or a
 * git URL, and each one, like each snapshot, must be a registry package the same document holds.
 * @param {string} text
 * @param {Map<string, Item>} [catalog] the workspace catalog, to compare catalog: importers with
 * @returns {Finding[]}
 */
export function checkLockfile(text, catalog = new Map()) {
  /** @type {Finding[]} */
  const findings = [];
  /**
   * @param {number} line
   * @param {string} rule
   * @param {string} message
   */
  const add = (line, rule, message) => findings.push({ file: LOCKFILE, line, rule, message });
  const { lines, errors } = yamlLines(text);
  for (const error of errors) add(error.line, "lockfile-format", error.message);

  let section = "";
  let previousDepth = 0;
  let previousOpen = true; // whether the previous line can have children (a key with no value)
  /** @type {{ key: string, line: number, resolutions: number, fields: Set<string> } | undefined} */
  let pkg;
  let field = ""; // the depth-4 field the current lines belong to
  let child = ""; // the depth-6 key the current depth-8 lines belong to
  let importer = "."; // the importer (a workspace project's path) the current lines belong to
  /** @type {{ name: string, line: number, specifier?: string, version?: string, versionLine?: number } | undefined} */
  let dep;
  /** @type {{ name: string, line: number, specifier?: string, version?: string } | undefined} */
  let catalogEntry;
  const workspaceDirs = PACKAGE_GLOBS.map((glob) => globToRegExp(glob));
  const plainRef = new RegExp(`^${SEMVER}${PEERS}$`);
  const aliasRef = new RegExp(`^(${NAME})@${SEMVER}${PEERS}$`);
  const plainName = new RegExp(`^${NAME}$`);
  // Per document: its packages, its snapshots, and the snapshots its dependencies name.
  /** @type {Set<string>} */
  let packageKeys = new Set();
  /** @type {Map<string, number>} */
  let snapshotKeys = new Map();
  /** @type {{ depPath: string, line: number, from: string }[]} */
  let references = [];

  const closePackage = () => {
    if (pkg !== undefined && section === "packages" && pkg.resolutions === 0) {
      add(pkg.line, "exotic-resolution", `${pkg.key} has no registry resolution`);
    }
    pkg = undefined;
  };
  const closeDep = () => {
    if (dep === undefined) return;
    const { name, specifier, version, versionLine = dep.line } = dep;
    dep = undefined;
    if (version === undefined || specifier === undefined) {
      add(
        versionLine,
        "lockfile-format",
        `the importer entry ${name} needs a specifier and a version`,
      );
      return;
    }
    const link = version.startsWith("link:");
    // A workspace link points at a workspace project, inside the repository.
    const target = link ? posix.normalize(posix.join(importer, version.slice(5))) : "";
    const linkOk = specifier === "workspace:*" && workspaceDirs.some((dir) => dir.test(target));
    if (link ? !linkOk : !plainRef.test(version)) {
      add(
        versionLine,
        "exotic-resolution",
        `the importer entry ${name} is not a registry version (or a workspace:* link to a workspace project)`,
      );
      return;
    }
    if (!link) references.push({ depPath: `${name}@${version}`, line: versionLine, from: name });
    const pinned = catalog.get(name)?.value;
    const fromCatalog = specifier === "catalog:" || specifier === "catalog:default";
    if (fromCatalog && !link && version.replace(/\(.*$/, "") !== pinned) {
      add(
        versionLine,
        "lockfile-catalog",
        `${name} is locked at a version other than the catalog's`,
      );
    }
  };
  const closeCatalogEntry = () => {
    if (catalogEntry === undefined) return;
    const { name, line, specifier, version } = catalogEntry;
    catalogEntry = undefined;
    const pinned = catalog.get(name)?.value;
    if (specifier === undefined || version === undefined) {
      add(line, "lockfile-format", `the catalog entry ${name} needs a specifier and a version`);
    } else if (pinned === undefined || specifier !== pinned || version !== pinned) {
      add(
        line,
        "lockfile-catalog",
        `the lockfile's catalog entry ${name} is not the workspace catalog's exact version`,
      );
    }
  };
  const closeDocument = () => {
    for (const [key, line] of snapshotKeys) {
      if (!packageKeys.has(key.replace(/\(.*$/, ""))) {
        add(line, "exotic-resolution", `the snapshot ${key} has no registry package entry`);
      }
    }
    for (const { depPath, line, from } of references) {
      if (!snapshotKeys.has(depPath)) {
        add(
          line,
          "exotic-resolution",
          `${from} depends on ${depPath}, which this lockfile document does not hold`,
        );
      }
    }
    packageKeys = new Set();
    snapshotKeys = new Map();
    references = [];
  };
  /**
   * A dependency a snapshot lists: a registry version, with any peer suffix, or a registry alias.
   * @param {{ key: string, value: string }} entry
   * @param {number} line
   * @param {string} owner
   */
  const snapshotDependency = (entry, line, owner) => {
    const ref = lockScalar(entry.value);
    const alias = ref === undefined ? null : aliasRef.exec(ref);
    if (
      !plainName.test(entry.key) ||
      ref === undefined ||
      (alias === null && !plainRef.test(ref))
    ) {
      add(
        line,
        "exotic-resolution",
        `${owner} depends on ${entry.key} by something other than a registry version (a link, a path, a tarball or a git URL)`,
      );
      return;
    }
    for (const name of new Set([entry.key, alias?.[1] ?? entry.key])) {
      const why = refusedReason(name, REFUSED_EVERYWHERE);
      if (why !== undefined) {
        add(line, "refused-package", `${name} is in the lockfile but refused (${why})`);
      }
    }
    references.push({ depPath: alias === null ? `${entry.key}@${ref}` : ref, line, from: owner });
  };

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (raw.trim() === "") continue;
    const depth = raw.length - raw.trimStart().length;
    const content = raw.slice(depth);
    if (depth === 0 && content === "---") {
      closeDep();
      closeCatalogEntry();
      closePackage();
      closeDocument();
      section = "";
      previousDepth = 0;
      previousOpen = true;
      continue;
    }
    if (content.startsWith("#")) {
      add(line, "lockfile-format", "pnpm writes no comments in the lockfile");
      continue;
    }
    const entry = lockEntry(content);
    if (
      entry === undefined ||
      depth % 2 !== 0 ||
      depth > 8 ||
      depth > previousDepth + 2 ||
      (depth > previousDepth && !previousOpen)
    ) {
      add(line, "lockfile-format", "a lockfile line this check cannot read (not pnpm's form)");
      previousDepth = depth;
      previousOpen = false;
      continue;
    }
    previousDepth = depth;
    previousOpen = "key" in entry && entry.value === "";

    if (depth === 0) {
      closeDep();
      closeCatalogEntry();
      closePackage();
      if (!("key" in entry)) {
        add(line, "lockfile-format", "a lockfile line this check cannot read (not pnpm's form)");
        continue;
      }
      if (entry.key === "lockfileVersion") {
        section = "";
        if (entry.value !== "'9.0'") add(line, "lockfile-format", "lockfileVersion must be '9.0'");
      } else if (LOCK_SECTIONS.has(entry.key) && (entry.value === "" || entry.value === "{}")) {
        section = entry.key;
      } else {
        section = "";
        add(line, "lockfile-format", `a top-level ${entry.key} this check does not read`);
      }
      continue;
    }

    if (section === "packages" || section === "snapshots") {
      if (depth === 2) {
        closePackage();
        const key =
          "key" in entry
            ? new RegExp(`^(${NAME})@(${SEMVER})(${section === "snapshots" ? PEERS : ""})$`).exec(
                entry.key,
              )
            : null;
        const valueOk =
          "key" in entry &&
          (entry.value === "" || (section === "snapshots" && entry.value === "{}"));
        if (!("key" in entry) || !valueOk) {
          add(line, "lockfile-format", "a lockfile package key this check cannot read");
          continue;
        }
        pkg = { key: entry.key, line, resolutions: 0, fields: new Set() };
        if (key === null) {
          add(line, "exotic-resolution", `${entry.key} is not a registry name@version`);
          continue;
        }
        if (section === "packages") packageKeys.add(entry.key);
        else snapshotKeys.set(entry.key, line);
        const [, name = "", version = ""] = key;
        const why = refusedReason(name, REFUSED_EVERYWHERE);
        if (why !== undefined) {
          add(line, "refused-package", `${name} is in the lockfile but refused (${why})`);
        }
        if (
          (name === "seroval" || name === "seroval-plugins") &&
          compareVersions(version, "1.6.11") < 0
        ) {
          add(line, "seroval-floor", `${name} ${version} is below the 1.6.11 floor`);
        }
        continue;
      }
      if (pkg === undefined) {
        add(line, "lockfile-format", "a lockfile line this check cannot read (not pnpm's form)");
        continue;
      }
      if (depth === 4) {
        field = "";
        if (!("key" in entry)) {
          add(line, "lockfile-format", "a lockfile line this check cannot read (not pnpm's form)");
          continue;
        }
        const allowed = section === "packages" ? PACKAGE_FIELDS : SNAPSHOT_FIELDS;
        if (!allowed.has(entry.key)) {
          add(line, "lockfile-format", `${entry.key} is not a field pnpm writes in ${section}`);
          continue;
        }
        if (pkg.fields.has(entry.key)) {
          add(line, "lockfile-format", `${pkg.key} has ${entry.key} twice`);
          continue;
        }
        pkg.fields.add(entry.key);
        field = entry.key;
        // pnpm writes these as blocks below their key (a snapshot's `optional` as true).
        if (section === "snapshots") {
          if (entry.key === "optional") {
            if (entry.value !== "true")
              add(line, "lockfile-format", `${pkg.key}'s optional must be true`);
          } else if (entry.value !== "") {
            add(line, "lockfile-format", `pnpm writes ${pkg.key}'s ${entry.key} as a block`);
          }
        } else if (PACKAGE_BLOCK_FIELDS.has(entry.key) && entry.value !== "") {
          add(line, "lockfile-format", `pnpm writes ${pkg.key}'s ${entry.key} as a block`);
        }
        if (entry.key === "resolution") {
          pkg.resolutions++;
          if (!REGISTRY_RESOLUTION.test(entry.value)) {
            add(
              line,
              "exotic-resolution",
              `${pkg.key} is not resolved from the registry by integrity`,
            );
          }
        }
        continue;
      }
      if (depth === 6) {
        child = "key" in entry ? entry.key : "";
        const item = "item" in entry ? lockScalar(entry.item) : undefined;
        if (
          section === "snapshots" &&
          (field === "dependencies" || field === "optionalDependencies")
        ) {
          if ("key" in entry && entry.value !== "") snapshotDependency(entry, line, pkg.key);
          else add(line, "lockfile-format", `${pkg.key}'s ${field} lists name: version pairs`);
        } else if (
          (section === "snapshots" && field === "transitivePeerDependencies") ||
          (section === "packages" && field === "bundledDependencies")
        ) {
          if (item === undefined || !plainName.test(item)) {
            add(line, "lockfile-format", `${pkg.key}'s ${field} lists package names`);
          }
        } else if (section === "packages" && field === "peerDependencies") {
          if (!("key" in entry) || entry.value === "") {
            add(line, "lockfile-format", `${pkg.key}'s ${field} lists name: range pairs`);
          }
        } else if (section === "packages" && field === "peerDependenciesMeta") {
          if (!("key" in entry) || entry.value !== "") {
            add(
              line,
              "lockfile-format",
              `${pkg.key}'s ${field} lists names, each with its details below`,
            );
          }
        } else {
          add(
            line,
            "lockfile-format",
            `pnpm writes nothing below ${pkg.key}'s ${field || "field"}`,
          );
        }
        continue;
      }
      // Depth 8: only a peer's `optional` flag, in a package's peerDependenciesMeta.
      if (
        section !== "packages" ||
        field !== "peerDependenciesMeta" ||
        child === "" ||
        !("key" in entry) ||
        entry.key !== "optional" ||
        (entry.value !== "true" && entry.value !== "false")
      ) {
        add(line, "lockfile-format", "a lockfile line this check cannot read (not pnpm's form)");
      }
      continue;
    }

    if (section === "importers") {
      if (depth <= 6) closeDep();
      if (!("key" in entry)) {
        add(line, "lockfile-format", "a lockfile line this check cannot read (not pnpm's form)");
        continue;
      }
      if (depth === 2) {
        field = "";
        importer = entry.key;
        if (entry.value !== "")
          add(line, "lockfile-format", "an importer is a path with its fields below");
      } else if (depth === 4) {
        field = entry.key;
        const inline = field === "publishDirectory" || entry.value === "" || entry.value === "{}";
        if (!IMPORTER_FIELDS.has(field) || !inline) {
          add(line, "lockfile-format", `${field} is not a field pnpm writes on an importer`);
        }
      } else if (depth === 6 && field === "configDependencies") {
        add(
          line,
          "lockfile-format",
          "config dependencies are refused: they run before the policy applies",
        );
      } else if (depth === 6 && field === "dependenciesMeta") {
        child = entry.key;
        if (entry.value !== "") {
          add(
            line,
            "lockfile-format",
            "an importer's dependenciesMeta entry has its details below",
          );
        }
      } else if (depth === 6) {
        // A dependency: its specifier and version follow, one level deeper.
        if (entry.value !== "")
          add(
            line,
            "lockfile-format",
            "an importer's dependency has its specifier and version below",
          );
        else dep = { name: entry.key, line };
      } else if (depth === 8 && field === "dependenciesMeta") {
        if (entry.key !== "injected" || (entry.value !== "true" && entry.value !== "false")) {
          add(
            line,
            "lockfile-format",
            `${entry.key} is not a dependenciesMeta field this check reads`,
          );
        }
      } else if (depth === 8 && dep !== undefined) {
        if (entry.key === "specifier") dep.specifier = entry.value.replace(/^'(.*)'$/, "$1");
        else if (entry.key === "version") {
          dep.version = entry.value;
          dep.versionLine = line;
        } else {
          add(
            line,
            "lockfile-format",
            `${entry.key} is not a field pnpm writes on an importer's dependency`,
          );
        }
      } else {
        add(line, "lockfile-format", "a lockfile line this check cannot read (not pnpm's form)");
      }
      continue;
    }

    if (section === "catalogs") {
      if (depth <= 4) closeCatalogEntry();
      if (!("key" in entry)) {
        add(line, "lockfile-format", "a lockfile line this check cannot read (not pnpm's form)");
      } else if (depth === 2) {
        if (entry.key !== "default" || entry.value !== "") {
          add(line, "lockfile-format", "the lockfile has one default catalog only");
        }
      } else if (depth === 4) {
        if (entry.value === "") catalogEntry = { name: entry.key, line };
        else add(line, "lockfile-format", "a catalog entry has its specifier and version below");
      } else if (depth === 6 && catalogEntry !== undefined) {
        const value = lockScalar(entry.value);
        if (entry.key === "specifier" && value !== undefined) catalogEntry.specifier = value;
        else if (entry.key === "version" && value !== undefined) catalogEntry.version = value;
        else add(line, "lockfile-format", `${entry.key} is not a field of a catalog entry`);
      } else {
        add(line, "lockfile-format", "a lockfile line this check cannot read (not pnpm's form)");
      }
    }
  }
  closeDep();
  closeCatalogEntry();
  closePackage();
  closeDocument();
  return findings;
}

// --- Workflow and action files ----------------------------------------------------------------

const PINNED_USES = /^\s*(?:-\s+)?uses:\s*(['"]?)([^'"\s#]+)\1(?:\s+(#.*))?\s*$/;
// Any other spelling of a `uses` key: quoted, in a flow mapping, with a space before the colon,
// in another case. A line that holds one and is not the pinned form above is refused.
const USES_KEY = /(?:^|[^\w-])["']?uses["']?\s*:/i;
const EXPLICIT_KEY = /(?:^\s*(?:-\s+)*|[{,]\s*)\?(?:\s|$)/;
const ESCAPED_KEY = /"[^"\n]*\\[^"\n]*"\s*:/;
const ALIAS_KEY = /(?:^|[\s[{,?-])\*[^\s[\]{},]+\s*:(?:\s|$)/;

/**
 * Whether a path in a `uses:` is plain: segments of letters, digits, `_`, `-` and `.`, none of
 * them empty or made only of dots, so no segment can lead the path out of what it names (a
 * runner joins it as written, and on Windows reads `\` as a separator too).
 * @param {string} path
 * @returns {boolean}
 */
function plainPath(path) {
  return path.split("/").every((segment) => /^[\w.-]+$/.test(segment) && !/^\.+$/.test(segment));
}

/**
 * Checks `uses:` in a workflow or action file. YAML has many spellings of one key, so any line
 * that names `uses` in a form other than `uses: <owner>/<repo>@<sha> # vX.Y.Z` on its own line is
 * refused, and so are the constructs that can spell a key without its letters (an explicit `?`
 * key, a double-quoted key with an escape, an alias used as a key) and a carriage return without
 * a line feed.
 * @param {string} file
 * @param {string} text
 * @returns {Finding[]}
 */
export function checkUses(file, text) {
  /** @type {Finding[]} */
  const findings = [];
  /**
   * @param {number} line
   * @param {string} message
   */
  const add = (line, message) => findings.push({ file, line, rule: "action-unpinned", message });
  const lines = text.split(/\r\n|\r|\n/);
  let lineNumber = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    lineNumber++;
    if (match[0] === "\r") add(lineNumber, "a carriage return without a line feed");
  }
  for (const [index, line] of lines.entries()) {
    const at = index + 1;
    if (/[\p{Zl}\p{Zp}\u{85}]/u.test(line)) add(at, "a Unicode line separator in a workflow file");
    if (/^\s*#/.test(line)) continue;
    const match = PINNED_USES.exec(line);
    if (!match) {
      if (USES_KEY.test(line)) {
        add(
          at,
          "a uses: this check cannot read; write `uses: <owner>/<repo>@<sha> # vX.Y.Z` on its own line",
        );
      }
      if (EXPLICIT_KEY.test(line)) add(at, "an explicit `?` key is refused in workflow files");
      if (ESCAPED_KEY.test(line))
        add(at, "a double-quoted key with an escape is refused in workflow files");
      if (ALIAS_KEY.test(line)) add(at, "an alias used as a key is refused in workflow files");
      continue;
    }
    const [, , ref = "", comment] = match;
    if (ref.startsWith("./")) {
      // The runner joins the path to the workspace as written, so it is read segment by segment:
      // `./.github/../x` names x, outside the control path.
      const path = ref.slice(2).replace(/\/$/, "");
      if (!path.startsWith(".github/") || !plainPath(path)) {
        add(
          at,
          "a local action lives under .github/ (a control path), named by a plain path with no empty, `.` or `..` segment, so its own uses: are checked",
        );
      }
      continue;
    }
    if (ref.startsWith("docker://")) {
      if (!/@sha256:[0-9a-f]{64}$/.test(ref))
        add(at, "a docker:// action must be pinned by digest");
      continue;
    }
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref)) {
      add(at, "uses: must pin a full 40-character commit SHA");
    } else if (!plainPath(ref.slice(0, ref.lastIndexOf("@")))) {
      add(
        at,
        "uses: names its repository and path plainly, with no empty, `.` or `..` segment, so the pin covers what runs",
      );
    } else if (comment === undefined || !/^#\s*v?\d/.test(comment)) {
      add(at, "a pinned uses: needs its version as a comment (# vX.Y.Z)");
    }
  }
  return findings;
}

// --- The repository ---------------------------------------------------------------------------

/**
 * Runs every supply-chain rule over the repository at `root`.
 * @param {string} root
 * @returns {Finding[]}
 */
export function checkSupplyChain(root) {
  /** @type {Finding[]} */
  const findings = [];
  const entries = trackedEntries(root);
  const files = entries.map(([path]) => path);

  /** @type {Map<string, Item>} */
  let catalog = new Map();
  if (!files.includes(WORKSPACE)) {
    findings.push({
      file: WORKSPACE,
      rule: "policy-missing",
      message: "the workspace policy file is missing",
    });
  } else {
    const result = checkWorkspace(readFileSync(join(root, WORKSPACE), "utf8"));
    findings.push(...result.findings);
    catalog = result.catalog;
  }

  for (const [file, mode] of entries) {
    // pnpm finds these files by name, and a case-insensitive file system (macOS, Windows) gives it
    // a file whose name differs only in case, so every name is compared in lower case.
    const name = file.split("/").pop() ?? "";
    const base = name.toLowerCase();
    if (mode === "120000") {
      findings.push({
        file,
        rule: "symlink",
        message: "a symbolic link can make pnpm read a manifest this check does not; refused",
      });
    } else if (mode === "160000") {
      findings.push({
        file,
        rule: "submodule",
        message: "a submodule brings in files and manifests this check does not read; refused",
      });
    }
    if (/^\.?pnpmfile\.[cm]?[jt]s$/.test(base)) {
      findings.push({
        file,
        rule: "pnpmfile",
        message: "a pnpmfile can rewrite manifests at install time; refused",
      });
    }
    if (SETTINGS_FILES.has(base)) {
      findings.push({
        file,
        rule: "npmrc",
        message: "registry and install settings live only in pnpm-workspace.yaml; refused",
      });
    }
    if (OTHER_MANIFESTS.has(base)) {
      findings.push({
        file,
        rule: "manifest-format",
        message: "pnpm reads this file as a package manifest; manifests are package.json only",
      });
    }
    if (base === "package.json" && name !== "package.json") {
      findings.push({
        file,
        rule: "manifest-format",
        message:
          "a manifest is named package.json in lower case: a case-insensitive file system gives pnpm this file as package.json",
      });
    }
    if (WORKSPACE_FILES.has(base) && file !== WORKSPACE) {
      findings.push({
        file,
        rule: "workspace-file",
        message:
          "pnpm reads a workspace file below the root as another workspace's settings, outside this policy; the root's pnpm-workspace.yaml is the only one",
      });
    }
    if (base === LOCKFILE && file !== LOCKFILE) {
      findings.push({
        file,
        rule: "workspace-file",
        message: "a lockfile other than the root's would install what this check never reads",
      });
    }
  }

  // The root manifest and every workspace package's, in any case (see above).
  const globs = PACKAGE_GLOBS.map((g) => globToRegExp(`${g}/package.json`));
  const manifests = files.filter((f) => {
    const lower = f.toLowerCase();
    return lower === "package.json" || globs.some((g) => g.test(lower));
  });
  if (!files.includes("package.json")) {
    findings.push({
      file: "package.json",
      rule: "manifest-missing",
      message: "the root package.json, which pins pnpm, is missing",
    });
  }
  for (const file of manifests) {
    /** @type {unknown} */
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, file), "utf8"));
    } catch {
      findings.push({ file, rule: "manifest-shape", message: "not valid JSON" });
      continue;
    }
    findings.push(...checkManifest(file, manifest, catalog));
    if (file.toLowerCase() === "package.json") {
      findings.push(...checkPackageManager(file, manifest));
    }
  }

  if (!files.includes(LOCKFILE)) {
    findings.push({
      file: LOCKFILE,
      rule: "lockfile-missing",
      message: "the lockfile must be committed",
    });
  } else {
    findings.push(...checkLockfile(readFileSync(join(root, LOCKFILE), "utf8"), catalog));
  }

  const actionFiles = files.filter(
    (f) =>
      (f.toLowerCase().startsWith(".github/") && /\.ya?ml$/i.test(f)) ||
      /(?:^|\/)action\.ya?ml$/i.test(f),
  );
  for (const file of actionFiles) {
    if (lstatSync(join(root, file)).isSymbolicLink()) continue; // refused above
    findings.push(...checkUses(file, readFileSync(join(root, file), "utf8")));
  }
  return findings;
}

if (import.meta.main) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex > 0 ? (process.argv[rootIndex + 1] ?? ".") : process.cwd();
  if (!existsSync(root)) {
    console.error(`supply-chain:check: no such directory: ${root}`);
    process.exitCode = 2;
  } else {
    process.exitCode = report(checkSupplyChain(root));
  }
}
