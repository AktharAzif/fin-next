// No test task uses Turborepo's cache (the steward's ruling of 22 Nov). Tests that read files outside
// their own package (another package's sources, the Dockerfile, a generated registry) kept passing
// from the cache after a change they should have seen, and widening one task's inputs at a time
// never caught up. So CI and the merge gate run every test for real, and build, lint and typecheck
// keep their cache.
//
// Two traps decide how this pins it. A '<package>#<task>' entry in the root turbo.json replaces the
// bare task's definition instead of inheriting from it: beside "test": { "cache": false }, an entry
// "@fin/identity#test": { "inputs": [...] } still replays identity's test from the cache. A package's
// own turbo.json does inherit from the root, but can set "cache": true again. So every entry for a
// test task, in the root and in each package configuration, carries "cache": false itself, and
// Turborepo's own dry run must resolve every test task uncached.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { after, describe, test } from "node:test";
import { addFiles, cleanUp, makeRepo, REPO_ROOT } from "./helpers.mjs";

after(cleanUp);

const TURBO = join(REPO_ROOT, "node_modules", ".bin", "turbo");

// The one task besides the tests whose caching was off before the ruling; it stays as it was, in the
// root configuration only.
const CACHE_OFF = new Set(["//#lint:root"]);

// Where a package configuration can sit, besides every workspace pattern pnpm-workspace.yaml lists.
const PACKAGE_DIRS = ["apps/*", "packages/*", "ops/*", "tools/*"];

/**
 * A test task: `test` and every task whose name starts with it (`test:db`, `test:root`), and any
 * e2e or journey task.
 * @param {string} task
 * @returns {boolean}
 */
function isTestTask(task) {
  return /^(?:test|e2e|journey)/.test(task);
}

/**
 * The task a turbo.json key names: the part after the first '#' ('@fin/server#test',
 * '//#test:root'), or the whole key when it has none.
 * @param {string} key
 * @returns {string}
 */
function taskOf(key) {
  const at = key.indexOf("#");
  return at === -1 ? key : key.slice(at + 1);
}

/**
 * The package patterns pnpm-workspace.yaml lists under `packages:`.
 * @param {string} dir
 * @returns {string[]}
 */
function workspacePatterns(dir) {
  const file = join(dir, "pnpm-workspace.yaml");
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.indexOf("packages:");
  if (start === -1) return [];
  /** @type {string[]} */
  const patterns = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s+["']?([^"'\s#]+)["']?\s*(?:#.*)?$/.exec(line);
    if (item === null) break;
    if (item[1] !== undefined && !item[1].startsWith("!")) patterns.push(item[1]);
  }
  return patterns;
}

/**
 * Every Turborepo configuration under `dir`, `.json` or `.jsonc`: the root's, then each package's.
 * @param {string} dir
 * @returns {string[]} paths relative to `dir`, with forward slashes
 */
function configPaths(dir) {
  const names = ["turbo.json", "turbo.jsonc"];
  /** @type {Set<string>} */
  const packages = new Set();
  for (const pattern of new Set([...workspacePatterns(dir), ...PACKAGE_DIRS])) {
    for (const name of names) {
      for (const path of globSync(`${pattern}/${name}`, { cwd: dir })) {
        packages.add(path.split(sep).join("/"));
      }
    }
  }
  return [...names.filter((name) => existsSync(join(dir, name))), ...[...packages].sort()];
}

/**
 * The configurations under `dir` with their task entries, and what could not be read.
 * @param {string} dir
 * @returns {{ configs: { path: string, tasks: [string, unknown][] }[], findings: string[] }}
 */
function readConfigs(dir) {
  /** @type {{ path: string, tasks: [string, unknown][] }[]} */
  const configs = [];
  /** @type {string[]} */
  const findings = [];
  const paths = configPaths(dir);
  if (!paths.includes("turbo.json")) findings.push("turbo.json: missing");
  for (const path of paths) {
    if (path.endsWith(".jsonc")) {
      findings.push(`${path}: name it turbo.json, in plain JSON, so this check reads it`);
      continue;
    }
    /** @type {unknown} */
    let config;
    try {
      config = JSON.parse(readFileSync(join(dir, path), "utf8"));
    } catch {
      findings.push(`${path}: not plain JSON, so this check cannot read it`);
      continue;
    }
    const tasks = /** @type {{ tasks?: unknown }} */ (config)?.tasks;
    configs.push({
      path,
      tasks: typeof tasks === "object" && tasks !== null ? Object.entries(tasks) : [],
    });
  }
  return { configs, findings };
}

/**
 * Every entry under `dir` that breaks the ruling, one line each: a test task without
 * `"cache": false`, or another task that turns its caching off.
 * @param {string} dir
 * @returns {string[]}
 */
function cacheFindings(dir) {
  const { configs, findings } = readConfigs(dir);
  for (const { path, tasks } of configs) {
    for (const [key, definition] of tasks) {
      const cache = /** @type {{ cache?: unknown }} */ (definition)?.cache;
      if (isTestTask(taskOf(key))) {
        if (cache !== false) findings.push(`${path}: ${key} is a test task without "cache": false`);
      } else if (cache === false && !(path === "turbo.json" && CACHE_OFF.has(key))) {
        findings.push(`${path}: ${key} turns caching off, which only a test task does`);
      }
    }
  }
  return findings;
}

/**
 * The caching Turborepo itself resolves for each task it would run for `tasks` under `dir`, from a
 * dry run (nothing runs and nothing is cached).
 * @param {string} dir
 * @param {string[]} tasks
 * @returns {Map<string, unknown>} task ID to its resolved `cache`
 */
function resolvedCaching(dir, tasks) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("TURBO_")),
  );
  const run = spawnSync(TURBO, ["run", ...tasks, "--dry=json"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...env, TURBO_TELEMETRY_DISABLED: "1", TURBO_NO_UPDATE_NOTIFIER: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `turbo run --dry=json: ${run.stderr}`);
  const plan =
    /** @type {{ tasks: { taskId: string, resolvedTaskDefinition: { cache: unknown } }[] }} */ (
      JSON.parse(run.stdout)
    );
  return new Map(plan.tasks.map((task) => [task.taskId, task.resolvedTaskDefinition.cache]));
}

/**
 * The resolved tasks whose caching breaks the ruling.
 * @param {Map<string, unknown>} resolved
 * @returns {[string, unknown][]}
 */
function wronglyCached(resolved) {
  return [...resolved].filter(([id, cache]) =>
    isTestTask(taskOf(id)) ? cache !== false : cache !== !CACHE_OFF.has(id),
  );
}

/**
 * A two-package workspace whose root turbo.json has `tasks`.
 * @param {Record<string, unknown>} tasks
 * @param {Record<string, string>} [more] more files
 * @returns {string}
 */
function workspace(tasks, more = {}) {
  /** @param {string} name */
  const manifest = (name) =>
    `${JSON.stringify({ name, private: true, scripts: { test: "node -e 0", lint: "node -e 0" } })}\n`;
  return makeRepo({
    "package.json": `${JSON.stringify({ name: "fixture", private: true, packageManager: "pnpm@12.21.0" })}\n`,
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/identity/package.json": manifest("@fin/identity"),
    "packages/orgs/package.json": manifest("@fin/orgs"),
    "turbo.json": `${JSON.stringify({ tasks })}\n`,
    ...more,
  });
}

describe("Turborepo's cache and the tests", () => {
  test("names test tasks by their task, wherever the key puts it", () => {
    for (const task of ["test", "test:db", "test:root", "e2e", "e2e:ui", "journey", "journeys"]) {
      assert.ok(isTestTask(task), task);
    }
    for (const task of [
      "build",
      "build:test",
      "lint",
      "lint:root",
      "typecheck",
      "typecheck:root",
    ]) {
      assert.ok(!isTestTask(task), task);
    }
    assert.equal(taskOf("@fin/identity#test"), "test");
    assert.equal(taskOf("//#test:root"), "test:root");
    assert.equal(taskOf("test:db"), "test:db");
  });

  test("every test task in the repository's configurations is uncached, and no other task is", () => {
    assert.deepEqual(cacheFindings(REPO_ROOT), []);
  });

  test("Turborepo resolves every test task uncached, and build, lint and typecheck cached", () => {
    const { configs } = readConfigs(REPO_ROOT);
    const testTasks = new Set(
      configs.flatMap(({ tasks }) => tasks.map(([key]) => taskOf(key)).filter(isTestTask)),
    );
    for (const task of ["test", "test:db", "test:root"]) assert.ok(testTasks.has(task), task);
    const others = ["build", "lint", "typecheck", "lint:root", "typecheck:root"];
    const resolved = resolvedCaching(REPO_ROOT, [...testTasks, ...others]);
    for (const task of [...testTasks, ...others]) {
      assert.ok(
        [...resolved.keys()].some((id) => taskOf(id) === task),
        `the dry run plans ${task}`,
      );
    }
    assert.deepEqual(wronglyCached(resolved), []);
  });

  test("fails on a '<package>#test' entry without its own \"cache\": false, which Turborepo replays", () => {
    const dir = workspace({
      test: { cache: false },
      "@fin/identity#test": { inputs: ["$TURBO_DEFAULT$"], outputs: [] },
    });
    assert.deepEqual(cacheFindings(dir), [
      'turbo.json: @fin/identity#test is a test task without "cache": false',
    ]);
    // Turborepo really does cache it: the entry does not inherit the bare task's "cache": false.
    const resolved = resolvedCaching(dir, ["test"]);
    assert.equal(resolved.get("@fin/identity#test"), true);
    assert.equal(resolved.get("@fin/orgs#test"), false);
    assert.deepEqual(wronglyCached(resolved), [["@fin/identity#test", true]]);

    const fixed = workspace({
      test: { cache: false },
      "@fin/identity#test": { cache: false, inputs: ["$TURBO_DEFAULT$"], outputs: [] },
    });
    assert.deepEqual(cacheFindings(fixed), []);
    assert.deepEqual(wronglyCached(resolvedCaching(fixed, ["test"])), []);
  });

  test("fails on a package configuration that turns a test task's caching back on", () => {
    const dir = workspace(
      { test: { cache: false }, lint: { outputs: [] } },
      {
        "packages/orgs/turbo.json": `${JSON.stringify({ extends: ["//"], tasks: { test: { cache: true } } })}\n`,
      },
    );
    assert.deepEqual(cacheFindings(dir), [
      'packages/orgs/turbo.json: test is a test task without "cache": false',
    ]);
    const resolved = resolvedCaching(dir, ["test"]);
    assert.equal(resolved.get("@fin/orgs#test"), true);
    assert.deepEqual(wronglyCached(resolved), [["@fin/orgs#test", true]]);

    // A package's entry must say "cache": false itself, even where it would inherit it, and the
    // check finds configurations in apps/, ops/ and tools/ as well.
    addFiles(dir, {
      "packages/orgs/turbo.json": `${JSON.stringify({ extends: ["//"], tasks: { test: { inputs: ["$TURBO_DEFAULT$"] } } })}\n`,
      "apps/console/turbo.json": `${JSON.stringify({ extends: ["//"], tasks: { "test:db": {} } })}\n`,
      "ops/fin/turbo.json": `${JSON.stringify({ extends: ["//"], tasks: { e2e: { cache: true } } })}\n`,
      "tools/fin-review/turbo.json": `${JSON.stringify({ extends: ["//"], tasks: { test: { cache: false } } })}\n`,
    });
    assert.deepEqual(cacheFindings(dir), [
      'apps/console/turbo.json: test:db is a test task without "cache": false',
      'ops/fin/turbo.json: e2e is a test task without "cache": false',
      'packages/orgs/turbo.json: test is a test task without "cache": false',
    ]);
  });

  test('fails on any root test task without "cache": false', () => {
    const dir = workspace({
      test: { outputs: [] },
      "test:db": { passThroughEnv: ["FIN_TEST_DATABASE_URL"] },
      "//#test:root": { inputs: ["scripts/**"], outputs: [] },
      e2e: { cache: true },
      journey: { dependsOn: ["build"] },
    });
    assert.deepEqual(cacheFindings(dir), [
      'turbo.json: test is a test task without "cache": false',
      'turbo.json: test:db is a test task without "cache": false',
      'turbo.json: //#test:root is a test task without "cache": false',
      'turbo.json: e2e is a test task without "cache": false',
      'turbo.json: journey is a test task without "cache": false',
    ]);
  });

  test("fails when any other task's caching is turned off", () => {
    const dir = workspace(
      {
        test: { cache: false },
        build: { cache: false },
        "@fin/orgs#lint": { cache: false },
        "//#lint:root": { cache: false },
      },
      {
        "packages/identity/turbo.json": `${JSON.stringify({ extends: ["//"], tasks: { typecheck: { cache: false }, "lint:root": { cache: false } } })}\n`,
      },
    );
    assert.deepEqual(cacheFindings(dir), [
      "turbo.json: build turns caching off, which only a test task does",
      "turbo.json: @fin/orgs#lint turns caching off, which only a test task does",
      "packages/identity/turbo.json: typecheck turns caching off, which only a test task does",
      "packages/identity/turbo.json: lint:root turns caching off, which only a test task does",
    ]);
  });

  test("fails on a configuration it cannot read as plain JSON", () => {
    const dir = workspace(
      { test: { cache: false } },
      {
        "packages/orgs/turbo.jsonc":
          '{ "extends": ["//"], "tasks": { "test": { "cache": true } } }\n',
      },
    );
    assert.deepEqual(cacheFindings(dir), [
      "packages/orgs/turbo.jsonc: name it turbo.json, in plain JSON, so this check reads it",
    ]);
    addFiles(dir, { "turbo.json": '{\n  // cached again\n  "tasks": { "test": {} }\n}\n' });
    assert.deepEqual(cacheFindings(dir), [
      "turbo.json: not plain JSON, so this check cannot read it",
      "packages/orgs/turbo.jsonc: name it turbo.json, in plain JSON, so this check reads it",
    ]);
  });
});
