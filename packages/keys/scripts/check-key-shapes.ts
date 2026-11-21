// check-key-shapes (spec 05 §4.1, T05-03; ARCHITECTURE §7.7): the repository never holds a
// key-shaped string whose checksum verifies under any salt in KNOWN_SALTS, so a key copied into a
// fixture, a doc or a log excerpt is caught before it is pushed. Fixtures make keys at run time;
// examples write `fin_test_sk_...` or `$FIN_KEY`. It runs over every tracked file in
// packages/keys's unit tests (so in `pnpm check`), and by hand: `node scripts/check-key-shapes.ts`.
// A finding names the file and line, never the key.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyChecksum } from "../src/format.ts";
import { KNOWN_SALTS } from "../src/salts.ts";

const SHAPE = /fin_(?:test|live)_(?:sk|rk)_[0-9A-HJKMNP-TV-Z]{10}[0-9A-Za-z]{38}(?![0-9A-Za-z])/g;

export interface KeyFinding {
  file: string;
  line: number;
}

/** The lines of `text` holding a key whose checksum verifies under a known salt. */
export function findKeys(text: string): number[] {
  const lines: number[] = [];
  for (const match of text.matchAll(SHAPE)) {
    if (KNOWN_SALTS.some((salt) => verifyChecksum(match[0], salt))) {
      lines.push(text.slice(0, match.index).split("\n").length);
    }
  }
  return lines;
}

/** The files git tracks under `root`. */
export function trackedFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return out
    .toString("utf8")
    .split("\0")
    .filter((f) => f !== "");
}

export function checkFiles(root: string, files: readonly string[]): KeyFinding[] {
  const findings: KeyFinding[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(root, file), "latin1");
    } catch {
      continue; // A file deleted in the working tree but still tracked.
    }
    for (const line of findKeys(text)) findings.push({ file, line });
  }
  return findings;
}

if (import.meta.main) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  const findings = checkFiles(root, trackedFiles(root));
  for (const f of findings) {
    process.stderr.write(`${f.file}:${f.line}: a key with a valid checksum (T05-03)\n`);
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}
