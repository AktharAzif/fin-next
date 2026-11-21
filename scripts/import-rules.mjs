#!/usr/bin/env node
// imports:check (spec 01 §4.6; ARCHITECTURE §3.2; EXECUTION §1.5; spec 06 §11.5). The import rules
// Biome cannot express, and the ones it can, enforced again so a lint override cannot drop them:
//   - no bun:*, Bun.* or drizzle-orm/bun-sql, anywhere;
//   - node:http, node:https, node:net, node:dns, node:cluster and node:worker_threads only in
//     packages/server and apps/connector;
//   - no node:* import and no server package in any src/client/**, packages/ui, packages/tokens,
//     packages/frame or packages/app-contracts (FW-C12);
//   - only node:* and relative imports in ops/fin/src, tools/fin-review/src,
//     packages/web-host/src/static and tools/static-deploy/src, and only relative imports in
//     ops/watcher/src (Web APIs only); their test files may also import vitest;
//   - no @tanstack/react-start*, @tanstack/start-*, @remix-run/*, react-router-dom, Radix,
//     Phosphor, clsx, tailwind-merge or @fontsource*, anywhere (FW-C01, FW-C18, OD-5);
//   - @ui-sdk/* only inside packages/ui, so screens take their controls from @fin/ui; the refused
//     SDK entries and core's experimental helpers nowhere; @ui-sdk/core/testing in tests only;
//   - no console.error(error): errors go through reportError with safeError;
//   - Node built-ins by their node: name; relative imports with their file extension, .ts or
//     .tsx where the source is TypeScript.
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import { globToRegExp, listFiles, report } from "./lib/repo.mjs";

/** @typedef {import("./lib/repo.mjs").Finding} Finding */
/** @typedef {{ specifier: string, line: number, names: string[], dynamic: boolean }} ImportRef */

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
 * Finds the import specifiers in a source file, with their line numbers. Static imports and
 * re-exports are read at the start of a line (as the formatter writes them); dynamic import() and
 * require() anywhere outside a comment line.
 * @param {string} text
 * @returns {{ imports: ImportRef[], dynamicExpressions: number[] }}
 */
export function findImports(text) {
  /** @type {ImportRef[]} */
  const imports = [];
  /** @type {number[]} */
  const dynamicExpressions = [];
  const lineAt = (/** @type {number} */ index) => text.slice(0, index).split("\n").length;
  const staticImport =
    /^[ \t]*(?:import|export)\b(?:\s*(['"])([^'"\n]+)\1|([^'"`;]*?)\bfrom\s*(['"])([^'"\n]+)\4)/gm;
  for (const match of text.matchAll(staticImport)) {
    const specifier = match[2] ?? match[5] ?? "";
    const clause = match[3] ?? "";
    const names = [...clause.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
    imports.push({ specifier, line: lineAt(match.index), names, dynamic: false });
  }
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    for (const match of line.matchAll(/\b(?:import|require)\s*\(\s*(?:(['"`])([^'"`\n]+)\1)?/g)) {
      if (/^\s*import\b/.test(line) && !line.includes("import(")) continue;
      if (match[2] === undefined) {
        if (!/^\s*\)/.test(line.slice((match.index ?? 0) + match[0].length)))
          dynamicExpressions.push(index + 1);
        continue;
      }
      if (match[1] === "`" && match[2].includes("${")) {
        dynamicExpressions.push(index + 1);
        continue;
      }
      imports.push({ specifier: match[2], line: index + 1, names: [], dynamic: true });
    }
  }
  return { imports, dynamicExpressions };
}

/**
 * Checks one source file.
 * @param {string} file the repository path
 * @param {string} text the file's content
 * @param {(path: string) => boolean} [fileExists] for the .js-to-.ts check
 * @returns {Finding[]}
 */
export function checkSource(file, text, fileExists = () => false) {
  /** @type {Finding[]} */
  const findings = [];
  /**
   * @param {number} line
   * @param {string} rule
   * @param {string} message
   */
  const add = (line, rule, message) => findings.push({ file, line, rule, message });
  const isTest = TEST_FILE.test(file);
  const isClient =
    /(^|\/)src\/client\//.test(file) || CLIENT_PACKAGES.some((p) => file.startsWith(p));
  const builtinsOnly = BUILTINS_ONLY.some((p) => file.startsWith(p));
  const relativeOnly = RELATIVE_ONLY.some((p) => file.startsWith(p));
  const { imports, dynamicExpressions } = findImports(text);

  for (const line of dynamicExpressions) {
    if (builtinsOnly || relativeOnly || isClient) {
      add(
        line,
        "dynamic-import",
        "import() and require() take a string literal here, so the rules can read them",
      );
    }
  }

  for (const { specifier, line, names } of imports) {
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
    if (specifier.startsWith("/")) {
      add(
        line,
        "absolute-import",
        "imports are relative or by package name, never an absolute path",
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
    if (relativeOnly && !relative) {
      add(line, "relative-only", "the watcher uses Web APIs and relative imports only");
    } else if (
      builtinsOnly &&
      !relative &&
      builtin === undefined &&
      !(isTest && name === "vitest")
    ) {
      add(
        line,
        "builtins-only",
        "this code runs with no install: node:* and relative imports only",
      );
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
 * Runs the import rules over every source file in the repository at `root`.
 * @param {string} root
 * @returns {Finding[]}
 */
export function checkImports(root) {
  const files = listFiles(root, { untracked: true }).filter((f) => SOURCE.test(f));
  const known = new Set(files);
  const exists = (/** @type {string} */ path) => known.has(path) || existsSync(join(root, path));
  return files.flatMap((file) => checkSource(file, readFileSync(join(root, file), "utf8"), exists));
}

if (import.meta.main) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex > 0 ? (process.argv[rootIndex + 1] ?? ".") : process.cwd();
  process.exitCode = report("imports:check", checkImports(root));
}
