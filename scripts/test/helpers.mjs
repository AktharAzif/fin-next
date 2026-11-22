// Test helpers: throwaway git repositories under the system's temporary directory.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository this test suite belongs to. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Commits are made in UTC, as G-09 asks of every commit (the pre-push check refuses another
// offset); a test that needs another offset sets the date itself.
const GIT_ENV = {
  ...process.env,
  TZ: "UTC",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fin Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Fin Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/**
 * Runs git in a throwaway repository, isolated from the user's and the system's git settings.
 * @param {string} dir
 * @param {string[]} args
 * @param {Record<string, string>} [env] more environment, such as GIT_AUTHOR_DATE
 * @returns {string}
 */
export function git(dir, args, env = {}) {
  return execFileSync(
    "git",
    ["-C", dir, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    {
      encoding: "utf8",
      env: { ...GIT_ENV, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/**
 * Writes files (path to content) under `dir`, creating directories.
 * @param {string} dir
 * @param {Record<string, string>} files
 */
export function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    if (path.startsWith(".githooks/")) chmodSync(full, 0o755);
  }
}

/** @type {string[]} */
const created = [];

/**
 * Creates a git repository holding `files`, all tracked (added, not committed unless asked).
 * @param {Record<string, string>} files
 * @param {{ commit?: string }} [options]
 * @returns {string} the repository's directory
 */
export function makeRepo(files, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fin-check-"));
  created.push(dir);
  git(dir, ["init", "-q", "-b", "work"]);
  writeFiles(dir, files);
  git(dir, ["add", "-A"]);
  if (options.commit !== undefined) git(dir, ["commit", "-q", "-m", options.commit]);
  return dir;
}

/**
 * Adds (and tracks) more files in an existing fixture repository.
 * @param {string} dir
 * @param {Record<string, string>} files
 */
export function addFiles(dir, files) {
  writeFiles(dir, files);
  git(dir, ["add", "-A"]);
}

/** Removes every repository this process created. */
export function cleanUp() {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Reads a file of this repository.
 * @param {string} path
 * @returns {string}
 */
export function readRepoFile(path) {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * Runs one of the scripts as a command, returning its exit code and output.
 * @param {string} script e.g. "scripts/public-safety.mjs"
 * @param {string[]} args
 * @param {{ env?: Record<string, string>, input?: string, cwd?: string }} [options]
 * @returns {{ status: number, output: string }}
 */
export function runScript(script, args, options = {}) {
  const run = spawnSync(process.execPath, [join(REPO_ROOT, script), ...args], {
    encoding: "utf8",
    env: { ...GIT_ENV, ...options.env },
    input: options.input ?? "",
    cwd: options.cwd ?? REPO_ROOT,
  });
  return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}` };
}

/**
 * The rule names of a list of findings, sorted and unique.
 * @param {{ rule: string }[]} findings
 * @returns {string[]}
 */
export function rules(findings) {
  return [...new Set(findings.map((f) => f.rule))].sort();
}
