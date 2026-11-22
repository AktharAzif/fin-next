// cache-scope: a run restores the CI caches only when its own scope holds none of them, since only
// main's runs save them and actions/cache reads the run's own scope first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cacheScope, KEY_PREFIXES, main } from "../cache-scope.mjs";
import { tempDir } from "./helpers.mjs";

const REPO = "owner/fin-next";
const PR = "refs/pull/20/merge";

/**
 * A fake API: the number of cache entries per key prefix in the asked scope.
 * @param {Record<string, number>} counts
 */
function api(counts = {}) {
  /** @type {string[]} */
  const asked = [];
  /** @param {string} path */
  const request = async (path) => {
    asked.push(path);
    const key = decodeURIComponent(/[?&]key=([^&]*)/.exec(path)?.[1] ?? "");
    return { total_count: counts[key] ?? 0, actions_caches: [] };
  };
  return { request, asked };
}

describe("cacheScope", () => {
  it("lets main restore its own caches without asking", async () => {
    const { request, asked } = api({ "turbo-": 3 });
    assert.deepEqual(await cacheScope({ ref: "refs/heads/main", repo: REPO, request }), {
      restore: true,
      code: "main",
    });
    assert.deepEqual(asked, []);
  });

  it("restores on a pull request whose own scope holds no CI cache, asking for each prefix", async () => {
    const { request, asked } = api();
    assert.deepEqual(await cacheScope({ ref: PR, repo: REPO, request }), {
      restore: true,
      code: "own_scope_empty",
    });
    assert.equal(asked.length, KEY_PREFIXES.length);
    for (const [i, prefix] of KEY_PREFIXES.entries()) {
      assert.equal(
        asked[i],
        `/repos/${REPO}/actions/caches?ref=${encodeURIComponent(PR)}&key=${encodeURIComponent(prefix)}&per_page=1`,
      );
    }
  });

  it("restores nothing when the run's own scope holds a CI cache", async () => {
    for (const prefix of KEY_PREFIXES) {
      const { request } = api({ [prefix]: 1 });
      assert.deepEqual(await cacheScope({ ref: PR, repo: REPO, request }), {
        restore: false,
        code: "own_scope_has_entries",
      });
    }
    const branch = api({ "pnpm-store-": 2 });
    const onBranch = await cacheScope({
      ref: "refs/heads/p0/ci",
      repo: REPO,
      request: branch.request,
    });
    assert.equal(
      onBranch.restore,
      false,
      "a run started by hand on a branch reads that branch's scope",
    );
  });

  it("restores nothing when the listing fails or reads oddly, or the input is unusable", async () => {
    const failing = async () => {
      throw new Error("network");
    };
    assert.equal(
      (await cacheScope({ ref: PR, repo: REPO, request: failing })).code,
      "listing_failed",
    );
    for (const answer of [
      null,
      [],
      {},
      { total_count: "0" },
      { total_count: -1 },
      { total_count: 1.5 },
    ]) {
      const odd = async () => answer;
      assert.deepEqual(await cacheScope({ ref: PR, repo: REPO, request: odd }), {
        restore: false,
        code: "listing_unreadable",
      });
    }
    const { request } = api();
    for (const ref of ["", "refs/tags/v1", "refs/pull/x/merge", "refs/heads/a/../b", "main"]) {
      assert.equal((await cacheScope({ ref, repo: REPO, request })).code, "ref_unusable", ref);
    }
    assert.equal((await cacheScope({ ref: PR, repo: "x", request })).code, "repository_unusable");
  });
});

describe("the step", () => {
  it("writes restore= for the job and warns when it restores nothing", async (t) => {
    const dir = tempDir(t);
    const output = join(dir, "out.txt");
    const env = { GITHUB_REF: PR, GITHUB_REPOSITORY: REPO, GITHUB_OUTPUT: output };
    /** @type {string[]} */
    const lines = [];
    const write = process.stdout.write;
    process.stdout.write = /** @type {typeof process.stdout.write} */ (
      (/** @type {unknown} */ chunk) => {
        lines.push(String(chunk));
        return true;
      }
    );
    try {
      await main(env, api({ "turbo-": 1 }).request);
      await main({ ...env, GITHUB_REF: "refs/heads/main" }, api().request);
    } finally {
      process.stdout.write = write;
    }
    assert.equal(readFileSync(output, "utf8"), "restore=false\nrestore=true\n");
    assert.ok(lines.some((l) => l.startsWith("::warning title=cache scope::")));
    assert.ok(
      lines.includes(`ci.cache-scope ref=${PR} restore=false code=own_scope_has_entries\n`),
    );
    assert.ok(lines.includes("ci.cache-scope ref=refs/heads/main restore=true code=main\n"));
  });
});
