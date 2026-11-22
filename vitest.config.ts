// The root Vitest configuration (spec 01 §4.7): one project per workspace package whose test
// scripts run Vitest. It is the only Vitest configuration: each package runs its tests through it,
// with the scripts layout:check requires,
//   "test":    "vitest run --config ../../vitest.config.ts"
//   "test:db": "vitest run --config ../../vitest.config.ts --mode db"
// so `turbo run test` (which runs each package's script in the package's directory) applies the
// same rules as `pnpm exec vitest run` at the root. Run from a package's directory it selects that
// package alone; run from the root, every package.
//
// Unit tests are `*.test.ts(x)` and never include `*.db.test.ts`. Integration tests are
// `*.db.test.ts`, run only in `--mode db`, which refuses to start unless FIN_TEST_DATABASE_URL
// names a Postgres 18 database (never PGlite, CI-12). Playwright journeys (`e2e/**`) never run
// under Vitest. A package has no Vitest configuration of its own (layout:check refuses one, since
// this file's --config would silently pass it by); a setting a package needs is added here, for
// every package: stylesheets imported with `?raw` are read as text, so tests can check them.
import { existsSync, globSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

const root = import.meta.dirname;

function fail(message: string): never {
  throw new Error(message);
}

/**
 * `line` without its trailing comment (a `#` at its start or after a space or a tab, outside
 * quotes) and its trailing white space. White space is YAML's, a space or a tab alone: a no-break
 * space or another character JavaScript reads as white space is part of a scalar to YAML, so it
 * is kept, and the item holding it refused (see globOf).
 */
function uncommented(line: string): string {
  let quote: string | undefined;
  for (let at = 0; at < line.length; at++) {
    const char = line.charAt(at);
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "#" && (at === 0 || /[ \t]/.test(line.charAt(at - 1)))) {
      return line.slice(0, at).replace(/[ \t]+$/, "");
    }
  }
  return line.replace(/[ \t]+$/, "");
}

/**
 * The glob a list item's scalar `text` holds: single-quoted, double-quoted with no escape, or plain
 * (starting with a letter, and not a word YAML reads as a boolean or null); and in every form only
 * letters, digits, `_`, `.`, `-`, `/` and `*`, so no negation, class, brace or extglob that pnpm's
 * matcher could read otherwise. Undefined for anything else.
 */
function globOf(text: string): string | undefined {
  const glob = /^'(?:[^']|'')*'$/.test(text)
    ? text.slice(1, -1).replaceAll("''", "'")
    : /^"[^"\\]*"$/.test(text)
      ? text.slice(1, -1)
      : /^[A-Za-z]/.test(text) && !/^(?:true|false|null)$/i.test(text)
        ? text
        : undefined;
  return glob !== undefined && /^[\w.*/-]+$/.test(glob) ? glob : undefined;
}

// A top-level key of pnpm-workspace.yaml as the reader reads one: a plain name, or a quoted one
// with no escape, then any spaces, the colon and the value on its line, if any.
const TOP_LEVEL_KEY = /^(?:([A-Za-z_][\w.-]*)|'([^']*)'|"([^"\\]*)") *:(?: +(.*))?$/;

/**
 * The globs of pnpm-workspace.yaml's `packages:` list in the file's text `text`, read so the two
 * lists cannot drift apart, as YAML, and so pnpm, reads them in the subset
 * scripts/check-supply-chain.mjs accepts: the lines are split where YAML splits them (LF, CR or
 * CRLF), a blank or comment-only line anywhere is skipped, a trailing `# comment` is dropped (blank
 * and white space being YAML's, spaces and tabs alone, see uncommented), and the list runs from
 * the `packages:` key to the next top-level key, each item `- <glob>` at the first item's
 * indentation (see globOf). Any other line in the list, a value on the key's own line, a second
 * `packages:`, an indented line before the first top-level key and a top-level line that is not a
 * key the reader reads (any of which YAML could read as the list or its key) is refused, never
 * skipped, so no package pnpm installs is left out. This is a copy of
 * packages/server/test/image-build.ts's workspaceGlobs, which the release image's tests
 * (packages/server/src/build/release-image.test.ts) hold to the same globs and refusals.
 */
export function workspaceGlobs(text: string): string[] {
  const globs: string[] = [];
  let key: string | undefined;
  let seen = false;
  let indent: string | undefined;
  for (const [index, line] of text.split(/\r\n|\r|\n/).entries()) {
    const content = uncommented(line);
    if (content === "") continue;
    const at = `pnpm-workspace.yaml: line ${index + 1}`;
    if (!line.startsWith(" ")) {
      const top = TOP_LEVEL_KEY.exec(content);
      key = top?.[1] ?? top?.[2] ?? top?.[3];
      if (top === null || key === undefined) fail(`${at} is not a top-level key the reader reads`);
      if (key !== "packages") continue;
      if (seen) fail(`${at} holds the packages key a second time`);
      seen = true;
      if (top[4] !== undefined) fail(`${at} gives packages a value on its line, not a block list`);
      continue;
    }
    if (key === undefined) fail(`${at} is indented under no top-level key`);
    if (key !== "packages") continue;
    const item = /^( +)- +(.*)$/.exec(content);
    const glob = item?.[2] === undefined ? undefined : globOf(item[2]);
    indent ??= item?.[1];
    if (item?.[1] !== indent || glob === undefined) {
      fail(`${at}, in the packages list, is not an item \`- <glob>\` the reader reads`);
    }
    globs.push(glob);
  }
  return globs;
}

/** Whether the package in `dir` runs Vitest from the named script. */
function runsVitest(dir: string, script: string): boolean {
  const scripts: unknown = JSON.parse(
    readFileSync(join(root, dir, "package.json"), "utf8"),
  ).scripts;
  if (typeof scripts !== "object" || scripts === null) return false;
  const command: unknown = (scripts as Record<string, unknown>)[script];
  return typeof command === "string" && /\bvitest\b/.test(command);
}

const exclude = ["**/node_modules/**", "**/dist/**", "**/e2e/**"];

// Under the Bun canary (DECISIONS CI-10), and only there, every file loads the canary's setup,
// which skips by exact name the tests in its one list of exclusions, each with its reason
// (packages/testing/src/bun-canary/exclusions.ts). On Node nothing is added.
const BUN_CANARY_SETUP =
  typeof process.versions.bun === "string"
    ? [join(root, "packages/testing/src/bun-canary/setup.ts")]
    : [];

export default defineConfig(({ mode }) => {
  const db = mode === "db";
  if (db && (process.env.FIN_TEST_DATABASE_URL ?? "") === "") {
    throw new Error(
      "vitest --mode db runs the integration tests: set FIN_TEST_DATABASE_URL to a Postgres 18 database",
    );
  }
  const packages = workspaceGlobs(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"))
    .flatMap((glob) => globSync(glob, { cwd: root }))
    .filter((dir) => existsSync(join(root, dir, "package.json")))
    .map((dir) => dir.split(sep).join("/"))
    .sort();
  // From a package's directory (as turbo runs a package's script), that package alone.
  const here = relative(root, process.cwd()).split(sep).join("/");
  const own = packages.find((dir) => here === dir || here.startsWith(`${dir}/`));
  const selected =
    own !== undefined ? [own] : packages.filter((dir) => runsVitest(dir, db ? "test:db" : "test"));

  const projects: TestProjectInlineConfiguration[] = selected.map((dir) => ({
    test: {
      name: db ? `${dir}:db` : dir,
      root: join(root, dir),
      include: db ? ["**/*.db.test.ts"] : ["**/*.test.{ts,tsx}"],
      exclude: db ? exclude : [...exclude, "**/*.db.test.ts"],
      pool: db ? "forks" : "threads",
      css: { include: [/\.css\?raw$/] },
      ...(BUN_CANARY_SETUP.length > 0 ? { setupFiles: BUN_CANARY_SETUP } : {}),
    },
  }));

  // Vitest refuses an empty projects list, so until a package has tests the root runs nothing.
  // The root never collects files itself: scripts/ uses node:test (`pnpm run test:root`).
  return {
    test: projects.length > 0 ? { projects, ...(db ? { reporters: ["verbose"], slowTestThreshold: 0 } : {}) } : { include: [], passWithNoTests: true },
  };
});
