// The git work of a review run: a bare mirror per origin under $FIN_REVIEW_HOME/repos (never inside
// the repository under review), fetching a pull request's head and base into it, and checking a
// commit out as the scratch tree $FIN_REVIEW_HOME/trees/<run-id> that sessions read.
//
// Every argument is validated before it is placed in a git call (spec 07 §2.1). The checkout runs
// with no user or system git configuration (so no filter or hook from the machine runs on the
// tree), with symbolic links written as plain files (so a link in a pull request cannot point a
// session outside its tree), and leaves no .git in the tree.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProgramError } from "../errors.ts";
import { runProgram } from "../exec.ts";
import { diffRaw, gitEnv, isSha } from "../git.ts";
import type { DiffEntry } from "../git.ts";

export const PR_NUMBER_RE = /^[1-9][0-9]{0,6}$/;
const REF_NAME_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const SAFE_PATH_RE = /^\/[A-Za-z0-9._/@+ -]+$/;
const URL_RES: readonly RegExp[] = [
  /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9._/-]+$/,
  /^ssh:\/\/git@[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9._/-]+$/,
  /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/,
  /^\/[A-Za-z0-9._/@+-]+$/,
];
const GIT_PREFIX: readonly string[] = ["--no-replace-objects", "--no-pager", "-c", "core.fsmonitor=false"];
const FETCH_TIMEOUT_MS = 10 * 60_000;
const LOCAL_TIMEOUT_MS = 2 * 60_000;
const MAX_OUTPUT = 256 * 1024 * 1024;

export class RemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteError";
  }
}

export function isPrNumber(value: string): boolean {
  return PR_NUMBER_RE.test(value);
}

/** True for a branch name git accepts that is also safe in an argument. */
export function isRefName(value: string): boolean {
  return (
    REF_NAME_RE.test(value) &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.split("/").some((part) => part === "" || part.startsWith("."))
  );
}

/** True for an origin URL the engine fetches from: https, ssh or a local absolute path. */
export function isRemoteUrl(value: string): boolean {
  return !value.startsWith("-") && !value.split("/").includes("..") && URL_RES.some((re) => re.test(value));
}

/** `owner/name` of a GitHub origin URL, or null. */
export function githubSlug(url: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/.exec(url);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  if (match[1].startsWith(".") || match[2].startsWith(".")) return null;
  return `${match[1]}/${match[2]}`;
}

function assertDir(path: string, what: string): void {
  if (!SAFE_PATH_RE.test(path) || path.split("/").includes("..")) throw new TypeError(`${what} must be an absolute path of safe characters`);
}

interface GitCall {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  /** Variables added after the caller's GIT_* are removed (GIT_INDEX_FILE and the like). */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Exit codes that are answers, not failures (merge-base --is-ancestor answers 1). */
  readonly okCodes?: readonly number[];
}

async function git(call: GitCall): Promise<{ code: number; stdout: Buffer }> {
  const result = await runProgram("git", [...GIT_PREFIX, ...call.args], {
    cwd: call.cwd,
    env: { ...gitEnv(call.env), ...(call.extraEnv ?? {}) },
    timeoutMs: call.timeoutMs ?? LOCAL_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT,
  });
  const ok = [0, ...(call.okCodes ?? [])];
  if (result.code === null || !ok.includes(result.code)) {
    const first = result.stderr.toString("utf8").split("\n").find((line) => line.trim() !== "") ?? "";
    const what = call.args.find((arg) => !arg.startsWith("-")) ?? "";
    throw new ProgramError("git", `git ${what} failed (${result.code === null ? "signal" : `exit ${result.code}`})${first === "" ? "" : `: ${first}`}`, result.code, "");
  }
  return { code: result.code, stdout: result.stdout };
}

/** The origin URL of the repository at `repoDir`. Throws RemoteError when it has none or it is unusable. */
export async function originUrl(repoDir: string, env: Readonly<Record<string, string | undefined>>): Promise<string> {
  let out: Buffer;
  try {
    out = (await git({ cwd: repoDir, args: ["config", "--get", "remote.origin.url"], env })).stdout;
  } catch {
    throw new RemoteError("the repository has no origin remote");
  }
  const url = out.toString("utf8").trim();
  if (!isRemoteUrl(url)) throw new RemoteError("the origin URL is not an https, ssh or local path URL the engine accepts");
  return url;
}

/** The bare mirror for `url` under $FIN_REVIEW_HOME/repos, created when missing. */
export async function ensureMirror(home: string, url: string, env: Readonly<Record<string, string | undefined>>): Promise<string> {
  if (!isRemoteUrl(url)) throw new TypeError("refusing an origin URL");
  const repos = join(home, "repos");
  mkdirSync(repos, { recursive: true, mode: 0o700 });
  const mirror = join(repos, `${createHash("sha256").update(url, "utf8").digest("hex").slice(0, 16)}.git`);
  assertDir(mirror, "the mirror");
  if (!existsSync(join(mirror, "HEAD"))) {
    await git({ cwd: repos, args: ["init", "--bare", "--quiet", mirror], env, extraEnv: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  }
  return mirror;
}

export function pullHeadRef(pr: number): string {
  return `refs/fin-review/pull/${pr}/head`;
}

export function pullBaseRef(pr: number): string {
  return `refs/fin-review/pull/${pr}/base`;
}

/** Fetches the pull request's head and its base branch into the mirror. Throws RemoteError. */
export async function fetchPull(mirror: string, url: string, pr: number, baseRef: string, env: Readonly<Record<string, string | undefined>>): Promise<void> {
  assertDir(mirror, "the mirror");
  if (!isRemoteUrl(url)) throw new TypeError("refusing an origin URL");
  if (!Number.isInteger(pr) || !isPrNumber(String(pr))) throw new TypeError("refusing a pull request number");
  if (!isRefName(baseRef)) throw new TypeError("refusing a base branch name");
  try {
    await git({
      cwd: mirror,
      args: [
        "-c",
        "protocol.ext.allow=never",
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--",
        url,
        `+refs/pull/${pr}/head:${pullHeadRef(pr)}`,
        `+refs/heads/${baseRef}:${pullBaseRef(pr)}`,
      ],
      env,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
  } catch (error) {
    throw new RemoteError(`fetching pull request ${pr} failed: ${(error as Error).message}`);
  }
}

/** The commit a ref names in the mirror, or null. */
export async function resolveCommit(mirror: string, ref: string, env: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  if (!isRefName(ref) && !isSha(ref)) throw new TypeError("refusing a ref");
  const result = await git({ cwd: mirror, args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], env, okCodes: [1, 128] });
  const sha = result.stdout.toString("utf8").trim();
  return result.code === 0 && isSha(sha) ? sha : null;
}

export async function mergeBase(mirror: string, a: string, b: string, env: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  if (!isSha(a) || !isSha(b)) throw new TypeError("merge-base needs two SHAs");
  const result = await git({ cwd: mirror, args: ["merge-base", a, b], env, okCodes: [1] });
  const sha = result.stdout.toString("utf8").trim();
  return result.code === 0 && isSha(sha) ? sha : null;
}

export async function isAncestor(mirror: string, a: string, b: string, env: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  if (!isSha(a) || !isSha(b)) throw new TypeError("is-ancestor needs two SHAs");
  return (await git({ cwd: mirror, args: ["merge-base", "--is-ancestor", a, b], env, okCodes: [1] })).code === 0;
}

/** The two-dot diff `a b` (the delta of a commit run), with renames counted as in plan. */
export async function diffTwoDot(mirror: string, a: string, b: string, env: Readonly<Record<string, string | undefined>>): Promise<DiffEntry[]> {
  if (!isSha(a) || !isSha(b)) throw new TypeError("a diff needs two SHAs");
  return diffRaw(mirror, a, b, env);
}

/** Lines added plus deleted in `a b` (binary files count 0). */
export async function changedLines(mirror: string, a: string, b: string, env: Readonly<Record<string, string | undefined>>): Promise<number> {
  if (!isSha(a) || !isSha(b)) throw new TypeError("numstat needs two SHAs");
  const out = (await git({ cwd: mirror, args: ["diff", "--numstat", "-z", "-M50", "--no-color", "--no-ext-diff", a, b, "--"], env })).stdout.toString("utf8");
  let total = 0;
  for (const record of out.split("\0")) {
    const match = /^([0-9]+|-)\t([0-9]+|-)\t/.exec(record);
    if (match === null) continue;
    if (match[1] !== "-") total += Number(match[1]);
    if (match[2] !== "-") total += Number(match[2]);
  }
  return total;
}

/** The unified diff `range` (`a...b` or `a b`), cut at `maxBytes`; `truncated` says whether it was. */
export async function unifiedDiff(
  mirror: string,
  a: string,
  b: string,
  threeDot: boolean,
  maxBytes: number,
  env: Readonly<Record<string, string | undefined>>,
  paths: readonly string[] = [],
): Promise<{ text: string; truncated: boolean }> {
  if (!isSha(a) || !isSha(b)) throw new TypeError("a diff needs two SHAs");
  for (const path of paths) if (path.startsWith("-") || path.includes("\0")) throw new TypeError("refusing a diff path");
  const range = threeDot ? [`${a}...${b}`] : [a, b];
  const out = (await git({ cwd: mirror, args: ["diff", "--no-color", "--no-ext-diff", "-M50", "--no-relative", ...range, "--", ...paths.map((path) => `:(literal)${path}`)], env })).stdout;
  if (out.length <= maxBytes) return { text: out.toString("utf8"), truncated: false };
  return { text: out.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

/** Writes the tree of `sha` into the empty directory `treeDir`, with no .git and links as plain files. */
export async function checkoutTree(mirror: string, sha: string, treeDir: string, indexFile: string, env: Readonly<Record<string, string | undefined>>): Promise<void> {
  assertDir(mirror, "the mirror");
  assertDir(treeDir, "the tree");
  assertDir(indexFile, "the index file");
  if (!isSha(sha)) throw new TypeError("a checkout needs a SHA");
  mkdirSync(treeDir, { recursive: true, mode: 0o700 });
  const isolated = { GIT_INDEX_FILE: indexFile, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const config = ["-c", "core.symlinks=false", "-c", "core.autocrlf=false", "-c", "core.hooksPath=/dev/null", "-c", "core.bare=false"];
  await git({ cwd: mirror, args: [...config, `--git-dir=${mirror}`, `--work-tree=${treeDir}`, "read-tree", sha], env, extraEnv: isolated });
  await git({ cwd: mirror, args: [...config, `--git-dir=${mirror}`, `--work-tree=${treeDir}`, "checkout-index", "--all", "--force"], env, extraEnv: isolated });
}
