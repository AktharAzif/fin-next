#!/usr/bin/env node
// The pre-push check (spec 01 §3.8; DECISIONS CI-16), called by .githooks/pre-push. Each machine
// runs `git config core.hooksPath .githooks` once. For every ref being pushed it:
//   - refuses a push to main (main changes only by merging a reviewed pull request);
//   - runs the public-safety check over what the push would publish (each new commit's message
//     and every file it adds or changes), with the overlay's refuse list when FIN_OVERLAY_FILE is
//     set;
//   - runs gitleaks with Fin's token shapes (.gitleaks.toml) over the same commits, redacted, when
//     gitleaks is installed.
// git passes the remote's name and URL as arguments and one line per ref on standard input:
//   <local ref> <local sha> <remote ref> <remote sha>
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatFinding, git } from "./lib/repo.mjs";
import { loadRefuseList, scanCommits } from "./public-safety.mjs";

const ZERO = /^0+$/;

/**
 * @typedef {{ localRef: string, localSha: string, remoteRef: string, remoteSha: string }} PushedRef
 */

/**
 * Parses git's pre-push input.
 * @param {string} input
 * @returns {PushedRef[]}
 */
export function parsePushInput(input) {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef = "", localSha = "", remoteRef = "", remoteSha = ""] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

/**
 * Whether a commit exists in the local repository.
 * @param {string} root
 * @param {string} sha
 * @returns {boolean}
 */
function hasCommit(root, sha) {
  return (
    spawnSync("git", ["-C", root, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" })
      .status === 0
  );
}

/**
 * The git log arguments that select what this push would publish for one ref.
 * @param {string} root
 * @param {string} remote
 * @param {PushedRef} ref
 * @returns {string[]}
 */
export function rangeFor(root, remote, ref) {
  if (!ZERO.test(ref.remoteSha) && hasCommit(root, ref.remoteSha))
    return [`${ref.remoteSha}..${ref.localSha}`];
  return [ref.localSha, "--not", `--remotes=${remote}`];
}

/**
 * Runs the pre-push checks.
 * @param {{ root: string, remote: string, input: string, overlay?: string | undefined,
 *   gitleaks?: string, log?: (line: string) => void }} options
 * @returns {number} the exit code
 */
export function prePush(options) {
  const log = options.log ?? ((line) => console.error(line));
  const refs = parsePushInput(options.input).filter((ref) => !ZERO.test(ref.localSha));
  let failed = false;
  for (const ref of refs) {
    if (ref.remoteRef === "refs/heads/main") {
      log("pre-push: refusing to push to main; open a pull request instead");
      failed = true;
    }
  }
  if (refs.length === 0) return failed ? 1 : 0;

  /** @type {string[]} */
  let refuseList;
  try {
    refuseList = loadRefuseList(options.overlay);
  } catch (error) {
    log(`pre-push: ${error instanceof Error ? error.message : "the overlay could not be read"}`);
    return 2;
  }

  const ranges = refs.map((ref) => rangeFor(options.root, options.remote, ref));
  const commits = [
    ...new Set(
      ranges.flatMap((range) =>
        git(options.root, ["rev-list", ...range, "--"])
          .split("\n")
          .filter(Boolean),
      ),
    ),
  ];
  const findings = scanCommits(options.root, commits, refuseList);
  for (const finding of findings) log(formatFinding(finding));
  const overlay =
    refuseList.length > 0
      ? " with the overlay's refuse list"
      : " (FIN_OVERLAY_FILE not set: no refuse list)";
  log(
    `pre-push: public-safety scanned ${commits.length} commit(s)${overlay}: ${findings.length} finding(s)`,
  );
  if (findings.length > 0) failed = true;

  const gitleaks = options.gitleaks ?? "gitleaks";
  const probe = spawnSync(gitleaks, ["version"], { stdio: "ignore" });
  if (probe.error !== undefined) {
    log("pre-push: gitleaks is not installed, so only public-safety ran (install gitleaks 8.30.1)");
  } else {
    for (const range of ranges) {
      const run = spawnSync(
        gitleaks,
        [
          "git",
          "--no-banner",
          "--redact",
          "--config",
          join(options.root, ".gitleaks.toml"),
          `--log-opts=${range.join(" ")}`,
          options.root,
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      if (run.status !== 0) {
        log("pre-push: gitleaks found a secret shape (output redacted)");
        failed = true;
      }
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  process.exitCode = prePush({
    root,
    remote: process.argv[2] ?? "origin",
    input: readFileSync(0, "utf8"),
    overlay: process.env.FIN_OVERLAY_FILE,
  });
}
