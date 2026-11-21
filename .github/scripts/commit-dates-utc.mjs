#!/usr/bin/env node
// commit-dates-utc (DECISIONS G-09): every commit a pull request brings has author and committer
// offsets of +0000, so no commit in this public repository says where its author was. A control
// path. The ruleset on main requires a status named `commit-dates-utc`; ci.yml's job of that name
// runs this script (main's copy from the engine checkout when main has one).
//
// It reads the raw commit objects (`git cat-file commit <sha>`), never a formatted log, so what is
// checked is exactly what is stored:
//   pull_request       every commit in BASE_SHA..HEAD_SHA (the pull request's own commits, merges
//                      from main included), with no exception
//   push               every pushed commit in BASE_SHA..HEAD_SHA (the event's before and after),
//                      except GitHub's own merge commits: two or more parents and GitHub as the
//                      committer (GitHub writes the merging user's offset into those); a push that
//                      creates the branch checks the head commit alone
//   any other event    (workflow_dispatch) every commit HEAD_SHA holds that main does not, read
//                      from refs/remotes/origin/main (the job's full checkout fetches it), with no
//                      exception: a run started by hand on a pull request's branch posts this
//                      check for its head, so it checks everything the branch would bring, never
//                      the head alone; without main's ref the input is unusable
// An operator script that rebuilds a pull request as one UTC commit on top of main and sets the
// status itself checks the same thing; this job passes on that commit too.
//
// Output: a `commit-dates-utc.range` line, one `commit-dates-utc.commit` line per commit and a
// closing `commit-dates-utc.result`. Exit 0 when every checked commit is UTC, 1 when one is not,
// 2 when the input is unusable.
import { annotation, clean, git, isMain, isSha, say, ZERO_SHA } from "./lib/ci.mjs";

/** The most commits one run reads; more means the range is not a pull request's. */
export const MAX_COMMITS = 5000;
export const UTC = "+0000";
/** Where the commits main already holds are read from, for an event with no base of its own. */
export const MAIN_REF = "refs/remotes/origin/main";
const MAIN_UNAVAILABLE = "main_unavailable";
/** GitHub's committer identity on the merge commits it writes (built, so no address is stored). */
export const GITHUB_COMMITTER = { name: "GitHub", email: ["noreply", "github.com"].join("@") };

const IDENTITY = /^(author|committer) (.*) <([^<>]*)> (\d+) ([+-]\d{4})$/;

/**
 * @typedef {{ name: string, email: string, time: number, offset: string }} Identity
 * @typedef {{ sha: string, parents: number, author: Identity | null, committer: Identity | null }} Commit
 */

/**
 * Reads the header of a raw commit object: its parents and its author and committer lines.
 * Continuation lines (a signature) and the message are ignored.
 * @param {string} sha
 * @param {string} raw
 * @returns {Commit}
 */
export function parseCommit(sha, raw) {
  /** @type {Commit} */
  const commit = { sha, parents: 0, author: null, committer: null };
  for (const line of raw.split("\n")) {
    if (line === "") break;
    if (line.startsWith("parent ")) commit.parents++;
    const match = IDENTITY.exec(line);
    if (match === null) continue;
    const [, role, name = "", email = "", time = "0", offset = ""] = match;
    /** @type {Identity} */
    const identity = { name, email, time: Number(time), offset };
    if (role === "author" && commit.author === null) commit.author = identity;
    if (role === "committer" && commit.committer === null) commit.committer = identity;
  }
  return commit;
}

/**
 * GitHub's own merge commit: two or more parents and GitHub as the committer.
 * @param {Commit} commit
 */
export function isGithubMerge(commit) {
  return (
    commit.parents >= 2 &&
    commit.committer !== null &&
    commit.committer.name === GITHUB_COMMITTER.name &&
    commit.committer.email.toLowerCase() === GITHUB_COMMITTER.email
  );
}

/**
 * The verdict on one commit.
 * @param {Commit} commit
 * @param {string} event
 * @returns {{ result: "pass" | "fail" | "skip", code: string }}
 */
export function judge(commit, event) {
  if (event === "push" && isGithubMerge(commit)) return { result: "skip", code: "github_merge" };
  if (commit.author === null || commit.committer === null) {
    return { result: "fail", code: "identity_unreadable" };
  }
  const bad = [];
  if (commit.author.offset !== UTC) bad.push("author_offset");
  if (commit.committer.offset !== UTC) bad.push("committer_offset");
  return bad.length === 0
    ? { result: "pass", code: "utc" }
    : { result: "fail", code: bad.join(",") };
}

/**
 * Where the commits to check start for an event: the commit whose ancestors are left out, or null
 * for a push that creates the branch (its head alone is checked). An event with no base of its
 * own starts at main's commit (MAIN_REF); without it, this throws MAIN_UNAVAILABLE.
 * @param {{ event: string, base: string, cwd: string }} input
 * @returns {string | null}
 */
export function rangeStart({ event, base, cwd }) {
  if (event === "pull_request") return base;
  if (event === "push") return base === "" || base === ZERO_SHA ? null : base;
  /** @type {string} */
  let main;
  try {
    main = git(["rev-parse", "--verify", "--quiet", `${MAIN_REF}^{commit}`], { cwd }).trim();
  } catch {
    throw new Error(MAIN_UNAVAILABLE);
  }
  if (!isSha(main)) throw new Error(MAIN_UNAVAILABLE);
  return main;
}

/**
 * The commits to check for an event (see the header), and where their range starts.
 * @param {{ event: string, base: string, head: string, cwd: string }} input
 * @returns {{ start: string | null, shas: string[] }}
 */
export function commitsToCheck({ event, base, head, cwd }) {
  const start = rangeStart({ event, base, cwd });
  if (start === null) return { start, shas: [head] };
  const out = git(
    ["rev-list", "--reverse", `--max-count=${MAX_COMMITS + 1}`, `${start}..${head}`],
    {
      cwd,
    },
  );
  return { start, shas: out.split("\n").filter((line) => line !== "") };
}

/**
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, print: (line: string) => void }} ctx
 * @returns {number}
 */
export function run(ctx) {
  const event = ctx.env.EVENT_NAME ?? "";
  const base = ctx.env.BASE_SHA ?? "";
  const head = ctx.env.HEAD_SHA ?? "";
  if (!/^[a-z_]{1,40}$/.test(event)) {
    ctx.print("commit-dates-utc.result result=fail code=event_missing");
    return 2;
  }
  if (!isSha(head) || (base !== "" && !isSha(base)) || (event === "pull_request" && !isSha(base))) {
    ctx.print("commit-dates-utc.result result=fail code=sha_invalid");
    return 2;
  }
  /** @type {string | null} */
  let start;
  /** @type {string[]} */
  let shas;
  try {
    ({ start, shas } = commitsToCheck({ event, base, head, cwd: ctx.cwd }));
  } catch (error) {
    const code =
      error instanceof Error && error.message === MAIN_UNAVAILABLE
        ? MAIN_UNAVAILABLE
        : "range_unreadable";
    ctx.print(`commit-dates-utc.result result=fail code=${code}`);
    return 2;
  }
  ctx.print(
    `commit-dates-utc.range event=${event} from=${start ?? "none"} head=${head} commits=${shas.length}`,
  );
  if (shas.length > MAX_COMMITS) {
    ctx.print(`commit-dates-utc.result result=fail code=too_many_commits limit=${MAX_COMMITS}`);
    return 2;
  }
  let failed = 0;
  let checked = 0;
  for (const sha of shas) {
    if (!isSha(sha)) {
      ctx.print("commit-dates-utc.result result=fail code=rev_list_output");
      return 2;
    }
    /** @type {Commit} */
    let commit;
    try {
      commit = parseCommit(sha, git(["cat-file", "commit", sha], { cwd: ctx.cwd }));
    } catch {
      ctx.print(`commit-dates-utc.commit sha=${sha} result=fail code=object_unreadable`);
      failed++;
      continue;
    }
    const verdict = judge(commit, event);
    if (verdict.result !== "skip") checked++;
    if (verdict.result === "fail") failed++;
    ctx.print(
      `commit-dates-utc.commit sha=${sha} author=${clean(commit.author?.offset ?? "none", 8)} committer=${clean(commit.committer?.offset ?? "none", 8)} result=${verdict.result} code=${verdict.code}`,
    );
  }
  if (failed > 0) {
    ctx.print(
      annotation(
        "error",
        "commit-dates-utc",
        `${failed} commit(s) carry a time-zone offset other than +0000 (G-09). Commit with TZ=UTC, or rebuild the branch as UTC commits.`,
      ),
    );
  }
  ctx.print(
    `commit-dates-utc.result result=${failed === 0 ? "pass" : "fail"} commits=${shas.length} checked=${checked} failed=${failed}`,
  );
  return failed === 0 ? 0 : 1;
}

if (isMain(import.meta)) {
  process.exitCode = run({ env: process.env, cwd: process.cwd(), print: say });
}
