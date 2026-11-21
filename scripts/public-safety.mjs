#!/usr/bin/env node
// public-safety (EXECUTION §2.2, §1.5 item 7; spec 01 §9). A control path. The repository is
// public, so this check refuses, in tracked files (and their paths):
//   - email addresses outside example.com, example.org and example.net (and the names reserved
//     never to resolve: .example, .invalid, .test, .localhost);
//   - strings shaped like account IDs (32 hex, either case), tunnel, project, service or
//     environment IDs (UUIDs), tokens and private keys, and private IP addresses;
//   - a local home directory path (/Users/<name>, C:\Users\<name>);
//   - claude.ai artifact identifiers;
//   - when FIN_OVERLAY_FILE names a JSON file with a "refuseList" array, each listed string, case
//     insensitively (a 40-character commit SHA also by any prefix of 7 or more characters).
// Every file is read: UTF-8, or UTF-16 and UTF-32 by their byte-order mark; a file with a NUL
// byte (binary content) is read as Latin-1 bytes and again with its NUL bytes removed, and both
// are scanned with every rule, so a NUL byte never opts a file out. A symbolic link is read as
// what git publishes for it: its target.
// It prints file:line and the rule's name, never the matched value, so its output is safe in a
// public log. With --commits or --range it scans what a push would publish instead: each commit's
// message and the full content of every file it adds or changes (for a merge, every file that
// differs from its first parent, so what the merge itself adds is read too).
//
// This file is self-contained (Node built-ins only, no import from another file of the
// repository), so every line that decides its verdict is under the control path and the owner's
// review (CI-14). For the same reason CI runs it directly, `node scripts/public-safety.mjs`, not
// through a package.json script, which is not a control path.
//
// Exit codes: 0 clean, 1 findings, 2 a usage or overlay error (the check fails closed).
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** @typedef {{ file: string, line?: number, rule: string, message: string }} Finding */
/** @typedef {{ name: string, pattern: RegExp, allow?: (match: RegExpExecArray, line: string) => boolean, describe: string }} Rule */

// --- Helpers (kept in this file: see the header) ---------------------------------------------

/**
 * Runs git in `root` and returns its standard output.
 * @param {string} root
 * @param {string[]} args
 * @returns {string}
 */
export function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Runs git in `root` and returns its standard output as bytes.
 * @param {string} root
 * @param {string[]} args
 * @returns {Buffer}
 */
function gitBytes(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Whether `value` is a plain object (not null, not an array).
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tracked entries of the repository at `root` with their git modes, as [path, mode] pairs
 * sorted by path. Entries deleted from the working tree are left out.
 * @param {string} root
 * @returns {[string, string][]}
 */
function trackedEntries(root) {
  /** @type {Map<string, string>} */
  const entries = new Map();
  for (const record of git(root, ["ls-files", "-z", "--stage"]).split("\0")) {
    const tab = record.indexOf("\t");
    if (tab >= 0) entries.set(record.slice(tab + 1), record.slice(0, record.indexOf(" ")));
  }
  return [...entries]
    .filter(([path]) => lstatSync(join(root, path), { throwIfNoEntry: false }) !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Formats a finding as `file:line rule: message`.
 * @param {Finding} finding
 * @returns {string}
 */
export function formatFinding(finding) {
  const where = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  return `${where} ${finding.rule}: ${finding.message}`;
}

// --- The rules --------------------------------------------------------------------------------

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
    pattern: /(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])/gi,
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
    name: "local-path",
    describe: "a local home directory path",
    // Case-sensitive, as the systems spell them, so a route such as /users/me is not one.
    pattern: /(?<![\w.~-])\/Users\/(?!Shared\b)[^\s/'"`<>:]+|\b[A-Za-z]:\\+Users\\+[^\s\\'"`<>:]+/g,
  },
  {
    name: "claude-artifact",
    describe: "a claude.ai artifact identifier",
    pattern: /claude\.ai\/(?:code\/)?artifacts?\/[A-Za-z0-9_-]{6,}/gi,
  },
];

// Commit trailers carry two noreply addresses by design (a Co-Authored-By line names the
// assistant's, and GitHub writes users' own as <id>+<login>@users.noreply.github.com); no other
// noreply address, which could sit on any domain, is let through.
const MESSAGE_RULES = RULES.map((rule) =>
  rule.name === "email-address"
    ? {
        ...rule,
        allow: (/** @type {RegExpExecArray} */ match) =>
          ALLOWED_EMAIL_DOMAINS.test(match[1] ?? "") ||
          /^noreply@anthropic\.com$/i.test(match[0]) ||
          /^[A-Za-z0-9._%+-]+@users\.noreply\.github\.com$/i.test(match[0]),
      }
    : rule,
);

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
 * @param {{ rules?: Rule[] }} [options]
 * @returns {Finding[]}
 */
export function scanText(label, text, refused, options = {}) {
  /** @type {Finding[]} */
  const findings = [];
  const rules = options.rules ?? RULES;
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

// --- Reading content ----------------------------------------------------------------------------

/**
 * Decodes UTF-16 code units.
 * @param {Buffer} bytes
 * @param {boolean} littleEndian
 * @returns {string}
 */
function utf16(bytes, littleEndian) {
  const even = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
  if (!littleEndian) even.swap16();
  return even.toString("utf16le");
}

/**
 * Decodes UTF-32 code units (an invalid one becomes U+FFFD).
 * @param {Buffer} bytes
 * @param {boolean} littleEndian
 * @returns {string}
 */
function utf32(bytes, littleEndian) {
  /** @type {string[]} */
  const chars = [];
  for (let i = 0; i + 4 <= bytes.length; i += 4) {
    const code = littleEndian ? bytes.readUInt32LE(i) : bytes.readUInt32BE(i);
    chars.push(code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd");
  }
  return chars.join("");
}

/**
 * Decodes a file's bytes for scanning. Text is UTF-8, or UTF-16 or UTF-32 by its byte-order mark.
 * Bytes with a NUL in their first 8 KiB (as git decides) are binary, read two ways: as Latin-1,
 * and again with every NUL byte removed, which spells out UTF-16 or UTF-32 text held inside.
 * @param {Buffer} bytes
 * @returns {{ binary: boolean, views: string[] }}
 */
export function decodeContent(bytes) {
  const [a, b, c, d] = bytes;
  if (a === 0xef && b === 0xbb && c === 0xbf) {
    return { binary: false, views: [bytes.subarray(3).toString("utf8")] };
  }
  if (a === 0xff && b === 0xfe && c === 0 && d === 0) {
    return { binary: false, views: [utf32(bytes.subarray(4), true)] };
  }
  if (a === 0 && b === 0 && c === 0xfe && d === 0xff) {
    return { binary: false, views: [utf32(bytes.subarray(4), false)] };
  }
  if (a === 0xff && b === 0xfe) return { binary: false, views: [utf16(bytes.subarray(2), true)] };
  if (a === 0xfe && b === 0xff) return { binary: false, views: [utf16(bytes.subarray(2), false)] };
  if (!bytes.subarray(0, 8192).includes(0)) {
    return { binary: false, views: [bytes.toString("utf8")] };
  }
  return {
    binary: true,
    views: [bytes.toString("latin1"), Buffer.from(bytes.filter((x) => x !== 0)).toString("latin1")],
  };
}

/**
 * Scans a file's bytes with every rule, however they are encoded.
 * @param {string} label
 * @param {Buffer} bytes
 * @param {(line: string) => number[]} refused
 * @returns {Finding[]}
 */
export function scanContent(label, bytes, refused) {
  const { binary, views } = decodeContent(bytes);
  if (!binary) return scanText(label, views[0] ?? "", refused);
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Finding[]} */
  const findings = [];
  for (const view of views) {
    for (const finding of scanText(label, view, refused)) {
      const key = `${finding.line}|${finding.rule}|${finding.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ ...finding, message: `${finding.message} (in binary content)` });
    }
  }
  return findings;
}

/**
 * Scans a path, or another name a push publishes (as text with no line number).
 * @param {string} name
 * @param {(line: string) => number[]} refused
 * @param {string} [where] how the message names what was scanned
 * @param {string} [label] where to report it, when that is not the name itself
 * @returns {Finding[]}
 */
export function scanName(name, refused, where = "in the file's path", label = name) {
  return scanText(label, name, refused).map(({ rule, message }) => ({
    file: label,
    rule,
    message: `${message} (${where})`,
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
  for (const [file, mode] of trackedEntries(root)) {
    findings.push(...scanName(file, refused));
    if (mode === "160000") continue; // a submodule: its files are not in this repository
    const full = join(root, file);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      findings.push(...scanText(file, readlinkSync(full), refused)); // git publishes the target
    } else if (stat.isFile()) {
      findings.push(...scanContent(file, readFileSync(full), refused));
    }
  }
  return findings;
}

/**
 * Scans a commit or tag message with the message rules (two noreply trailer addresses allowed).
 * @param {string} label
 * @param {string} message
 * @param {(line: string) => number[]} refused
 * @returns {Finding[]}
 */
export function scanMessage(label, message, refused) {
  return scanText(label, message, refused, { rules: MESSAGE_RULES });
}

/**
 * The files a commit adds or changes, from `git diff-tree`'s raw output: for a merge, those that
 * differ from its first parent.
 * @param {string} root
 * @param {string} commit
 * @returns {{ path: string, mode: string, blob: string }[]}
 */
function changedFiles(root, commit) {
  const parents = git(root, ["rev-list", "--parents", "-n", "1", commit])
    .trim()
    .split(" ")
    .slice(1);
  const base = ["diff-tree", "-r", "-z", "--no-renames", "--diff-filter=ACMRT"];
  const args =
    parents[0] === undefined
      ? [...base, "--root", "--no-commit-id", commit]
      : [...base, parents[0], commit];
  const fields = git(root, args).split("\0");
  /** @type {{ path: string, mode: string, blob: string }[]} */
  const changes = [];
  for (let i = 0; i < fields.length; i++) {
    const header = fields[i] ?? "";
    if (!header.startsWith(":")) continue;
    const [, mode = "", , blob = ""] = header.slice(1).split(" ");
    const path = fields[++i];
    if (path !== undefined) changes.push({ path, mode, blob });
  }
  return changes;
}

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
    findings.push(...scanMessage(`commit ${short} (message)`, message, refused));
    for (const { path, mode, blob } of changedFiles(root, commit)) {
      const label = `${path} (commit ${short})`;
      findings.push(...scanName(label, refused));
      if (mode === "160000") continue; // a submodule: no content in this repository
      const bytes = gitBytes(root, ["cat-file", "blob", blob]);
      findings.push(
        ...(mode === "120000"
          ? scanText(label, bytes.toString("utf8"), refused)
          : scanContent(label, bytes, refused)),
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
    for (const finding of findings) console.error(formatFinding(finding));
    if (findings.length > 0) console.error(`public-safety: ${findings.length} finding(s)`);
    else console.log("public-safety: ok");
    process.exitCode = findings.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`public-safety: ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 2;
  }
}
