// The review's git and GitHub reads (argument validation, the mirror and the checkout), the run lock
// and the session pool.

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PULL_FILTER, parsePullFacts, pullFactsArgs } from "../src/gh.ts";
import { LockHeldError, acquireLock } from "../src/review/lock.ts";
import { Pool } from "../src/review/pool.ts";
import { checkoutTree, ensureMirror, fetchPull, githubSlug, isRefName, isRemoteUrl, pullHeadRef, resolveCommit } from "../src/review/repo.ts";
import { FixtureRepo, tempDir } from "./helpers/git-fixture.ts";
import { fakeClock } from "./helpers/review-fixture.ts";

describe("argument validation (spec 07 §2.1)", () => {
  it("accepts branch names git accepts and refuses the rest", () => {
    for (const name of ["main", "p0/fin-review-core", "release-1.2"]) assert.ok(isRefName(name), name);
    for (const name of ["-x", "a..b", "a/", "/a", ".hidden", "a/.b", "a.lock", "a b", "a;b", "", "a//b"]) assert.ok(!isRefName(name), name);
  });

  it("accepts https, ssh and local-path origins only", () => {
    for (const url of ["https://github.com/o/r.git", "git@github.com:o/r.git", "ssh://git@github.com/o/r", "/srv/git/r"]) assert.ok(isRemoteUrl(url), url);
    for (const url of ["ext::sh -c x", "file:///x", "http://github.com/o/r", "-uploadpack=x", "https://h/a/../b", "git@h:a b"]) assert.ok(!isRemoteUrl(url), url);
  });

  it("reads a GitHub slug from the origin", () => {
    assert.equal(githubSlug("https://github.com/AktharAzif/fin-next.git"), "AktharAzif/fin-next");
    assert.equal(githubSlug("git@github.com:o/r"), "o/r");
    assert.equal(githubSlug("https://example.com/o/r"), null);
  });

  it("builds gh's arguments from validated values and reads only the filtered fields", () => {
    assert.deepEqual(pullFactsArgs("o/r", 12), ["api", "repos/o/r/pulls/12", "--jq", PULL_FILTER]);
    assert.ok(!PULL_FILTER.includes("title") && !PULL_FILTER.includes("body") && !PULL_FILTER.includes(".head.ref"));
    assert.throws(() => pullFactsArgs("o/r;rm", 1));
    assert.throws(() => pullFactsArgs("o/r", 0));
    const sha = "a".repeat(40);
    const facts = parsePullFacts(Buffer.from(JSON.stringify({ head: sha, baseRef: "main", baseSha: "b".repeat(40), state: "open", sameRepository: true })));
    assert.equal(facts.head, sha);
    for (const bad of [{ head: "x" }, { head: sha, baseRef: "-x", baseSha: sha, state: "open", sameRepository: true }, { head: sha, baseRef: "main", baseSha: sha, state: "merged", sameRepository: true }]) {
      assert.throws(() => parsePullFacts(Buffer.from(JSON.stringify(bad))));
    }
  });
});

describe("the mirror and the scratch tree", () => {
  let tmp: ReturnType<typeof tempDir>;
  let origin: FixtureRepo;
  let head: string;
  const env = (): Record<string, string> => ({ PATH: process.env["PATH"] ?? "", HOME: tmp.dir });

  before(() => {
    tmp = tempDir("mirror");
    mkdirSync(join(tmp.dir, "origin"));
    origin = new FixtureRepo(join(tmp.dir, "origin"));
    const base = origin.commit(null, { "README.md": "# r\n", "src/a.ts": "export const a = 1;\r\n" });
    origin.git(["update-ref", "refs/heads/main", base]);
    head = origin.commit(base, { "src/b.ts": "export const b = 2;\n" });
    origin.git(["update-ref", "refs/pull/7/head", head]);
  });
  after(() => tmp.cleanup());

  it("fetches a pull request's head and base into a mirror outside the repository", async () => {
    const home = join(tmp.dir, "home");
    const mirror = await ensureMirror(home, origin.dir, env());
    assert.ok(mirror.startsWith(join(home, "repos")));
    await fetchPull(mirror, origin.dir, 7, "main", env());
    assert.equal(await resolveCommit(mirror, pullHeadRef(7), env()), head);
    assert.equal(await ensureMirror(home, origin.dir, env()), mirror, "the same origin reuses its mirror");
  });

  it("checks a commit out with no .git, CRLF kept as committed, and links written as plain files", async () => {
    const home = join(tmp.dir, "home2");
    const mirror = await ensureMirror(home, origin.dir, env());
    // Commit a symbolic link to /etc/passwd with fast-import's mode 120000.
    const withLink = (() => {
      const ref = "refs/heads/link";
      const data = "/etc/passwd";
      const script = `commit ${ref}\ncommitter F <f@example.com> 1763683200 +0000\ndata 1\nx\nfrom ${head}\nM 120000 inline evil\ndata ${data.length}\n${data}\n\ndone\n`;
      origin.git(["fast-import", "--quiet", "--done"], Buffer.from(script));
      return origin.git(["rev-parse", ref]).trim();
    })();
    origin.git(["update-ref", "refs/pull/8/head", withLink]);
    await fetchPull(mirror, origin.dir, 8, "main", env());
    const tree = join(home, "trees", "t1");
    await checkoutTree(mirror, withLink, tree, join(home, "index"), env());
    assert.ok(!existsSync(join(tree, ".git")));
    assert.equal(readFileSync(join(tree, "src/a.ts"), "utf8"), "export const a = 1;\r\n");
    assert.ok(lstatSync(join(tree, "evil")).isFile(), "a link is a plain file");
    assert.equal(readFileSync(join(tree, "evil"), "utf8"), "/etc/passwd");
  });

  it("refuses unsafe values before any git call", async () => {
    await assert.rejects(fetchPull("/x", "ext::sh", 1, "main", env()), TypeError);
    await assert.rejects(fetchPull("/x", origin.dir, 1, "-x", env()), TypeError);
    await assert.rejects(checkoutTree("/x", "HEAD", "/y", "/z", env()), TypeError);
  });
});

describe("the run lock (spec 07 §4.9)", () => {
  it("is held once per pull request; a dead holder's lock is broken with a line", () => {
    const tmp = tempDir("lock");
    try {
      const clock = fakeClock();
      const broken: string[] = [];
      const lock = acquireLock(tmp.dir, 3, { runId: "r1", head: "a".repeat(40) }, clock, (id, why) => broken.push(`${id}:${why}`));
      assert.throws(() => acquireLock(tmp.dir, 3, { runId: "r2", head: "a".repeat(40) }, clock, () => {}), LockHeldError);
      const other = acquireLock(tmp.dir, 4, { runId: "r3", head: "a".repeat(40) }, clock, () => {});
      other.release();
      lock.release();
      writeFileSync(join(tmp.dir, "state", "locks", "pr-3.lock"), JSON.stringify({ pid: 2 ** 22 + 7, runId: "dead", head: "x", startedAt: new Date(clock.now()).toISOString() }));
      acquireLock(tmp.dir, 3, { runId: "r4", head: "a".repeat(40) }, clock, (id, why) => broken.push(`${id}:${why}`)).release();
      writeFileSync(join(tmp.dir, "state", "locks", "pr-3.lock"), JSON.stringify({ pid: process.pid, runId: "old", head: "x", startedAt: new Date(clock.now() - 4 * 3600_000).toISOString() }));
      acquireLock(tmp.dir, 3, { runId: "r5", head: "a".repeat(40) }, clock, (id, why) => broken.push(`${id}:${why}`)).release();
      assert.deepEqual(broken, ["dead:process_gone", "old:too_old"]);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("the session pool", () => {
  it("never runs more than its limit, even when a slot frees while callers arrive", async () => {
    const pool = new Pool(2);
    let running = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setImmediate(resolve));
      running--;
    };
    await Promise.all(Array.from({ length: 10 }, () => pool.run(task)));
    assert.equal(peak, 2);
    assert.equal(pool.running, 0);
    assert.throws(() => new Pool(0));
  });
});
