#!/usr/bin/env node
// Whether a job may restore the CI caches (ci.yml: check, db, build and bun; ARCHITECTURE §11.3;
// spec 07 §10.3). A control path.
//
// Only a push to main saves the pnpm store and Turborepo's cache, and every run means to restore
// main's. But actions/cache restores from the run's own ref first (a pull request's
// refs/pull/<n>/merge, or a branch's own ref for a run started by hand) and from main only after,
// and a pull request's run executes the pull request's own workflow files: an earlier commit could
// have changed a workflow to save a cache into that scope, and been force-pushed away since. So
// before any restore, this step lists the run's own scope through the API, and when it holds an
// entry under a key ci.yml restores (KEY_PREFIXES), or cannot be read, the job restores nothing
// and runs every task for real, with a warning. On main, the scope is main's own.
//
// Inputs (environment): GITHUB_REF, GITHUB_REPOSITORY, GH_TOKEN (the job's token, actions: read),
// and optionally GITHUB_API_URL. Output: `restore=true|false` for $GITHUB_OUTPUT, and one
// `ci.cache-scope ref=<ref> restore=<bool> code=<code>` line. It exits 0 with restore=false on
// every doubt (an unreadable ref, a failed or odd listing): restoring nothing is always safe.
import { annotate, clean, isMain, isRecord, say, setOutput } from "./lib/ci.mjs";

/** The cache keys ci.yml restores; an entry under one of these in a scope other than main's is refused. */
export const KEY_PREFIXES = ["pnpm-store-", "turbo-"];
export const MAIN_REF = "refs/heads/main";
const REF = /^refs\/(?:heads\/[A-Za-z0-9._/-]{1,200}|pull\/\d{1,10}\/merge)$/;

/** @typedef {(path: string) => Promise<unknown>} ApiRequest */

/**
 * The verdict for one run.
 * @param {{ ref: string, repo: string, request: ApiRequest }} input
 * @returns {Promise<{ restore: boolean, code: string }>}
 */
export async function cacheScope({ ref, repo, request }) {
  if (ref === MAIN_REF) return { restore: true, code: "main" };
  if (!REF.test(ref) || ref.includes("..")) return { restore: false, code: "ref_unusable" };
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { restore: false, code: "repository_unusable" };
  for (const prefix of KEY_PREFIXES) {
    /** @type {unknown} */
    let answer;
    try {
      answer = await request(
        `/repos/${repo}/actions/caches?ref=${encodeURIComponent(ref)}&key=${encodeURIComponent(prefix)}&per_page=1`,
      );
    } catch {
      return { restore: false, code: "listing_failed" };
    }
    const count = isRecord(answer) ? answer.total_count : undefined;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      return { restore: false, code: "listing_unreadable" };
    }
    if (count > 0) return { restore: false, code: "own_scope_has_entries" };
  }
  return { restore: true, code: "own_scope_empty" };
}

/**
 * The REST client: GET only, the job's read token, GitHub's API host.
 * @param {NodeJS.ProcessEnv} env
 * @returns {ApiRequest}
 */
function githubRequest(env) {
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const token = env.GH_TOKEN ?? "";
  return async (path) => {
    if (token === "") throw new Error("GH_TOKEN is not set");
    const response = await fetch(`${api}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return response.json();
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {ApiRequest} [request]
 */
export async function main(env, request = githubRequest(env)) {
  const ref = env.GITHUB_REF ?? "";
  const verdict = await cacheScope({ ref, repo: env.GITHUB_REPOSITORY ?? "", request });
  setOutput("restore", verdict.restore ? "true" : "false", env);
  if (!verdict.restore) {
    annotate(
      "warning",
      "cache scope",
      `no cache is restored (${verdict.code}): only main's caches are trusted, and this run's own scope ${verdict.code === "own_scope_has_entries" ? "holds entries no CI run on main saved" : "could not be checked"}`,
    );
  }
  say(`ci.cache-scope ref=${clean(ref, 120)} restore=${verdict.restore} code=${verdict.code}`);
  return verdict;
}

if (isMain(import.meta)) {
  await main(process.env);
  process.exitCode = 0;
}
