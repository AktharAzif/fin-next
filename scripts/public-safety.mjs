#!/usr/bin/env node
// public-safety (EXECUTION §2.2, §1.5 item 7; spec 01 §9). A control path. The repository is
// public, so this check refuses, in tracked files (and their paths):
//   - email addresses outside example.com, example.org and example.net (and the names reserved
//     never to resolve: .example, .invalid, .test, .localhost);
//   - strings shaped like account IDs (32 hex), tunnel, project, service or environment IDs
//     (UUIDs), tokens and private keys, and private IP addresses;
//   - claude.ai artifact identifiers;
//   - when FIN_OVERLAY_FILE names a JSON file with a "refuseList" array, each listed string, case
//     insensitively (a 40-character commit SHA also by any prefix of 7 or more characters).
// It prints file:line and the rule's name, never the matched value, so its output is safe in a
// public log. With --commits or --range it scans what a push would publish instead: each commit's
// message and the full content of every file it adds or changes.
//
// Exit codes: 0 clean, 1 findings, 2 a usage or overlay error (the check fails closed).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitBytes, isBinary, isRecord, listFiles, report } from "./lib/repo.mjs";

/** @typedef {import("./lib/repo.mjs").Finding} Finding */
/** @typedef {{ name: string, pattern: RegExp, allow?: (match: RegExpExecArray, line: string) => boolean, describe: string }} Rule */

// example.com, example.org and example.net, and the names reserved never to resolve (RFC 2606 and
// RFC 6761: .example, .invalid, .test, .localhost), so placeholders like a relay DSN stay usable.
const ALLOWED_EMAIL_DOMAINS =
  /(^|\.)(example\.(com|org|net)|[a-z0-9-]+\.(example|invalid|test|localhost))$/i;
const NIL_UUIDS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
]);
const CIDR_SUFFIX = /^\/\d{1,3}(?![\d.])/;

/** @type {Rule[]} */
export const RULES = [
  {
    name: "email-address",
    describe:
      "an email address outside example.com, example.org, example.net and the reserved test names",
    pattern: /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g,
    allow: (match) => ALLOWED_EMAIL_DOMAINS.test(match[1] ?? ""),
  },
  {
    name: "account-id",
    describe: "a 32-character hex string, the shape of an account or zone ID",
    pattern: /(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])/g,
  },
  {
    name: "tunnel-id",
    describe: "a UUID, the shape of a tunnel, project, service or environment ID",
    pattern:
      /(?<![0-9A-Za-z-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z-])/gi,
    allow: (match) => NIL_UUIDS.has(match[0].toLowerCase()),
  },
  {
    name: "token",
    describe: "a token, key or credential shape",
    pattern: new RegExp(
      [
        /\bfin_(?:test|live)_[A-Za-z0-9]{16,}/,
        /\bcf[a-z]t_[A-Za-z0-9_-]{20,}/,
        /\bwhsec_[A-Za-z0-9+/=]{16,}/,
        /AGE-SECRET-KEY-1[0-9A-Z]{20,}/,
        /\beyJhIjoi[A-Za-z0-9+/=_-]{20,}/, // a Cloudflare tunnel token: base64 of {"a":"
        /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // a JWT
        /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/,
        /\bgithub_pat_[A-Za-z0-9_]{40,}/,
        /\bnpm_[A-Za-z0-9]{36}\b/,
        /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
        /\bAKIA[0-9A-Z]{16}\b/,
        /\bsk-ant-[A-Za-z0-9_-]{20,}/,
        /betterstack(?:data)?\.com\/api\/v\d\/heartbeat\/[A-Za-z0-9]{8,}/,
        /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/,
        /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
        /:\/\/[^\s/:@[\]<>{}]+:[^\s/@[\]<>{}*$]{8,}@[^\s/]+/, // credentials inside a URL (not [placeholders])
      ]
        .map((r) => r.source)
        .join("|"),
      "g",
    ),
  },
  {
    name: "private-ip",
    describe: "a private, shared or unique-local IP address",
    pattern: new RegExp(
      [
        /(?<![\d.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}(?![\d.]*\d)/,
        /(?<![0-9A-Za-z:])f[cd][0-9a-f]{2}:(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4}(?![0-9A-Za-z:])/,
      ]
        .map((r) => r.source)
        .join("|"),
      "gi",
    ),
    // A CIDR range (10.0.0.0/8) is a rule about addresses, not an address.
    allow: (match, line) => CIDR_SUFFIX.test(line.slice(match.index + match[0].length)),
  },
  {
    name: "claude-artifact",
    describe: "a claude.ai artifact identifier",
    pattern: /claude\.ai\/(?:code\/)?artifacts?\/[A-Za-z0-9_-]{6,}/gi,
  },
];

/**
 * Reads the overlay's refuse list from FIN_OVERLAY_FILE. Throws an Error whose message never
 * includes the file's contents.
 * @param {string | undefined} path
 * @returns {string[]}
 */
export function loadRefuseList(path) {
  if (path === undefined || path === "") return [];
  if (!existsSync(path)) throw new Error("FIN_OVERLAY_FILE names a file that does not exist");
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("FIN_OVERLAY_FILE is not valid JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.refuseList)) {
    throw new Error('FIN_OVERLAY_FILE must hold an object with a "refuseList" array');
  }
  return parsed.refuseList.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length < 3) {
      throw new Error(`refuse list entry #${index + 1} must be a string of at least 3 characters`);
    }
    return entry.trim();
  });
}

/**
 * Builds the matcher for the refuse list: case-insensitive substrings, and for a 40-character
 * commit SHA any hex token of 7 or more characters that starts it.
 * @param {string[]} refuseList
 * @returns {(line: string) => number[]} the 1-based entry numbers found on the line
 */
export function refuseMatcher(refuseList) {
  const lowered = refuseList.map((entry) => entry.toLowerCase());
  const shas = lowered.map((entry) => (/^[0-9a-f]{40}$/.test(entry) ? entry : undefined));
  return (line) => {
    const text = line.toLowerCase();
    /** @type {number[]} */
    const hits = [];
    for (const [index, entry] of lowered.entries()) {
      if (text.includes(entry)) {
        hits.push(index + 1);
        continue;
      }
      const sha = shas[index];
      if (sha === undefined) continue;
      for (const token of text.matchAll(/(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/g)) {
        if (sha.startsWith(token[0])) {
          hits.push(index + 1);
          break;
        }
      }
    }
    return hits;
  };
}

/**
 * Scans text and returns findings. The finding names the rule, never the value.
 * @param {string} label where the text came from
 * @param {string} text
 * @param {(line: string) => number[]} refused
 * @param {{ binary?: boolean, rules?: Rule[] }} [options]
 * @returns {Finding[]}
 */
export function scanText(label, text, refused, options = {}) {
  /** @type {Finding[]} */
  const findings = [];
  const rules = options.binary ? [] : (options.rules ?? RULES);
  for (const [index, line] of text.split("\n").entries()) {
    const at = { file: label, line: index + 1 };
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      for (const match of line.matchAll(rule.pattern)) {
        if (rule.allow?.(match, line)) continue;
        findings.push({ ...at, rule: rule.name, message: rule.describe });
        break;
      }
    }
    for (const entry of refused(line)) {
      findings.push({
        ...at,
        rule: "refuse-list",
        message: `matches the overlay's refuse list entry #${entry}`,
      });
    }
  }
  return findings;
}

/**
 * Scans a path (as text with no line number).
 * @param {string} path
 * @param {(line: string) => number[]} refused
 * @returns {Finding[]}
 */
function scanPath(path, refused) {
  return scanText(path, path, refused).map(({ file, rule, message }) => ({
    file,
    rule,
    message: `${message} (in the file's path)`,
  }));
}

/**
 * Scans the tracked files of the working tree.
 * @param {string} root
 * @param {string[]} refuseList
 * @returns {Finding[]}
 */
export function scanTree(root, refuseList) {
  const refused = refuseMatcher(refuseList);
  /** @type {Finding[]} */
  const findings = [];
  for (const file of listFiles(root)) {
    findings.push(...scanPath(file, refused));
    const bytes = readFileSync(join(root, file));
    const binary = isBinary(bytes);
    findings.push(
      ...scanText(file, bytes.toString(binary ? "latin1" : "utf8"), refused, { binary }),
    );
  }
  return findings;
}

// Commit trailers carry noreply addresses by design (for example a Co-Authored-By line).
const MESSAGE_RULES = RULES.map((rule) =>
  rule.name === "email-address"
    ? {
        ...rule,
        allow: (/** @type {RegExpExecArray} */ match) =>
          ALLOWED_EMAIL_DOMAINS.test(match[1] ?? "") ||
          /^noreply@/i.test(match[0]) ||
          /users\.noreply\.github\.com$/i.test(match[1] ?? ""),
      }
    : rule,
);

/**
 * Scans what pushing these commits would publish: each message and each added or changed file.
 * @param {string} root
 * @param {string[]} commits full SHAs
 * @param {string[]} refuseList
 * @returns {Finding[]}
 */
export function scanCommits(root, commits, refuseList) {
  const refused = refuseMatcher(refuseList);
  /** @type {Finding[]} */
  const findings = [];
  for (const commit of commits) {
    const short = commit.slice(0, 12);
    const message = git(root, ["log", "-1", "--format=%B", commit]);
    findings.push(
      ...scanText(`commit ${short} (message)`, message, refused, { rules: MESSAGE_RULES }),
    );
    const changed = git(root, [
      "diff-tree",
      "--root",
      "-r",
      "-z",
      "--no-commit-id",
      "--name-only",
      "--diff-filter=ACMRT",
      commit,
    ])
      .split("\0")
      .filter(Boolean);
    for (const file of changed) {
      const label = `${file} (commit ${short})`;
      findings.push(...scanPath(label, refused));
      const bytes = gitBytes(root, ["cat-file", "blob", `${commit}:${file}`]);
      const binary = isBinary(bytes);
      findings.push(
        ...scanText(label, bytes.toString(binary ? "latin1" : "utf8"), refused, { binary }),
      );
    }
  }
  return findings;
}

/**
 * @param {string[]} argv
 * @returns {{ root: string, commits?: string[], range?: string }}
 */
function parseArgs(argv) {
  /** @type {{ root: string, commits?: string[], range?: string }} */
  const args = { root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === "--root" || flag === "--commits" || flag === "--range") && value === undefined) {
      throw new Error(`${flag} needs a value`);
    }
    if (flag === "--root") args.root = String(value);
    else if (flag === "--commits") args.commits = String(value).split(",").filter(Boolean);
    else if (flag === "--range") args.range = String(value);
    else throw new Error(`unknown argument ${flag}`);
    i++;
  }
  return args;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const refuseList = loadRefuseList(process.env.FIN_OVERLAY_FILE);
    let commits = args.commits;
    if (args.range !== undefined) {
      commits = git(args.root, ["rev-list", args.range, "--"]).split("\n").filter(Boolean);
    }
    const findings =
      commits === undefined
        ? scanTree(args.root, refuseList)
        : scanCommits(args.root, commits, refuseList);
    const scope = commits === undefined ? "tracked files" : `${commits.length} commit(s)`;
    const overlay =
      refuseList.length > 0 ? `, with the overlay's ${refuseList.length} refuse list entries` : "";
    console.log(`public-safety: scanning ${scope}${overlay}`);
    process.exitCode = report("public-safety", findings);
  } catch (error) {
    console.error(`public-safety: ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 2;
  }
}
