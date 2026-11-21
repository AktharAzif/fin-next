// Turborepo's cache skips a package's tests only when nothing they run has changed (ARCHITECTURE
// §11.3). A package's tests run the source of its workspace dependencies too, so with the
// repository's turbo.json a change in a dependency, however deep, must change the hash of every
// dependant's `test` task; otherwise `pnpm check` replays a cached pass over code that now fails.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { addFiles, cleanUp, makeRepo, REPO_ROOT } from "./helpers.mjs";

after(cleanUp);

const TURBO = join(REPO_ROOT, "node_modules", ".bin", "turbo");

/**
 * A workspace package's manifest, with a test script and its workspace dependencies.
 * @param {string} name
 * @param {string[]} dependencies
 * @returns {string}
 */
function manifest(name, dependencies) {
  const deps = Object.fromEntries(dependencies.map((dep) => [dep, "workspace:*"]));
  return `${JSON.stringify(
    { name, private: true, scripts: { test: "node index.js" }, dependencies: deps },
    null,
    2,
  )}\n`;
}

/**
 * The hash of each `test` task that a dry run of `turbo run test` would run in `dir`.
 * @param {string} dir
 * @returns {Map<string, string>}
 */
function testHashes(dir) {
  const run = spawnSync(TURBO, ["run", "test", "--dry=json", "--no-update-notifier"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", TURBO_NO_UPDATE_NOTIFIER: "1" },
  });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  /** @type {{ tasks: { taskId: string, task: string, hash: string }[] }} */
  const summary = JSON.parse(run.stdout);
  return new Map(
    summary.tasks.filter((task) => task.task === "test").map((task) => [task.taskId, task.hash]),
  );
}

describe("turbo.json's test task", () => {
  test("changes a dependant's test hash when a dependency's source changes, at any depth", () => {
    assert.ok(existsSync(TURBO), "Turborepo is installed (pnpm install)");
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    // app depends on mid, which depends on base; other stands apart.
    const dir = makeRepo({
      "package.json": `${JSON.stringify(
        { name: "fixture", private: true, packageManager: root.packageManager },
        null,
        2,
      )}\n`,
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "turbo.json": readFileSync(join(REPO_ROOT, "turbo.json"), "utf8"),
      "packages/app/package.json": manifest("app", ["mid"]),
      "packages/app/index.js": "export const app = 1;\n",
      "packages/mid/package.json": manifest("mid", ["base"]),
      "packages/mid/index.js": "export const mid = 1;\n",
      "packages/base/package.json": manifest("base", []),
      "packages/base/index.js": "export const base = 1;\n",
      "packages/other/package.json": manifest("other", []),
      "packages/other/index.js": "export const other = 1;\n",
    });

    const before = testHashes(dir);
    assert.deepEqual([...before.keys()].sort(), [
      "app#test",
      "base#test",
      "mid#test",
      "other#test",
    ]);

    addFiles(dir, { "packages/base/index.js": "export const base = 2;\n" });
    const deep = testHashes(dir);
    for (const id of ["base#test", "mid#test", "app#test"]) {
      assert.notEqual(deep.get(id), before.get(id), `${id} reruns after base changes`);
    }
    assert.equal(deep.get("other#test"), before.get("other#test"), "other#test stays cached");

    addFiles(dir, { "packages/other/index.js": "export const other = 2;\n" });
    const apart = testHashes(dir);
    for (const id of ["base#test", "mid#test", "app#test"]) {
      assert.equal(apart.get(id), deep.get(id), `${id} stays cached after other changes`);
    }
    assert.notEqual(apart.get("other#test"), deep.get("other#test"));
  });
});
