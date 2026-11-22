// gitleaks-change.sh: the commits the static job's gitleaks scans for each event, with a stand-in
// gitleaks on the PATH that prints the arguments it was given.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MAIN_REF } from "../commit-dates-utc.mjs";
import { commit, gitRepo, runGit, tempDir, writeTree } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../gitleaks-change.sh", import.meta.url));
const ZERO = "0".repeat(40);

/**
 * Runs the script in a repository with the stand-in gitleaks.
 * @param {import("node:test").TestContext} t
 * @param {string} dir
 * @param {Record<string, string>} env
 */
function scan(t, dir, env) {
  const bin = tempDir(t, "fin-ci-bin-");
  writeTree(bin, { gitleaks: '#!/bin/sh\nprintf "gitleaks-args: %s\\n" "$*"\n' });
  chmodSync(join(bin, "gitleaks"), 0o755);
  return spawnSync("bash", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, ...env },
  });
}

describe("gitleaks-change.sh", () => {
  it("scans a pull request's and a push's range, and a new branch's head alone", (t) => {
    const dir = gitRepo(t);
    const base = commit(dir);
    const head = commit(dir);
    const pr = scan(t, dir, { EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head });
    assert.equal(pr.status, 0, pr.stderr);
    assert.match(pr.stdout, new RegExp(`--log-opts=${base}\\.\\.${head} \\.`));
    const push = scan(t, dir, { EVENT_NAME: "push", BASE_SHA: base, HEAD_SHA: head });
    assert.match(push.stdout, new RegExp(`--log-opts=${base}\\.\\.${head} \\.`));
    const created = scan(t, dir, { EVENT_NAME: "push", BASE_SHA: ZERO, HEAD_SHA: head });
    assert.match(created.stdout, new RegExp(`--log-opts=-1 ${head} \\.`));
  });

  it("on a run started by hand, scans every commit the branch holds that main does not", (t) => {
    const dir = gitRepo(t);
    const main = commit(dir);
    runGit(dir, ["update-ref", MAIN_REF, main]);
    runGit(dir, ["checkout", "--quiet", "-b", "feature"]);
    commit(dir);
    const head = commit(dir);
    const run = scan(t, dir, { EVENT_NAME: "workflow_dispatch", BASE_SHA: "", HEAD_SHA: head });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`--log-opts=${main}\\.\\.${head} \\.`));
    assert.doesNotMatch(run.stdout, /--log-opts=-1 /);
  });

  it("refuses a run started by hand without main's commit, and a malformed head", (t) => {
    const dir = gitRepo(t);
    const head = commit(dir);
    const none = scan(t, dir, { EVENT_NAME: "workflow_dispatch", BASE_SHA: "", HEAD_SHA: head });
    assert.equal(none.status, 2);
    assert.match(none.stderr, /cannot be read/);
    assert.doesNotMatch(none.stdout, /gitleaks-args/);
    const bad = scan(t, dir, { EVENT_NAME: "pull_request", BASE_SHA: head, HEAD_SHA: "main" });
    assert.equal(bad.status, 2);
  });
});
