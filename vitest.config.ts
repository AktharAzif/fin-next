// The root Vitest configuration (spec 01 §4.7): one project per workspace package whose `test`
// script runs Vitest. Each package also runs its own tests through `turbo run test`; this file lets
// `pnpm exec vitest` run them all at once from the root.
//
// Unit tests are `*.test.ts(x)`. Integration tests are `*.db.test.ts`, run only when
// FIN_TEST_DATABASE_URL names a Postgres 18 database (never PGlite, CI-12). Playwright journeys
// (`e2e/**/*.spec.ts`) never run here.
import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

function runsVitest(dir: string): boolean {
  const manifest = join(root, dir, "package.json");
  if (!existsSync(manifest)) return false;
  const scripts: unknown = JSON.parse(readFileSync(manifest, "utf8")).scripts;
  if (typeof scripts !== "object" || scripts === null) return false;
  const test: unknown = (scripts as Record<string, unknown>).test;
  return typeof test === "string" && /\bvitest\b/.test(test);
}

const withDatabase = (process.env.FIN_TEST_DATABASE_URL ?? "") !== "";
const exclude = ["**/node_modules/**", "**/dist/**", "**/e2e/**"];

const projects: TestProjectInlineConfiguration[] = [];
for (const dir of workspaceGlobs()
  .flatMap((glob) => globSync(glob, { cwd: root }))
  .sort()) {
  if (!runsVitest(dir)) continue;
  projects.push({
    test: {
      name: dir,
      root: join(root, dir),
      include: ["**/*.test.{ts,tsx}"],
      exclude: [...exclude, "**/*.db.test.ts"],
      pool: "threads",
    },
  });
  if (withDatabase) {
    projects.push({
      test: {
        name: `${dir}:db`,
        root: join(root, dir),
        include: ["**/*.db.test.ts"],
        exclude,
        pool: "forks",
      },
    });
  }
}

// Vitest refuses an empty projects list, so until a package has tests the root runs nothing. The
// root never collects files itself: scripts/ uses node:test (`pnpm run test:root`).
export default defineConfig({
  test: projects.length > 0 ? { projects } : { include: [], passWithNoTests: true },
});
