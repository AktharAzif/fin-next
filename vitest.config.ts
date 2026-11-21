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

/** The `packages:` globs of pnpm-workspace.yaml, read so the two lists cannot drift apart. */
function workspaceGlobs(): string[] {
  const lines = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split("\n");
  const start = lines.indexOf("packages:");
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^ {2}- (\S+)$/.exec(line);
    if (item?.[1] === undefined) break;
    globs.push(item[1]);
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

export default defineConfig(({ mode }) => {
  const db = mode === "db";
  if (db && (process.env.FIN_TEST_DATABASE_URL ?? "") === "") {
    throw new Error(
      "vitest --mode db runs the integration tests: set FIN_TEST_DATABASE_URL to a Postgres 18 database",
    );
  }
  const packages = workspaceGlobs()
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
    },
  }));

  // Vitest refuses an empty projects list, so until a package has tests the root runs nothing.
  // The root never collects files itself: scripts/ uses node:test (`pnpm run test:root`).
  return {
    test: projects.length > 0 ? { projects } : { include: [], passWithNoTests: true },
  };
});
