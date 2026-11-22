// The CI scripts fail closed on a Node they were not written for: lib/ci.mjs's runtime guard, the
// isMain guard every script runs its command line under, and each script run on a simulated Node
// without import.meta.main (as before 22.18 and 24.2), where a bare `if (import.meta.main)` would
// skip the check and exit 0.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMain, NODE_FLOOR, runtimeProblem } from "../lib/ci.mjs";
import { tempDir, writeTree } from "./helpers.mjs";

const SCRIPTS = fileURLToPath(new URL("../", import.meta.url));

/**
 * A module hook that loads .github/scripts' modules with an import.meta that has no `main`, as a
 * Node before 22.18 and 24.2 gives them.
 */
const OLD_NODE_HOOK = `import { registerHooks } from "node:module";
const HELPER =
  "const __finOldMeta = (m) => ({ url: m.url, dirname: m.dirname, filename: m.filename, resolve: m.resolve });\\n";
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith("file:") || !url.includes("/.github/scripts/") || result.format !== "module") {
      return result;
    }
    let source = Buffer.from(result.source).toString("utf8");
    source = source.replace(/\\bimport\\.meta\\b(?!\\.(?:url|dirname|filename|resolve)\\b)/g, "__finOldMeta(import.meta)");
    const start = source.startsWith("#!") ? source.indexOf("\\n") + 1 : 0;
    return { ...result, source: source.slice(0, start) + HELPER + source.slice(start) };
  },
});
`;

/**
 * Runs a script under the simulated old Node.
 * @param {import("node:test").TestContext} t
 * @param {string} script
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function runOnOldNode(t, script, args, env) {
  const dir = tempDir(t);
  writeTree(dir, { "old-node.mjs": OLD_NODE_HOOK });
  return spawnSync(
    process.execPath,
    ["--import", pathToFileURL(join(dir, "old-node.mjs")).href, script, ...args],
    { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, ...env } },
  );
}

describe("the runtime guard", () => {
  it("accepts this Node, and refuses an older major or one without import.meta.main", () => {
    assert.equal(runtimeProblem({ main: false }, process.versions.node), null);
    assert.equal(runtimeProblem({ main: true }, `${NODE_FLOOR}.0.0`), null);
    assert.match(runtimeProblem({ main: true }, "22.17.0") ?? "", /need Node 26 or newer/);
    assert.match(runtimeProblem({ main: true }, "20.19.5") ?? "", /Node 20\.19\.5/);
    assert.match(runtimeProblem({ main: true }, "not a version") ?? "", /need Node/);
    assert.match(runtimeProblem({}, "26.13.1") ?? "", /no import\.meta\.main/);
  });

  it("isMain answers for a boolean and throws for anything else", () => {
    assert.equal(isMain({ main: true }), true);
    assert.equal(isMain({ main: false }), false);
    assert.throws(() => isMain({}), /import\.meta\.main/);
    assert.throws(() => isMain({ main: "yes" }), /import\.meta\.main/);
  });

  it("is what every script's command line runs under: no bare import.meta.main guard", () => {
    for (const name of readdirSync(SCRIPTS).filter((n) => n.endsWith(".mjs"))) {
      const text = readFileSync(join(SCRIPTS, name), "utf8");
      assert.doesNotMatch(text, /if \(import\.meta\.main\)/, name);
      if (/\bisMain\(import\.meta\)/.test(text) || name === "node-check.mjs") {
        assert.match(text, /from "\.\/lib\/ci\.mjs"/, `${name} imports the guard`);
      }
    }
  });
});

describe("on a Node without import.meta.main, every script fails instead of passing unchecked", () => {
  const failing = JSON.stringify({
    plan: { result: "failure" },
    check: { result: "failure" },
    db: { result: "cancelled" },
    build: { result: "failure" },
    static: { result: "failure" },
    "commit-dates-utc": { result: "failure" },
  });

  /** @type {[string, string[], NodeJS.ProcessEnv][]} */
  const cases = [
    ["gate.mjs", [], { NEEDS: failing, PLAN: "", ENGINE_DIR: "/nonexistent" }],
    [
      "commit-dates-utc.mjs",
      [],
      { EVENT_NAME: "pull_request", BASE_SHA: "b".repeat(40), HEAD_SHA: "a".repeat(40) },
    ],
    ["workflow-rules.mjs", ["--root", "/nonexistent"], {}],
    ["bundle-check.mjs", ["--root", "/nonexistent"], {}],
    ["release-static.mjs", ["manifest"], {}],
    ["plan-fallback.mjs", [], {}],
    ["node-check.mjs", [], {}],
  ];
  for (const [name, args, env] of cases) {
    it(`${name} exits non-zero and says why`, (t) => {
      const run = runOnOldNode(t, join(SCRIPTS, name), args, env);
      assert.notEqual(run.status, 0, `${name} exited 0: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, /a script could not tell it was run/, name);
    });
  }

  it("node-check.mjs passes on this Node and prints the version line", () => {
    const run = spawnSync(process.execPath, [join(SCRIPTS, "node-check.mjs")], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      run.stdout,
      `ci.node version=${process.versions.node} floor=${NODE_FLOOR} result=pass\n`,
    );
  });
});
