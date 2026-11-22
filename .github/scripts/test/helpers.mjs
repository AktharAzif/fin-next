// Test helpers for the CI scripts: temporary folders and git repositories with chosen dates.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A fresh temporary folder, removed after the test.
 * @param {import("node:test").TestContext} t
 * @param {string} [prefix]
 */
export function tempDir(t, prefix = "fin-ci-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Writes files under a folder: `{ "a/b.txt": "text" }`.
 * @param {string} root
 * @param {Record<string, string | Buffer>} files
 */
export function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** The environment a test's git runs with: no user configuration, no GIT_* from outside. */
function baseGitEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  return env;
}

/**
 * Runs git in a test repository.
 * @param {string} cwd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [extra]
 */
export function runGit(cwd, args, extra = {}) {
  return execFileSync("git", args, {
    cwd,
    env: { ...baseGitEnv(), ...extra },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * A new repository with a main branch.
 * @param {import("node:test").TestContext} t
 */
export function gitRepo(t) {
  const dir = tempDir(t, "fin-ci-git-");
  runGit(dir, ["init", "--quiet", "--initial-branch=main"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

/** Commits made so far, so each one changes a file of its own and merges never conflict. */
let commits = 0;

/**
 * Makes a commit with the given identities and offsets and returns its SHA.
 * @param {string} dir
 * @param {{
 *   file?: string, text?: string, message?: string,
 *   authorOffset?: string, committerOffset?: string,
 *   committerName?: string, committerEmail?: string,
 * }} [options]
 */
export function commit(dir, options = {}) {
  commits++;
  const file = options.file ?? `change-${commits}.txt`;
  writeTree(dir, { [file]: options.text ?? `change ${commits}\n` });
  runGit(dir, ["add", "--all"]);
  runGit(dir, ["commit", "--quiet", "--no-verify", "-m", options.message ?? "a change"], {
    GIT_AUTHOR_NAME: "Fin Test",
    GIT_AUTHOR_EMAIL: "ci@example.com",
    GIT_AUTHOR_DATE: `1795000000 ${options.authorOffset ?? "+0000"}`,
    GIT_COMMITTER_NAME: options.committerName ?? "Fin Test",
    GIT_COMMITTER_EMAIL: options.committerEmail ?? "ci@example.com",
    GIT_COMMITTER_DATE: `1795000000 ${options.committerOffset ?? "+0000"}`,
  });
  return runGit(dir, ["rev-parse", "HEAD"]);
}

/**
 * A merge commit of `branch` into the current branch, with the given committer and offsets.
 * @param {string} dir
 * @param {string} branch
 * @param {{ committerName?: string, committerEmail?: string, offset?: string }} [options]
 */
export function mergeCommit(dir, branch, options = {}) {
  runGit(dir, ["merge", "--quiet", "--no-ff", "--no-edit", branch], {
    GIT_AUTHOR_NAME: "Fin Test",
    GIT_AUTHOR_EMAIL: "ci@example.com",
    GIT_AUTHOR_DATE: `1795000100 ${options.offset ?? "+0000"}`,
    GIT_COMMITTER_NAME: options.committerName ?? "Fin Test",
    GIT_COMMITTER_EMAIL: options.committerEmail ?? "ci@example.com",
    GIT_COMMITTER_DATE: `1795000100 ${options.offset ?? "+0000"}`,
  });
  return runGit(dir, ["rev-parse", "HEAD"]);
}

/** A print function that keeps the lines. */
export function collect() {
  /** @type {string[]} */
  const lines = [];
  return { lines, print: (/** @type {string} */ line) => lines.push(line) };
}
