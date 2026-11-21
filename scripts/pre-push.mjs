#!/usr/bin/env node
// The pre-push check (spec 01 §3.8; DECISIONS CI-16), called by .githooks/pre-push. Each machine
// runs `git config core.hooksPath .githooks` once. For every ref being pushed it:
//   - refuses a push to main (main changes only by merging a reviewed pull request);
//   - refuses a ref that does not point at a commit (through any annotated tags);
//   - runs the public-safety check over what the push would publish: each new commit's message and
//     every file it adds or changes (for a merge, every file that differs from its first parent),
//     each annotated tag's message, and the pushed ref names, with the overlay's refuse list when
//     FIN_OVERLAY_FILE is set;
//   - runs gitleaks with Fin's token shapes (.gitleaks.toml) over the same commits, merges
//     included, redacted, when gitleaks is installed.
// git passes the remote's name and URL as arguments and one line per ref on standard input:
//   <local ref> <local sha> <remote ref> <remote sha>
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatFinding,
  git,
  loadRefuseList,
  refuseMatcher,
  scanCommits,
  scanMessage,
  scanName,
} from "./public-safety.mjs";

/** @typedef {import("./public-safety.mjs").Finding} Finding */

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
 * The type of a git object, or undefined when it is not in the repository.
 * @param {string} root
 * @param {string} sha
 * @returns {string | undefined}
 */
function objectType(root, sha) {
  const run = spawnSync("git", ["-C", root, "cat-file", "-t", sha], { encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : undefined;
}

/**
 * The git log arguments that select what this push would publish for one ref.
 * @param {string} root
 * @param {string} remote
 * @param {PushedRef} ref
 * @returns {string[]}
 */
export function rangeFor(root, remote, ref) {
  if (!ZERO.test(ref.remoteSha) && objectType(root, `${ref.remoteSha}^{commit}`) === "commit") {
    return [`${ref.remoteSha}..${ref.localSha}`];
  }
  return [ref.localSha, "--not", `--remotes=${remote}`];
}

/**
 * Reads the annotated tags a pushed object goes through, down to the object they name.
 * @param {string} root
 * @param {string} sha
 * @returns {{ messages: string[], type: string | undefined }}
 */
function peel(root, sha) {
  /** @type {string[]} */
  const messages = [];
  let current = sha;
  let type = objectType(root, current);
  for (let depth = 0; type === "tag" && depth < 16; depth++) {
    const raw = git(root, ["cat-file", "tag", current]);
    const split = raw.indexOf("\n\n");
    const header = split < 0 ? raw : raw.slice(0, split);
    const target = /^object ([0-9a-f]+)$/m.exec(header)?.[1];
    // The tagger line is the tagger's own git identity; the message is what the tag publishes
    // (its name is the pushed ref's, scanned with the other ref names).
    messages.push(split < 0 ? "" : raw.slice(split + 2));
    if (target === undefined) return { messages, type: undefined };
    current = target;
    type = objectType(root, current);
  }
  return { messages, type };
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
  const refused = refuseMatcher(refuseList);

  /** @type {Finding[]} */
  const findings = [];
  /** @type {PushedRef[]} */
  const commitRefs = [];
  for (const [index, ref] of refs.entries()) {
    // Reported by position, so the output never repeats a value found in a name.
    const label = `pushed ref #${index + 1}`;
    findings.push(...scanName(ref.remoteRef, refused, "in the pushed ref's name", label));
    const { messages, type } = peel(options.root, ref.localSha);
    for (const message of messages) {
      findings.push(...scanMessage(`${label} (tag message)`, message, refused));
    }
    if (type === "commit") commitRefs.push(ref);
    else {
      log(`pre-push: refusing ${ref.remoteRef}: it does not point at a commit`);
      failed = true;
    }
  }

  const ranges = commitRefs.map((ref) => rangeFor(options.root, options.remote, ref));
  const commits = [
    ...new Set(
      ranges.flatMap((range) =>
        git(options.root, ["rev-list", ...range, "--"])
          .split("\n")
          .filter(Boolean),
      ),
    ),
  ];
  findings.push(...scanCommits(options.root, commits, refuseList));
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
      // git log shows no diff for a merge unless asked; this shows each against its first parent.
      const run = spawnSync(
        gitleaks,
        [
          "git",
          "--no-banner",
          "--redact",
          "--config",
          join(options.root, ".gitleaks.toml"),
          `--log-opts=--diff-merges=first-parent ${range.join(" ")}`,
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
