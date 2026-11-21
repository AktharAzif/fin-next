// gitleaks-static.sh: gitleaks over built static folders, with a stand-in gitleaks that prints
// its arguments, and with the real one (on the PATH in the static job and the toolchain) over a
// folder .gitignore ignores, holding a token-shaped value built at run time.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir, writeTree } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../gitleaks-static.sh", import.meta.url));
const CONFIG = fileURLToPath(new URL("../../../.gitleaks.toml", import.meta.url));
const REAL = spawnSync("gitleaks", ["version"], { encoding: "utf8" }).status === 0;

/**
 * Runs the script in a workspace holding .gitleaks.toml.
 * @param {string} workspace
 * @param {string[]} args
 * @param {string} [bin] a folder to put first on the PATH
 */
function scan(workspace, args, bin) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      PATH: bin === undefined ? process.env.PATH : `${bin}:${process.env.PATH}`,
      GITHUB_WORKSPACE: workspace,
    },
  });
}

describe("gitleaks-static.sh", () => {
  it("scans each built folder with the workspace's config, and skips what is not one", (t) => {
    const workspace = tempDir(t);
    writeTree(workspace, {
      ".gitleaks.toml": 'title = "x"\n',
      "apps/console/dist/static/index.html": "<p>",
      "apps/docs/dist/static/LEAK": "x",
    });
    const bin = tempDir(t, "fin-ci-bin-");
    writeTree(bin, {
      gitleaks:
        '#!/bin/sh\nprintf "gitleaks-args: %s\\n" "$*"\nfor a in "$@"; do last="$a"; done\n[ -e "$last/LEAK" ] && exit 1\nexit 0\n',
    });
    chmodSync(join(bin, "gitleaks"), 0o755);
    const clean = scan(workspace, ["apps/console/dist/static", "apps/*/dist/none"], bin);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(
      clean.stdout,
      new RegExp(
        `gitleaks-args: dir --redact --no-banner --config ${join(workspace, ".gitleaks.toml")} apps/console/dist/static`,
      ),
    );
    assert.match(
      clean.stdout,
      /::notice title=gitleaks-static::apps\/\*\/dist\/none is not a built folder/,
    );
    assert.match(clean.stdout, /gitleaks\.static\.result result=pass dirs=1/);
    const leak = scan(workspace, ["apps/console/dist/static", "apps/docs/dist/static"], bin);
    assert.equal(leak.status, 1, "a finding fails the scan");
    assert.doesNotMatch(leak.stdout, /result=pass/);
  });

  it("refuses to run without the workspace's config", (t) => {
    const workspace = tempDir(t);
    assert.equal(scan(workspace, ["."]).status, 2);
  });

  it("finds a secret shape in a git-ignored build folder with the real gitleaks", {
    skip: !REAL,
  }, (t) => {
    const workspace = tempDir(t);
    const token = ["whsec", "_", "QmFzZTY0U2VjcmV0VmFsdWVGb3JUZXN0aW5nMTIzNA=="].join("");
    writeTree(workspace, {
      ".gitleaks.toml": readFileSync(CONFIG, "utf8"),
      ".gitignore": "dist/\n",
      "apps/console/dist/static/index.html": "<p>",
      "apps/console/dist/static/assets/a.js": `const s="${token}";\n`,
    });
    const run = scan(workspace, ["apps/console/dist/static"]);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(token), "findings are redacted");
  });
});
