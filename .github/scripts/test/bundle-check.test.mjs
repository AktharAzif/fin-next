// The build job's bundle checks: seams in server bundles; maps, rendered files and third-party
// origins in static builds.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkBundles, checkServer, checkStatic, mapSources, originsIn } from "../bundle-check.mjs";
import { tempDir, writeTree } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../bundle-check.mjs", import.meta.url));

/**
 * @param {import("node:test").TestContext} t
 * @param {Record<string, string>} files
 */
function dirWith(t, files) {
  const dir = tempDir(t);
  writeTree(dir, files);
  return dir;
}

describe("server bundles", () => {
  it("passes a release bundle", (t) => {
    const dir = dirWith(t, {
      "main.js":
        'const target = "release";\n//#region ../../packages/server/src/main.ts\nexport {};\n',
      "main.js.map": JSON.stringify({
        version: 3,
        sources: ["../../packages/server/src/main.ts"],
        sourcesContent: ["// __FIN_BUILD_TARGET__ in a comment of the original"],
      }),
    });
    assert.deepEqual(checkServer("apps/api/dist/server", dir), []);
  });

  /** @type {[string, string][]} */
  const seams = [
    ["the unreplaced build target", "if (typeof __FIN_BUILD_TARGET__ === 'string') {}"],
    ["the seam marker", 'const seam = "fin:test-seam";'],
    ["a region from packages/testing", "//#region ../../packages/testing/src/sink.ts\n"],
    ["an import of @fin/testing", 'import { sink } from "@fin/testing/sink";'],
    ["a dynamic import of @fin/testing", 'await import("@fin/testing");'],
  ];
  for (const [what, text] of seams) {
    it(`refuses ${what}`, (t) => {
      const dir = dirWith(t, { "main.js": text });
      assert.equal(checkServer("x", dir)[0]?.rule, "seam");
    });
  }

  it("reads a map's sources, not its sourcesContent, and refuses the test harness there", (t) => {
    const harness = dirWith(t, {
      "main.js.map": JSON.stringify({ sources: ["../../packages/testing/src/a.ts"] }),
    });
    assert.equal(checkServer("x", harness)[0]?.rule, "seam");
    const broken = dirWith(t, { "main.js.map": "{" });
    assert.equal(checkServer("x", broken)[0]?.rule, "map");
    assert.deepEqual(mapSources('{"sources":["a",1,"b"]}'), ["a", "b"]);
    assert.equal(mapSources('{"version":3}'), null);
  });
});

describe("static builds", () => {
  it("passes a clean build with allowed library origins", (t) => {
    const dir = dirWith(t, {
      "index.html": '<!doctype html><script type="module" src="/assets/index-abc.js"></script>',
      "assets/index-abc.js":
        'const ns="http://www.w3.org/2000/svg";const e="https://react.dev/errors/1";new URL(p,"http://localhost");',
      "assets/index-abc.css": "@layer ui-sdk;",
    });
    assert.deepEqual(checkStatic("apps/console/dist/static", dir), []);
  });

  it("refuses a third-party origin in HTML, CSS or JavaScript", (t) => {
    /** @type {[string, string][]} */
    const cases = [
      ["index.html", '<link rel="stylesheet" href="https://fonts.googleapis.com/css2">'],
      ["assets/a.css", "@font-face{src:url(https://cdn.example.net/f.woff2)}"],
      ["assets/a.js", 'fetch("https://api.example.com/v1")'],
    ];
    for (const [file, text] of cases) {
      const dir = dirWith(t, { [file]: text });
      const findings = checkStatic("x", dir);
      assert.equal(findings[0]?.rule, "third-party-origin", file);
    }
  });

  it("refuses a left source map, a sourceMappingURL and the rendered files", (t) => {
    const rules = (/** @type {Record<string, string>} */ files) =>
      checkStatic("x", dirWith(t, files)).map((f) => f.rule);
    assert.deepEqual(rules({ "assets/a.js.map": "{}" }), ["source-map"]);
    assert.deepEqual(rules({ "assets/a.js": "x\n//# sourceMappingURL=a.js.map" }), ["source-map"]);
    assert.deepEqual(rules({ _headers: "/*\n  X: y" }), ["rendered-file"]);
    assert.deepEqual(rules({ "env.json": "{}" }), ["rendered-file"]);
  });

  it("refuses a link instead of following it", (t) => {
    const dir = dirWith(t, { "index.html": "" });
    symlinkSync("/etc/hosts", join(dir, "hosts"));
    assert.equal(checkStatic("x", dir)[0]?.rule, "link");
  });

  it("collects each origin once, lower-cased", () => {
    assert.deepEqual(
      originsIn("HTTPS://A.Example.com/x https://a.example.com/y http://b.example.org:8080/"),
      ["https://a.example.com", "http://b.example.org:8080"],
    );
  });
});

describe("checkBundles over apps/", () => {
  it("passes with a notice when nothing is built, and fails on a finding", (t) => {
    const root = tempDir(t);
    const none = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
    assert.equal(none.status, 0);
    assert.match(none.stdout, /::notice title=bundle-check::/);
    writeTree(root, {
      "apps/api/dist/server/main.js": "ok",
      "apps/console/dist/static/index.html": '<img src="https://img.example.com/a.png">',
    });
    const result = checkBundles(root);
    assert.equal(result.server, 1);
    assert.equal(result.static, 1);
    assert.equal(result.findings.length, 1);
    const run = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /bundle-check\.result result=fail server=1 static=1 findings=1/);
  });
});
