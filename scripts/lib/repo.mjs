// Shared helpers for the repository checks in scripts/. Node built-ins only: the checks must run
// on a clean checkout before anything is installed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
export function gitBytes(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * The repository's files, as paths relative to `root` with forward slashes. Tracked files only by
 * default; with `untracked`, also files that are new and not ignored (so a check catches a new
 * file before it is added). Files deleted from the working tree are left out.
 * @param {string} root
 * @param {{ untracked?: boolean }} [options]
 * @returns {string[]}
 */
export function listFiles(root, options = {}) {
  const args = ["ls-files", "-z", "--cached"];
  if (options.untracked) args.push("--others", "--exclude-standard");
  const files = new Set(git(root, args).split("\0").filter(Boolean));
  return [...files].filter((file) => existsSync(join(root, file))).sort();
}

/**
 * Whether bytes look binary (a NUL byte in the first 8 KiB, as git decides).
 * @param {Buffer} bytes
 * @returns {boolean}
 */
export function isBinary(bytes) {
  return bytes.subarray(0, 8192).includes(0);
}

/**
 * Reads and parses a JSON file.
 * @param {string} file
 * @returns {unknown}
 */
export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Whether `value` is a plain object (not null, not an array).
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts a simple glob to a regular expression for a whole path: `**` matches any number of
 * path segments, `*` anything inside one segment, `?` one character inside a segment.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$+.()|[\]{}]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Whether a repository path is covered by a control path as `tools/layout.json` writes them: a
 * trailing `/` covers everything under that directory, a `*` matches inside one segment, and
 * anything else is one exact file.
 * @param {string} file
 * @param {string} controlPath
 * @returns {boolean}
 */
export function coveredBy(file, controlPath) {
  if (controlPath.endsWith("/")) {
    const dir = controlPath.slice(0, -1);
    if (dir.includes("*")) return globToRegExp(`${dir}/**`).test(file);
    return file.startsWith(controlPath);
  }
  if (controlPath.includes("*")) return globToRegExp(controlPath).test(file);
  return file === controlPath;
}

/**
 * A finding: where, which rule, and a message that never repeats a matched value.
 * @typedef {{ file: string, line?: number, rule: string, message: string }} Finding
 */

/**
 * Formats a finding as `file:line rule: message`.
 * @param {Finding} finding
 * @returns {string}
 */
export function formatFinding(finding) {
  const where = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  return `${where} ${finding.rule}: ${finding.message}`;
}

/**
 * Prints findings and warnings, and returns the exit code: 0 with no findings, 1 otherwise.
 * @param {string} name the check's name, for the summary line
 * @param {Finding[]} findings
 * @param {Finding[]} [warnings]
 * @returns {number}
 */
export function report(name, findings, warnings = []) {
  for (const warning of warnings) console.warn(`warning: ${formatFinding(warning)}`);
  for (const finding of findings) console.error(formatFinding(finding));
  if (findings.length > 0) {
    console.error(`${name}: ${findings.length} finding(s)`);
    return 1;
  }
  console.log(`${name}: ok${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ""}`);
  return 0;
}
