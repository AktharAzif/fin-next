// The real-build tests: bundle-check over every static app's real production build, built and
// staged as release.yml's static-build job builds them (release-static.mjs build: `turbo run build
// --force` for each app, source maps moved aside) and scanned as its static job scans them
// (`--artefacts`). Any finding fails it: a check that refuses an honest build fails the release,
// so a false-positive path that comes back fails here first. And the harness rule over a real
// server build of the workspace's own Vite, with a module of packages/testing planted in it. They
// build, so they run where the workspace is installed and FIN_REAL_BUILDS=1 asks for them (ci.yml's
// build job); elsewhere they are skipped and say why.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkArtefacts, checkServer } from "../bundle-check.mjs";
import { build, RELEASE, staticOutputs } from "../release-static.mjs";
import { tempDir, writeTree } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** The catalog's Vite (pnpm-workspace.yaml), whose server bundles the harness rule reads. */
const VITE_VERSION = "8.3.8";

describe("bundle-check over the real static builds", () => {
  it("finds nothing in any static app's real build, staged as the release stages it", (t) => {
    if (process.env.FIN_REAL_BUILDS !== "1") {
      t.skip("FIN_REAL_BUILDS=1 runs it after an install (ci.yml's build job): it builds the apps");
      return;
    }
    const layout = JSON.parse(readFileSync(join(ROOT, "tools", "layout.json"), "utf8"));
    const present = staticOutputs(layout).filter((o) =>
      existsSync(join(ROOT, "apps", o.app, "package.json")),
    );
    if (present.length === 0) {
      t.skip("no static app is on this branch yet");
      return;
    }
    const release = join(ROOT, RELEASE);
    assert.ok(!existsSync(release), `${RELEASE}/ is the release build's own folder: remove it`);
    t.after(() => rmSync(release, { recursive: true, force: true }));
    // The job's outputs and summary are the release's, not this test's.
    const env = { ...process.env };
    delete env.GITHUB_OUTPUT;
    delete env.GITHUB_STEP_SUMMARY;
    const { built } = build({ root: ROOT, env });
    assert.deepEqual(
      Object.keys(built).sort(),
      present.map((o) => o.key).sort(),
      "every static output of an app on this branch is built and staged",
    );
    const result = checkArtefacts(join(release, "static"));
    assert.equal(result.static, present.length);
    assert.deepEqual(result.findings, []);
  });
});

describe("bundle-check over a real Vite server build", () => {
  it("finds the harness a real server build bundles by its module comment, and nothing else", (t) => {
    if (process.env.FIN_REAL_BUILDS !== "1") {
      t.skip(
        "FIN_REAL_BUILDS=1 runs it after an install (ci.yml's build job): it builds with Vite",
      );
      return;
    }
    const vite = join(ROOT, "node_modules", "vite");
    const manifest = JSON.parse(readFileSync(join(vite, "package.json"), "utf8"));
    assert.equal(manifest.version, VITE_VERSION, "the catalog's Vite is installed");
    const dir = tempDir(t);
    writeTree(dir, {
      "packages/testing/src/sink.ts":
        'export function sink(x: number) {\n  return ["fin-harness", x];\n}\n',
      "apps/api/src/entry.ts":
        'import { sink } from "../../../packages/testing/src/sink.ts";\n\nexport function main() {\n  return sink(1);\n}\nconsole.log(main());\n',
      "apps/api/src/clean.ts": "export function main() {\n  return 1;\n}\nconsole.log(main());\n",
    });
    const app = join(dir, "apps", "api");
    /** @param {string} entry @param {string} out */
    const viteBuild = (entry, out) => {
      const run = spawnSync(
        process.execPath,
        [
          join(vite, "bin", "vite.js"),
          "build",
          "--ssr",
          entry,
          "--outDir",
          out,
          "--logLevel",
          "warn",
        ],
        { cwd: app, encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stdout + run.stderr);
    };
    viteBuild("src/entry.ts", "dist/server");
    viteBuild("src/clean.ts", "dist/clean");
    const planted = readFileSync(join(app, "dist", "server", "entry.mjs"), "utf8");
    assert.ok(
      planted.split("\n").some((line) => line === "// ../../packages/testing/src/sink.ts"),
      `Vite names the harness's module in a comment:\n${planted}`,
    );
    assert.deepEqual(
      checkServer("apps/api/dist/server", join(app, "dist", "server")).map(
        (f) => `${f.rule}: ${f.message}`,
      ),
      ["seam: the test harness (packages/testing) is bundled"],
    );
    assert.deepEqual(checkServer("apps/api/dist/clean", join(app, "dist", "clean")), []);
  });
});
