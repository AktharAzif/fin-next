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
//     insensitively (a 40-character commit SHA also by any prefix of 7 or more characters), on a
//     line or across lines, runs of white space and invisible or escaping characters (foldText).
// Every file is read in each way its bytes could be read, since neither a byte-order mark nor a
// clean first page says how the rest is encoded: always as UTF-8; with a NUL byte anywhere, as
// Latin-1 and again with its NUL bytes removed, which spells out UTF-16 and UTF-32 text; as
// UTF-16 in both byte orders and both alignments; and as UTF-32 by its byte-order mark. Every
// rule runs on every reading, so no encoding and no NUL byte opts a file out. A symbolic link is
// read as what git publishes for it: its target.
// A tracked file is read as git stores it in the index, which is what a commit publishes, from
// the object store, so no checkout setting (a working-tree-encoding or filter attribute, line-end
// conversion) changes what is read; the working tree's copy is read as well where it differs, so
// a change not staged yet is found before it is committed.
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
 * The entries of the index of the repository at `root`, sorted by path: each path with the mode
 * and blob of every stage it has (a path in a merge conflict has several).
 * @param {string} root
 * @returns {[string, { mode: string, blob: string }[]][]}
 */
function indexEntries(root) {
  /** @type {Map<string, { mode: string, blob: string }[]>} */
  const entries = new Map();
  for (const record of git(root, ["ls-files", "-z", "--stage"]).split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode = "", blob = ""] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    entries.set(path, [...(entries.get(path) ?? []), { mode, blob }]);
  }
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Reads blobs from the object store in one `git cat-file --batch`.
 * @param {string} root
 * @param {string[]} blobs object names
 * @returns {Map<string, Buffer>} each blob's bytes (a missing one is left out)
 */
function readBlobs(root, blobs) {
  /** @type {Map<string, Buffer>} */
  const contents = new Map();
  const wanted = [...new Set(blobs)];
  if (wanted.length === 0) return contents;
  const out = execFileSync("git", ["-C", root, "cat-file", "--batch"], {
    input: `${wanted.join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(0x0a, at);
    if (end < 0) break;
    const [name = "", type = "", size = ""] = out.subarray(at, end).toString("latin1").split(" ");
    at = end + 1;
    if (type === "missing" || !/^\d+$/.test(size)) continue;
    contents.set(name, out.subarray(at, at + Number(size)));
    at += Number(size) + 1; // the content, then a line feed
  }
  return contents;
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
 * The refuse list's matcher: called with a line, the entries found on it; its `across`, given a
 * whole text, the entries found across its lines and separators (see foldText).
 * @typedef {((line: string) => number[]) & { across?: (text: string) => { line: number, entry: number }[] }} RefuseMatcher
 */

/**
 * Builds the matcher for the refuse list: case-insensitive substrings, and for a 40-character
 * commit SHA any hex token of 7 or more characters that starts it, on each line; and each entry
 * across the whole text too, folded as foldText folds it, so a line wrap, a run of spaces, a
 * non-breaking or zero-width space, a soft hyphen, a backslash escape or a defanged dot cannot
 * hide one.
 * @param {string[]} refuseList
 * @returns {RefuseMatcher}
 */
export function refuseMatcher(refuseList) {
  const lowered = refuseList.map((entry) => entry.toLowerCase());
  const shas = lowered.map((entry) => (/^[0-9a-f]{40}$/.test(entry) ? entry : undefined));
  const folded = refuseList.map((entry) => foldText(entry, false).text.trim());
  /** @type {RefuseMatcher} */
  const matcher = (line) => {
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
  matcher.across = (text) => {
    /** @type {{ line: number, entry: number }[]} */
    const hits = [];
    if (folded.every((entry) => entry === "")) return hits;
    for (const join of [false, true]) {
      const view = foldText(text, join);
      for (const [index, entry] of folded.entries()) {
        if (entry === "") continue;
        for (let at = view.text.indexOf(entry); at >= 0; at = view.text.indexOf(entry, at + 1)) {
          hits.push({ line: view.lineAt(at), entry: index + 1 });
        }
      }
    }
    return hits;
  };
  return matcher;
}

const DEFANG_CLOSE = /** @type {Record<string, string>} */ ({ "[": "]", "(": ")", "{": "}" });
// What may start a wrapped line besides its indentation: a comment or quotation marker.
const WRAP_MARKERS = ["//", "#", "*", ">", "--", ";", "%"];
/** @type {Map<string, string>} */
const FOLDED = new Map(); // a character outside ASCII, folded: " " for white space

/**
 * Folds one character outside ASCII: decomposed, without combining marks or format characters,
 * in lower case; white space becomes one space.
 * @param {string} char
 * @returns {string}
 */
function foldChar(char) {
  let folded = FOLDED.get(char);
  if (folded === undefined) {
    folded = /\p{Cf}/u.test(char)
      ? ""
      : char
          .normalize("NFKD")
          .replace(/\p{M}/gu, "")
          .toLowerCase()
          .replace(/[\s\p{Z}]+/gu, " ");
    if (FOLDED.size < 65536) FOLDED.set(char, folded);
  }
  return folded;
}

/**
 * Folds text for the refuse list's matching across lines: each character decomposed (NFKD, so a
 * full-width or ligature form reads as its plain letters), its combining marks and the invisible
 * format characters (zero-width spaces, soft hyphens, direction marks) dropped, lower case,
 * backslashes (an escape in Markdown or a string) dropped, a defanged dot (`[.]`, `(.)`, `{.}`)
 * read as a dot, and every run of white space read as one space. A line break, with the next
 * line's indentation and a comment or quotation marker that starts it, reads as one space, or,
 * when `join` is set, as nothing (a word split by a wrap at a hyphen).
 * @param {string} text
 * @param {boolean} join
 * @returns {{ text: string, lineAt: (index: number) => number }} lineAt: the 1-based line (as
 *   the text's LF line breaks count them) that a folded character comes from
 */
export function foldText(text, join) {
  let out = "";
  let pendingSpace = false;
  /** @type {number[]} */
  const starts = [0]; // where each line after the first starts, in the folded text
  /** @param {string} char */
  const emit = (char) => {
    if (pendingSpace && out !== "") out += " ";
    pendingSpace = false;
    out += char;
  };
  /**
   * Skips the indentation, and one comment or quotation marker, that start a wrapped line.
   * @param {number} from
   * @returns {number}
   */
  const skipWrap = (from) => {
    const space = /[\t\v\f\p{Zs}\p{Cf}]*/uy;
    space.lastIndex = from;
    let i = from + (space.exec(text)?.[0].length ?? 0);
    const marker = WRAP_MARKERS.find((m) => text.startsWith(m, i));
    if (marker !== undefined) {
      space.lastIndex = i + marker.length;
      i += marker.length + (space.exec(text)?.[0].length ?? 0);
    }
    return i;
  };
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x0a || code === 0x0d || code === 0x85 || code === 0x2028 || code === 0x2029) {
      i += code === 0x0d && text.charAt(i + 1) === "\n" ? 2 : 1;
      // Trailing white space is dropped when joining; otherwise one space stands for the break.
      pendingSpace = !join && out !== "";
      if (text.charAt(i - 1) === "\n") starts.push(out.length + (pendingSpace ? 1 : 0));
      i = skipWrap(i);
    } else if (code < 0x80) {
      const char = text.charAt(i);
      i++;
      const close = DEFANG_CLOSE[char];
      if (char === "\\") continue;
      if (code === 0x09 || code === 0x0b || code === 0x0c || code === 0x20) {
        pendingSpace = out !== "";
      } else if (close !== undefined && text.charAt(i) === "." && text.charAt(i + 1) === close) {
        emit(".");
        i += 2;
      } else {
        emit(code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : char);
      }
    } else {
      const char = String.fromCodePoint(text.codePointAt(i) ?? 0);
      i += char.length;
      for (const part of foldChar(char)) {
        if (part === " ") pendingSpace = out !== "";
        else emit(part);
      }
    }
  }
  return {
    text: out,
    lineAt: (index) => {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if ((starts[mid] ?? 0) <= index) low = mid;
        else high = mid - 1;
      }
      return low + 1;
    },
  };
}

/**
 * Scans text and returns findings, in line order. The finding names the rule, never the value.
 * @param {string} label where the text came from
 * @param {string} text
 * @param {RefuseMatcher} refused
 * @param {{ rules?: Rule[] }} [options]
 * @returns {Finding[]}
 */
export function scanText(label, text, refused, options = {}) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Set<string>} */
  const refusedAt = new Set();
  /**
   * @param {number} line
   * @param {number} entry
   */
  const refuse = (line, entry) => {
    if (refusedAt.has(`${line}|${entry}`)) return;
    refusedAt.add(`${line}|${entry}`);
    findings.push({
      file: label,
      line,
      rule: "refuse-list",
      message: `matches the overlay's refuse list entry #${entry}`,
    });
  };
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
    for (const entry of refused(line)) refuse(index + 1, entry);
  }
  const across = refused.across?.(text) ?? [];
  for (const { line, entry } of across) refuse(line, entry);
  // Sorting is stable, so each line keeps its rules first and its refuse list entries after.
  return across.length === 0 ? findings : findings.sort((x, y) => (x.line ?? 0) - (y.line ?? 0));
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
 * Every reading of a file's bytes the rules scan. The bytes do not say how a reader will decode
 * them, and a byte-order mark or a clean first page proves nothing about the rest, so no single
 * reading is trusted: the bytes are always read as UTF-8 (without its byte-order mark); with a
 * NUL byte anywhere, also as Latin-1 and again with every NUL byte removed, which spells out the
 * ASCII of UTF-16 or UTF-32 text; with a NUL byte or a UTF-16 or UTF-32 byte-order mark, also as
 * UTF-16 in both byte orders from the first byte and from the second; and with a UTF-32
 * byte-order mark, as UTF-32. `texts` names the readings a person would see as the file's text
 * (UTF-8, or the NUL-stripped reading of binary content, and what a byte-order mark announces),
 * where the refuse list is also matched across lines.
 * @param {Buffer} bytes
 * @returns {{ binary: boolean, views: string[], texts: string[] }} binary when a NUL byte stands
 *   outside text that a UTF-16 or UTF-32 byte-order mark announces
 */
export function decodeContent(bytes) {
  const [a, b, c, d] = bytes;
  const utf8Mark = a === 0xef && b === 0xbb && c === 0xbf;
  const utf32le = a === 0xff && b === 0xfe && c === 0 && d === 0;
  const utf32be = a === 0 && b === 0 && c === 0xfe && d === 0xff;
  const utf16Mark = (a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff);
  const nul = bytes.includes(0);
  const binary = nul && !utf16Mark && !utf32be;
  const utf8 = bytes.subarray(utf8Mark ? 3 : 0).toString("utf8");
  const views = [utf8];
  const texts = binary ? [] : [utf8];
  if (nul) {
    const stripped = Buffer.from(bytes.filter((x) => x !== 0)).toString("latin1");
    views.push(bytes.toString("latin1"), stripped);
    if (binary) texts.push(stripped);
  }
  if (nul || utf16Mark || utf32be) {
    for (const offset of [0, 1]) {
      const rest = bytes.subarray(offset);
      views.push(utf16(rest, true), utf16(rest, false));
    }
    if (utf16Mark && !utf32le) texts.push(utf16(bytes.subarray(2), a === 0xff));
  }
  if (utf32le || utf32be) {
    const announced = utf32(bytes.subarray(4), utf32le);
    views.push(announced);
    texts.push(announced);
  }
  return { binary, views: [...new Set(views)], texts };
}

/**
 * Scans a file's bytes with every rule, in every reading of them (see decodeContent). A finding
 * that several readings share is reported once.
 * @param {string} label
 * @param {Buffer} bytes
 * @param {RefuseMatcher} refused
 * @returns {Finding[]}
 */
export function scanContent(label, bytes, refused) {
  const { binary, views, texts } = decodeContent(bytes);
  /** @type {RefuseMatcher} */
  const lineByLine = (line) => refused(line);
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Finding[]} */
  const findings = [];
  for (const view of [...new Set([...views, ...texts])]) {
    for (const finding of scanText(label, view, texts.includes(view) ? refused : lineByLine)) {
      const key = `${finding.line}|${finding.rule}|${finding.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(
        binary ? { ...finding, message: `${finding.message} (in binary content)` } : finding,
      );
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
 * Scans the tracked files: each path's content as git stores it in the index, which is what a
 * commit publishes (read from the object store, so no checkout setting such as a
 * working-tree-encoding or a filter attribute changes what is read), and the working tree's copy
 * too where it differs, so a change not staged yet is found before it is committed. A finding in
 * only one of the two copies says which. A symbolic link is read as its target, which is what git
 * stores for it; a submodule has no content here.
 * @param {string} root
 * @param {string[]} refuseList
 * @returns {Finding[]}
 */
export function scanTree(root, refuseList) {
  const refused = refuseMatcher(refuseList);
  const entries = indexEntries(root);
  const blobs = readBlobs(
    root,
    entries.flatMap(([, stages]) => stages.filter((s) => s.mode !== "160000").map((s) => s.blob)),
  );
  /** @type {Finding[]} */
  const findings = [];
  for (const [file, stages] of entries) {
    findings.push(...scanName(file, refused));
    const stored = stages.filter((s) => s.mode !== "160000"); // a submodule: no content here
    if (stored.length === 0) continue;
    /** @type {{ link: boolean, bytes: Buffer }[]} */
    const copies = stored.map((s) => ({
      link: s.mode === "120000",
      bytes: blobs.get(s.blob) ?? Buffer.alloc(0),
    }));
    if (stored.some((s) => !blobs.has(s.blob))) {
      findings.push({ file, rule: "unreadable", message: "git could not read this file's blob" });
    }
    const full = join(root, file);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    /** @type {{ link: boolean, bytes: Buffer } | undefined} */
    let working;
    if (stat?.isSymbolicLink()) working = { link: true, bytes: Buffer.from(readlinkSync(full)) };
    else if (stat?.isFile()) working = { link: false, bytes: readFileSync(full) };
    // A file deleted from the working tree but still in the index differs too.
    const differs =
      working === undefined ||
      !copies.some((c) => c.link === working.link && c.bytes.equals(working.bytes));
    /**
     * @param {{ link: boolean, bytes: Buffer }} copy
     * @returns {Finding[]}
     */
    const scan = (copy) =>
      copy.link
        ? scanText(file, copy.bytes.toString("utf8"), refused)
        : scanContent(file, copy.bytes, refused);
    const inIndex = copies.flatMap(scan);
    const inWorkingTree = differs && working !== undefined ? scan(working) : [];
    const key = (/** @type {Finding} */ f) => `${f.line}|${f.rule}|${f.message}`;
    const indexKeys = new Set(inIndex.map(key));
    const workingKeys = new Set(inWorkingTree.map(key));
    /** @type {Set<string>} */
    const seen = new Set();
    for (const finding of inIndex) {
      if (seen.has(key(finding))) continue;
      seen.add(key(finding));
      findings.push(
        differs && !workingKeys.has(key(finding))
          ? { ...finding, message: `${finding.message} (in the copy git has staged)` }
          : finding,
      );
    }
    for (const finding of inWorkingTree) {
      if (indexKeys.has(key(finding)) || seen.has(key(finding))) continue;
      seen.add(key(finding));
      findings.push({
        ...finding,
        message: `${finding.message} (in the working tree, not staged)`,
      });
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
