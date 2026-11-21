// commit-dates-utc (G-09): the raw commit objects' offsets, per event, on real repositories.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { GITHUB_COMMITTER, isGithubMerge, judge, parseCommit, run } from "../commit-dates-utc.mjs";
import { collect, commit, gitRepo, mergeCommit, runGit } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../commit-dates-utc.mjs", import.meta.url));
const ZERO = "0".repeat(40);

/**
 * @param {string} cwd
 * @param {Record<string, string>} env
 */
function check(cwd, env) {
  const { lines, print } = collect();
  const code = run({ env, cwd, print });
  return { code, lines };
}

describe("parseCommit", () => {
  it("reads parents and both identities from a raw commit, ignoring a signature and the message", () => {
    const raw = [
      `tree ${"1".repeat(40)}`,
      `parent ${"2".repeat(40)}`,
      `parent ${"3".repeat(40)}`,
      "author Fin Test <ci@example.com> 1795000000 +0530",
      "committer Someone Else <other@example.com> 1795000001 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " committer Fake <x@example.com> 1 -0800",
      " -----END PGP SIGNATURE-----",
      "",
      "author In The Message <m@example.com> 1 -0700",
    ].join("\n");
    const parsed = parseCommit("a".repeat(40), raw);
    assert.equal(parsed.parents, 2);
    assert.deepEqual(parsed.author, {
      name: "Fin Test",
      email: "ci@example.com",
      time: 1795000000,
      offset: "+0530",
    });
    assert.equal(parsed.committer?.name, "Someone Else");
    assert.equal(parsed.committer?.offset, "+0000");
  });

  it("leaves an identity null when its line is malformed", () => {
    const parsed = parseCommit(
      "a".repeat(40),
      "tree x\nauthor broken\ncommitter A <a@example.com> 1 +0000\n",
    );
    assert.equal(parsed.author, null);
    assert.equal(judge(parsed, "pull_request").code, "identity_unreadable");
  });
});

describe("judge", () => {
  const identity = (/** @type {string} */ offset) => ({
    name: "A",
    email: "a@example.com",
    time: 1,
    offset,
  });
  const merge = {
    sha: "a".repeat(40),
    parents: 2,
    author: identity("+0530"),
    committer: { ...GITHUB_COMMITTER, time: 1, offset: "+0530" },
  };

  it("passes +0000 for both, fails any other offset for either", () => {
    const base = { sha: "a".repeat(40), parents: 1 };
    assert.equal(
      judge({ ...base, author: identity("+0000"), committer: identity("+0000") }, "pull_request")
        .result,
      "pass",
    );
    assert.equal(
      judge({ ...base, author: identity("+0530"), committer: identity("+0000") }, "pull_request")
        .code,
      "author_offset",
    );
    assert.equal(
      judge({ ...base, author: identity("+0000"), committer: identity("-0000") }, "pull_request")
        .code,
      "committer_offset",
    );
    assert.equal(
      judge({ ...base, author: identity("-0800"), committer: identity("+0100") }, "pull_request")
        .code,
      "author_offset,committer_offset",
    );
  });

  it("skips GitHub's own merge commits on push only", () => {
    assert.equal(isGithubMerge(merge), true);
    assert.equal(judge(merge, "push").result, "skip");
    assert.equal(judge(merge, "pull_request").result, "fail", "a pull request has no exception");
  });

  it("does not take a one-parent commit, or another committer, for GitHub's merge", () => {
    assert.equal(isGithubMerge({ ...merge, parents: 1 }), false);
    assert.equal(
      isGithubMerge({ ...merge, committer: { ...merge.committer, name: "GitHub Bot" } }),
      false,
    );
    assert.equal(
      isGithubMerge({ ...merge, committer: { ...merge.committer, email: "noreply@example.com" } }),
      false,
    );
  });
});

describe("run over a repository", () => {
  it("passes a pull request whose commits are all UTC, a merge from main included", (t) => {
    const dir = gitRepo(t);
    const base = commit(dir, { authorOffset: "+0530", committerOffset: "+0530" });
    runGit(dir, ["checkout", "--quiet", "-b", "feature"]);
    commit(dir);
    runGit(dir, ["checkout", "--quiet", "main"]);
    commit(dir, { file: "other.txt" });
    runGit(dir, ["checkout", "--quiet", "feature"]);
    const head = mergeCommit(dir, "main");
    const { code, lines } = check(dir, {
      EVENT_NAME: "pull_request",
      BASE_SHA: base,
      HEAD_SHA: head,
    });
    assert.equal(code, 0, lines.join("\n"));
    assert.match(lines.at(-1) ?? "", /result=pass commits=3 checked=3 failed=0/);
  });

  it("fails a pull request with one commit made outside UTC", (t) => {
    const dir = gitRepo(t);
    const base = commit(dir);
    commit(dir);
    const bad = commit(dir, { authorOffset: "+0530" });
    const head = commit(dir);
    const { code, lines } = check(dir, {
      EVENT_NAME: "pull_request",
      BASE_SHA: base,
      HEAD_SHA: head,
    });
    assert.equal(code, 1);
    assert.ok(
      lines.includes(
        `commit-dates-utc.commit sha=${bad} author=+0530 committer=+0000 result=fail code=author_offset`,
      ),
    );
    assert.ok(lines.some((l) => l.startsWith("::error title=commit-dates-utc::")));
  });

  it("passes the operator's rebuild: one UTC commit on top of main", (t) => {
    const dir = gitRepo(t);
    const base = commit(dir, { authorOffset: "-0700", committerOffset: "-0700" });
    const head = commit(dir);
    assert.equal(
      check(dir, { EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head }).code,
      0,
    );
  });

  it("on push to main, skips GitHub's merge commit but checks the commits it brings", (t) => {
    const dir = gitRepo(t);
    const before = commit(dir);
    runGit(dir, ["checkout", "--quiet", "-b", "feature"]);
    commit(dir);
    runGit(dir, ["checkout", "--quiet", "main"]);
    const github = {
      committerName: GITHUB_COMMITTER.name,
      committerEmail: GITHUB_COMMITTER.email,
      offset: "+0530",
    };
    const after = mergeCommit(dir, "feature", github);
    const ok = check(dir, { EVENT_NAME: "push", BASE_SHA: before, HEAD_SHA: after });
    assert.equal(ok.code, 0, ok.lines.join("\n"));
    assert.ok(
      ok.lines.some(
        (l) => l.includes(`sha=${after}`) && l.includes("result=skip code=github_merge"),
      ),
    );

    runGit(dir, ["checkout", "--quiet", "-b", "late", before]);
    commit(dir, { committerOffset: "+0100" });
    runGit(dir, ["checkout", "--quiet", "main"]);
    const later = mergeCommit(dir, "late", github);
    const bad = check(dir, { EVENT_NAME: "push", BASE_SHA: after, HEAD_SHA: later });
    assert.equal(bad.code, 1, "a non-UTC commit inside GitHub's merge still fails");
  });

  it("on push, does not excuse a merge commit someone else made outside UTC", (t) => {
    const dir = gitRepo(t);
    const before = commit(dir);
    runGit(dir, ["checkout", "--quiet", "-b", "feature"]);
    commit(dir);
    runGit(dir, ["checkout", "--quiet", "main"]);
    const after = mergeCommit(dir, "feature", { offset: "+0530" });
    assert.equal(check(dir, { EVENT_NAME: "push", BASE_SHA: before, HEAD_SHA: after }).code, 1);
  });

  it("checks the head alone for a push that creates the branch, and for other events", (t) => {
    const dir = gitRepo(t);
    commit(dir, { authorOffset: "+0530" });
    const head = commit(dir);
    for (const env of [
      { EVENT_NAME: "push", BASE_SHA: ZERO, HEAD_SHA: head },
      { EVENT_NAME: "push", BASE_SHA: "", HEAD_SHA: head },
      { EVENT_NAME: "workflow_dispatch", BASE_SHA: "", HEAD_SHA: head },
    ]) {
      const { code, lines } = check(dir, env);
      assert.equal(code, 0, `${env.EVENT_NAME}: ${lines.join("\n")}`);
      assert.match(lines.at(-1) ?? "", /commits=1 /);
    }
  });

  it("refuses unusable input with exit 2", (t) => {
    const dir = gitRepo(t);
    const head = commit(dir);
    assert.equal(check(dir, { EVENT_NAME: "", HEAD_SHA: head }).code, 2);
    assert.equal(check(dir, { EVENT_NAME: "pull_request", BASE_SHA: "", HEAD_SHA: head }).code, 2);
    assert.equal(
      check(dir, { EVENT_NAME: "pull_request", BASE_SHA: "HEAD~1", HEAD_SHA: head }).code,
      2,
    );
    assert.equal(check(dir, { EVENT_NAME: "push", BASE_SHA: "", HEAD_SHA: "main" }).code, 2);
    const missing = check(dir, {
      EVENT_NAME: "pull_request",
      BASE_SHA: "c".repeat(40),
      HEAD_SHA: head,
    });
    assert.equal(missing.code, 2);
    assert.match(missing.lines.at(-1) ?? "", /code=range_unreadable/);
  });

  it("runs as a script with the job's environment", (t) => {
    const dir = gitRepo(t);
    const base = commit(dir);
    const head = commit(dir);
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /commit-dates-utc\.result result=pass commits=1/);
  });
});
