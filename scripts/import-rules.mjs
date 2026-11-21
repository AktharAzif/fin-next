#!/usr/bin/env node
// imports:check (spec 01 §4.6; ARCHITECTURE §3.2; EXECUTION §1.5; spec 06 §11.5). The import rules
// Biome cannot express, and the ones it can, enforced again so a lint override cannot drop them:
//   - no bun:*, Bun.* or drizzle-orm/bun-sql, anywhere;
//   - node:http, node:https, node:net, node:dns, node:cluster and node:worker_threads only in
//     packages/server and apps/connector;
//   - no node:* import and no server package in any src/client/**, packages/ui, packages/tokens,
//     packages/frame or packages/app-contracts (FW-C12);
//   - only node:* and relative imports in ops/fin/src, tools/fin-review/src,
//     packages/web-host/src/static, tools/static-deploy/src and scripts/, and only relative
//     imports in ops/watcher/src (Web APIs only); their test files may also import vitest;
//   - a file under a control path (tools/layout.json's controlPaths) imports only node:* and
//     files under the control paths (type-only imports aside; a test may also import vitest and
//     any file of the repository, since a test does not change what the code does when it runs),
//     so no file outside them can change what an owner-approved file does (CI-14);
//   - no @tanstack/react-start*, @tanstack/start-*, @remix-run/*, react-router-dom, Radix,
//     Phosphor, clsx, tailwind-merge or @fontsource*, anywhere (FW-C01, FW-C18, OD-5);
//   - @ui-sdk/* only inside packages/ui, so screens take their controls from @fin/ui; the refused
//     SDK entries and core's experimental helpers nowhere; @ui-sdk/core/testing in tests only;
//   - no console.error(error): errors go through reportError with safeError;
//   - Node built-ins by their node: name; relative imports with their file extension, .ts or
//     .tsx where the source is TypeScript.
// Imports are read wherever they stand: a static import or re-export anywhere in a line or across
// lines (string names and comments in its clause included), import() and require() calls, and
// getBuiltinModule() calls, which load a module like an import. An import(), require() or
// getBuiltinModule() whose argument is not a single string literal is refused where the rules
// must read every import, getBuiltinModule's everywhere, and so are the other ways to load code
// unseen there (outside tests): createRequire, the process binding, eval and the Function
// constructor. In code that runs, text in comments and strings is read too, so the check fails
// closed: an import-shaped string that breaks a rule is reported. In a test file, whose fixtures
// often hold import-shaped text, comments, strings and template text are skipped.
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import { coveredBy, globToRegExp, isRecord, listFiles, readJson, report } from "./lib/repo.mjs";

/** @typedef {import("./lib/repo.mjs").Finding} Finding */
/** @typedef {{ specifier: string, line: number, names: string[], dynamic: boolean, typeOnly: boolean }} ImportRef */
/** @typedef {{ line: number, loader: string }} DynamicExpression */

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TS_SOURCE = /\.(?:[cm]?ts|tsx)$/;
const TEST_FILE = /\.(?:db\.)?test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/;
const BUILTINS = new Set(
  builtinModules.filter((m) => !m.startsWith("_")).map((m) => m.replace(/^node:/, "")),
);
const NETWORK = new Set(["http", "https", "net", "dns", "cluster", "worker_threads"]);
const NETWORK_ALLOWED = ["packages/server/", "apps/connector/"];
const CLIENT_PACKAGES = [
  "packages/ui/",
  "packages/tokens/",
  "packages/frame/",
  "packages/app-contracts/",
];
const BUILTINS_ONLY = [
  "ops/fin/src/",
  "tools/fin-review/src/",
  "packages/web-host/src/static/",
  "tools/static-deploy/src/",
  "scripts/",
];
const RELATIVE_ONLY = ["ops/watcher/src/"];
const SERVER_PACKAGES = [
  "@fin/server",
  "@fin/web-host",
  "@fin/db",
  "@fin/crypto",
  "@fin/audit",
  "@fin/email",
  "@fin/testing",
  "@fin/identity",
  "@fin/orgs",
  "@fin/staff",
  "@fin/keys",
  "@fin/kyc",
  "@fin/money",
  "@fin/events",
  "hono",
  "@hono/*",
  "pg",
  "drizzle-orm",
  "@sentry/node",
  "wrangler",
];
const REFUSED = [
  "@tanstack/react-start",
  "@tanstack/react-start-*",
  "@tanstack/start-*",
  "@remix-run/*",
  "react-router-dom",
  "react-server-dom-*",
  "@vitejs/plugin-rsc",
  "@rsbuild/core",
  "@radix-ui/*",
  "radix-ui",
  "@phosphor-icons/*",
  "clsx",
  "tailwind-merge",
  "@fontsource*",
  "@fontsource*/*",
];
const SDK_REFUSED = [
  /^@ui-sdk\/[^/]+\/agent(?:\/|$)/,
  /^@ui-sdk\/react\/(?:preferences|token-input|label|timeline|segmented-control|rating|color-picker|image-cropper|waterfall)(?:\/|$)/,
  /^@ui-sdk\/core\/web\.css$/,
];
const SDK_CORE_REFUSED_NAMES = [
  "createGridFocus",
  "createVirtualizer",
  "createCellRange",
  "createLasso",
];

// One part of an import or export clause: any character but a quote, a backtick, a semicolon, a
// parenthesis or a slash; or a whole string (a string name); or a comment. A clause never holds a
// parenthesis or a semicolon, so a match cannot run past its statement.
const CLAUSE_PART = String.raw`(?:[^'"\x60;()/]|\/(?![/*])|\/\/[^\n]*|\/\*[\s\S]*?\*\/|'[^'\n]*'|"[^"\n]*")`;
// The forms a module specifier takes: a relative or absolute path, a URL with a scheme (node:,
// data:, file:, ...), or a bare package name (no space, comma, colon, quote or bracket). Any text
// that Node could load fits one of them; ordinary code such as `["import", "default"]` or
// `case "import": return "x"` does not.
const SPECIFIER = String.raw`(?:\.{0,2}\/[^'"\n]*|[A-Za-z][A-Za-z0-9+.-]*:[^'"\n]*|[^'"\s,;:(){}[\]<>\x60./][^'"\s,;:(){}[\]<>\x60]*)`;
const STATIC_IMPORT = new RegExp(
  String.raw`(?<![\w$.])(?:import|export)(?![\w$])(?:\s*(['"])(${SPECIFIER})\1|(${CLAUSE_PART}*?)(?<![\w$])from\s*(['"])(${SPECIFIER})\4)`,
  "g",
);
// A call that loads a module: its argument is read when it is one string literal and nothing else.
const LOADING_CALL =
  /\b(import|require|getBuiltinModule)\s*\(\s*(?:(['"`])([^'"`\n]*)\2\s*(?=[,)]))?/g;
// Other ways to load code that the rules cannot read, refused where every import must be read:
// the calls themselves, and the same names reached as a computed member with a string key.
const UNREAD_LOADERS =
  /\b(?:createRequire|_linkedBinding|dlopen|_load|eval)\s*\(|\bprocess\s*\??\.\s*binding\b|\bnew\s+Function\b|\[\s*(['"`])(?:getBuiltinModule|createRequire|binding|_linkedBinding|dlopen|_load|require)\1\s*\]/g;

/**
 * The package name of a bare specifier (`@scope/name` or `name`).
 * @param {string} specifier
 * @returns {string}
 */
export function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
}

/**
 * @param {string} name
 * @param {string[]} patterns exact names or globs
 * @returns {boolean}
 */
function matchesAny(name, patterns) {
  return patterns.some((p) => (p.includes("*") ? globToRegExp(p).test(name) : name === p));
}

/**
 * A function from a character offset to its 1-based line number.
 * @param {string} text
 * @returns {(index: number) => number}
 */
function lineFinder(text) {
  /** @type {number[]} */
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/**
 * Which characters of a JavaScript or TypeScript source are code rather than the inside of a
 * comment, a string or a template literal's text (a template's `${...}` is code again). A string
 * ends at its quote or at the end of its line; a regular expression literal is read as code. It
 * is used for test files only, to skip the import-shaped text their fixtures hold: in code that
 * runs, everything is read.
 * @param {string} text
 * @returns {Uint8Array} 1 for code, 0 otherwise, per character
 */
export function codeMask(text) {
  const mask = new Uint8Array(text.length).fill(1);
  /**
   * @param {number} from
   * @param {number} to
   */
  const clear = (from, to) => mask.fill(0, from, Math.min(to, text.length));
  /** @type {number[]} */
  const templates = []; // for each open `${`, the brace depth its `}` returns to
  let depth = 0;
  /**
   * Reads template text from `start` to its closing backtick or its next `${`.
   * @param {number} start
   * @returns {number} where code resumes
   */
  const templateText = (start) => {
    for (let j = start; j < text.length; j++) {
      const ch = text.charAt(j);
      if (ch === "\\") j++;
      else if (ch === "`") {
        clear(start, j);
        return j + 1;
      } else if (ch === "$" && text.charAt(j + 1) === "{") {
        clear(start, j);
        templates.push(depth++);
        return j + 2;
      }
    }
    clear(start, text.length);
    return text.length;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      clear(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      clear(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== ch && text.charAt(j) !== "\n") {
        j += text.charAt(j) === "\\" ? 2 : 1;
      }
      clear(i + 1, j);
      i = j + 1;
    } else if (ch === "`") {
      i = templateText(i + 1);
    } else if (ch === "{") {
      depth++;
      i++;
    } else if (ch === "}") {
      depth--;
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        i = templateText(i + 1);
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return mask;
}

/**
 * Finds the import specifiers in a source file, with their line numbers: static imports and
 * re-exports wherever they stand, and import(), require() and getBuiltinModule() calls.
 * @param {string} text
 * @param {Uint8Array} [mask] when given, only matches whose keyword is code (see codeMask)
 * @returns {{ imports: ImportRef[], dynamicExpressions: DynamicExpression[] }}
 */
export function findImports(text, mask) {
  /** @type {ImportRef[]} */
  const imports = [];
  /** @type {DynamicExpression[]} */
  const dynamicExpressions = [];
  const lineAt = lineFinder(text);
  const isCode = (/** @type {number} */ index) => mask === undefined || mask[index] === 1;
  for (const match of text.matchAll(STATIC_IMPORT)) {
    if (!isCode(match.index)) continue;
    const specifier = match[2] ?? match[5] ?? "";
    const clause = (match[3] ?? "").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, " ");
    const names = [
      ...[...clause.replace(/'[^'\n]*'|"[^"\n]*"/g, " ").matchAll(/[A-Za-z_$][\w$]*/g)].map(
        (m) => m[0],
      ),
      ...[...clause.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((m) => m[1] ?? m[2] ?? ""),
    ];
    const typeOnly = /^\s*type\s+(?:[{*]|[A-Za-z_$][\w$]*\s*(?:,|$))/.test(clause);
    imports.push({ specifier, line: lineAt(match.index), names, dynamic: false, typeOnly });
  }
  for (const match of text.matchAll(LOADING_CALL)) {
    if (!isCode(match.index)) continue;
    const loader = match[1] ?? "";
    const literal = match[3];
    const line = lineAt(match.index);
    if (literal === undefined) {
      // `import()` with nothing inside is prose, not code: the call would not parse.
      if (!/^\s*\)/.test(text.slice(match.index + match[0].length))) {
        dynamicExpressions.push({ line, loader });
      }
      continue;
    }
    if (match[2] === "`" && literal.includes("${")) {
      dynamicExpressions.push({ line, loader });
      continue;
    }
    imports.push({ specifier: literal, line, names: [], dynamic: true, typeOnly: false });
  }
  return { imports, dynamicExpressions };
}

/**
 * Checks one source file.
 * @param {string} file the repository path
 * @param {string} text the file's content
 * @param {(path: string) => boolean} [fileExists] for the .js-to-.ts check
 * @param {{ controlPaths?: string[] }} [options] the control paths of tools/layout.json
 * @returns {Finding[]}
 */
export function checkSource(file, text, fileExists = () => false, options = {}) {
  /** @type {Finding[]} */
  const findings = [];
  /**
   * @param {number} line
   * @param {string} rule
   * @param {string} message
   */
  const add = (line, rule, message) => findings.push({ file, line, rule, message });
  const controlPaths = options.controlPaths ?? [];
  const isControlled = (/** @type {string} */ path) =>
    controlPaths.some((cp) => coveredBy(path, cp));
  const isTest = TEST_FILE.test(file);
  const isClient =
    /(^|\/)src\/client\//.test(file) || CLIENT_PACKAGES.some((p) => file.startsWith(p));
  const builtinsOnly = BUILTINS_ONLY.some((p) => file.startsWith(p));
  const relativeOnly = RELATIVE_ONLY.some((p) => file.startsWith(p));
  const controlled = isControlled(file);
  const mustReadAll = builtinsOnly || relativeOnly || isClient || controlled;
  const { imports, dynamicExpressions } = findImports(text, isTest ? codeMask(text) : undefined);

  for (const { line, loader } of dynamicExpressions) {
    if (mustReadAll || loader === "getBuiltinModule") {
      add(
        line,
        "dynamic-import",
        `${loader}() takes one string literal here, so the rules can read what it loads`,
      );
    }
  }
  if (mustReadAll && !isTest) {
    const lineAt = lineFinder(text);
    for (const match of text.matchAll(UNREAD_LOADERS)) {
      add(
        lineAt(match.index),
        "dynamic-import",
        "code here loads modules only by import, so the rules can read every one (no createRequire, process binding, eval or Function constructor)",
      );
    }
  }

  for (const { specifier, line, names, typeOnly } of imports) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    const bare =
      !relative &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("node:") &&
      !specifier.startsWith("bun:");
    const builtin = specifier.startsWith("node:")
      ? (specifier.slice(5).split("/")[0] ?? "")
      : bare && BUILTINS.has(specifier.split("/")[0] ?? "")
        ? (specifier.split("/")[0] ?? "")
        : undefined;
    const name = bare && builtin === undefined ? packageName(specifier) : specifier;

    if (
      specifier === "bun" ||
      specifier.startsWith("bun:") ||
      specifier === "drizzle-orm/bun-sql"
    ) {
      add(line, "no-bun", "Node is the only runtime (ARCHITECTURE §3.2)");
      continue;
    }
    if (specifier.startsWith("/") || /^(?:file|data|https?|blob):/i.test(specifier)) {
      add(
        line,
        "absolute-import",
        "imports are relative or by package name, never an absolute path or a URL (file:, data:, http:), whose own imports the rules could not read",
      );
      continue;
    }
    if (builtin !== undefined && !specifier.startsWith("node:")) {
      add(line, "node-prefix", `use node:${specifier}, so the built-in rules can see it`);
    }
    if (
      builtin !== undefined &&
      NETWORK.has(builtin) &&
      !NETWORK_ALLOWED.some((p) => file.startsWith(p))
    ) {
      add(
        line,
        "node-network",
        `node:${builtin} is allowed only in packages/server and apps/connector`,
      );
    }
    if (builtin !== undefined && isClient) {
      add(line, "client-node", "client code imports no node:* module (FW-C12)");
    }
    if (bare && builtin === undefined) {
      if (matchesAny(name, REFUSED))
        add(line, "refused-package", `${name} is refused (FW-C01, FW-C18, OD-5)`);
      if (isClient && matchesAny(name, SERVER_PACKAGES)) {
        add(
          line,
          "client-server-package",
          `client code depends on no server package (FW-C12): ${name}`,
        );
      }
      if (name.startsWith("@ui-sdk/")) {
        if (!file.startsWith("packages/ui/")) {
          add(
            line,
            "ui-sdk-outside-ui",
            "only packages/ui imports the UI SDK; screens import controls from @fin/ui",
          );
        }
        if (SDK_REFUSED.some((r) => r.test(specifier))) {
          add(
            line,
            "ui-sdk-refused-entry",
            "this UI SDK entry is refused everywhere (EX-30, spec 06 §11.5)",
          );
        }
        if (specifier === "@ui-sdk/core/testing" && !isTest) {
          add(line, "ui-sdk-testing", "@ui-sdk/core/testing is allowed in test files only");
        }
        if (name === "@ui-sdk/core" && names.some((n) => SDK_CORE_REFUSED_NAMES.includes(n))) {
          add(
            line,
            "ui-sdk-refused-entry",
            "core's experimental helpers are refused (EX-30, spec 06 §11.5)",
          );
        }
      }
    }
    const testRunner = isTest && name === "vitest";
    if (relativeOnly && !relative) {
      add(line, "relative-only", "the watcher uses Web APIs and relative imports only");
    } else if (builtinsOnly && !relative && builtin === undefined && !testRunner) {
      add(
        line,
        "builtins-only",
        "this code runs with no install: node:* and relative imports only",
      );
    } else if (controlled && bare && builtin === undefined && !testRunner && !typeOnly) {
      add(
        line,
        "control-path-import",
        "a control-path file imports Node built-ins and control-path files only (CI-14)",
      );
    }
    if (controlled && relative && !typeOnly && !isTest) {
      const target = posix.normalize(
        posix.join(posix.dirname(file), specifier.replace(/[?#].*$/, "")),
      );
      if (target.startsWith("../") || !isControlled(target)) {
        add(
          line,
          "control-path-import",
          "a control-path file imports only files under the control paths, so a file outside them cannot change what it does (CI-14)",
        );
      }
    }
    if (relative) {
      const last = specifier.split("/").pop() ?? "";
      const clean = last.replace(/[?#].*$/, "");
      if (!/\.[A-Za-z0-9]+$/.test(clean)) {
        add(
          line,
          "relative-extension",
          "a relative import names its file with the extension (.ts or .tsx)",
        );
      } else if (TS_SOURCE.test(file) && /\.(?:m?js|jsx)$/.test(clean)) {
        const target = posix.join(posix.dirname(file), specifier.replace(/[?#].*$/, ""));
        const ts = target.replace(/\.(m?)js$/, ".$1ts").replace(/\.jsx$/, ".tsx");
        if (fileExists(ts))
          add(
            line,
            "relative-extension",
            "import the .ts source by its .ts name (rewriteRelativeImportExtensions)",
          );
      }
    }
  }

  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (/(?<![\w$.])Bun\.[A-Za-z]/.test(line))
      add(index + 1, "no-bun", "Node is the only runtime: no Bun.* (ARCHITECTURE §3.2)");
    if (/\bconsole\.error\(\s*(?:error|err|e)\s*[,)]/.test(line)) {
      add(
        index + 1,
        "console-error",
        "errors go through reportError with safeError, never straight to the console",
      );
    }
  }
  return findings;
}

/**
 * The control paths tools/layout.json lists (none when it is missing or malformed; layout:check
 * reports that).
 * @param {string} root
 * @returns {string[]}
 */
function readControlPaths(root) {
  try {
    const layout = readJson(join(root, "tools/layout.json"));
    if (!isRecord(layout) || !Array.isArray(layout.controlPaths)) return [];
    return layout.controlPaths.filter((p) => typeof p === "string" && p !== "");
  } catch {
    return [];
  }
}

/**
 * Runs the import rules over every source file in the repository at `root`.
 * @param {string} root
 * @returns {Finding[]}
 */
export function checkImports(root) {
  const files = listFiles(root, { untracked: true }).filter((f) => SOURCE.test(f));
  const known = new Set(files);
  const exists = (/** @type {string} */ path) => known.has(path) || existsSync(join(root, path));
  const controlPaths = readControlPaths(root);
  return files.flatMap((file) =>
    checkSource(file, readFileSync(join(root, file), "utf8"), exists, { controlPaths }),
  );
}

if (import.meta.main) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex > 0 ? (process.argv[rootIndex + 1] ?? ".") : process.cwd();
  process.exitCode = report("imports:check", checkImports(root));
}
