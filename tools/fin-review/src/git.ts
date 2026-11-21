// The git calls the engine makes, each through runProgram with validated arguments, and the
// parsers for their NUL-separated output (so names with spaces, quotes or newlines survive).

import { runProgram } from "./exec.ts";
import { ProgramError } from "./errors.ts";

export const SHA_RE = /^[0-9a-f]{40}$/;
export const ZERO_SHA = "0000000000000000000000000000000000000000";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const STATUS_RE = /^([ACDMRTUXB])([0-9]{0,3})$/;
const MODE_RE = /^[0-7]{6}$/;

export function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA_RE.test(value);
}

function assertSha(value: string, what: string): void {
  if (!isSha(value)) throw new TypeError(`${what} must be a 40-character lower-case SHA`);
}

/**
 * The environment git runs with: the caller's, less every GIT_* variable (which could point it at
 * another repository, object store, config or external diff), with prompts off and the C locale.
 */
export function gitEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name.toUpperCase().startsWith("GIT_")) continue;
    out[name] = value;
  }
  out["GIT_TERMINAL_PROMPT"] = "0";
  out["GIT_OPTIONAL_LOCKS"] = "0";
  out["LC_ALL"] = "C";
  return out;
}

/** Arguments every git call starts with: no replace refs, no fsmonitor hook, no pager. */
const GIT_PREFIX: readonly string[] = ["--no-replace-objects", "--no-pager", "-c", "core.fsmonitor=false"];

async function git(cwd: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>, input?: Uint8Array): Promise<Buffer> {
  const result = await runProgram("git", [...GIT_PREFIX, ...args], {
    cwd,
    env: gitEnv(env),
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    ...(input === undefined ? {} : { input }),
  });
  if (result.code !== 0) {
    const stderr = result.stderr.toString("utf8");
    const first = stderr.split("\n").find((line) => line.trim() !== "") ?? "";
    throw new ProgramError(
      "git",
      `git ${args[0] ?? ""} failed (${result.code === null ? `signal ${result.signal ?? "?"}` : `exit ${result.code}`})${first === "" ? "" : `: ${first}`}`,
      result.code,
      stderr,
    );
  }
  return result.stdout;
}

// ---- git diff --name-status -z -M50 ---------------------------------------------------------

export interface DiffEntry {
  /** A, C, D, M, R or T (and U, X or B, which git prints only in unusual states). */
  readonly status: string;
  /** The similarity score of a rename or copy; null otherwise. */
  readonly score: number | null;
  /** The path at head; for a deletion, the deleted path. */
  readonly path: string;
  /** The path at base of a rename or copy; null otherwise. */
  readonly oldPath: string | null;
}

/** Parses `git diff --name-status -z` output. Throws TypeError on output it does not recognise. */
export function parseNameStatusZ(output: Uint8Array): DiffEntry[] {
  const text = Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString("utf8");
  if (text === "") return [];
  if (!text.endsWith("\0")) throw new TypeError("git diff -z output does not end with NUL");
  const tokens = text.slice(0, -1).split("\0");
  const out: DiffEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const statusToken = tokens[i++] ?? "";
    const match = STATUS_RE.exec(statusToken);
    if (match === null) throw new TypeError(`unrecognised git diff status ${JSON.stringify(statusToken)}`);
    const letter = match[1] ?? "";
    const score = match[2] === undefined || match[2] === "" ? null : Number(match[2]);
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      if (oldPath === undefined || path === undefined || oldPath === "" || path === "") {
        throw new TypeError("git diff output ends inside a rename or copy");
      }
      out.push({ status: letter, score, path, oldPath });
    } else {
      const path = tokens[i++];
      if (path === undefined || path === "") throw new TypeError("git diff output ends inside an entry");
      out.push({ status: letter, score: null, path, oldPath: null });
    }
  }
  return out;
}

/** The merge-base diff `base...head` (spec 07 §2.3.1 step 1). */
export async function diffNameStatus(
  cwd: string,
  base: string,
  head: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<DiffEntry[]> {
  assertSha(base, "base");
  assertSha(head, "head");
  const out = await git(
    cwd,
    ["diff", "--name-status", "-z", "-M50", "--no-color", "--no-ext-diff", "--no-relative", `${base}...${head}`, "--"],
    env,
  );
  return parseNameStatusZ(out);
}

// ---- git ls-tree -r -z ----------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  readonly path: string;
}

/** Parses `git ls-tree -r -z` output (`<mode> SP <type> SP <oid> TAB <path> NUL`). */
export function parseLsTreeZ(output: Uint8Array): TreeEntry[] {
  const text = Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString("utf8");
  if (text === "") return [];
  if (!text.endsWith("\0")) throw new TypeError("git ls-tree -z output does not end with NUL");
  const out: TreeEntry[] = [];
  for (const record of text.slice(0, -1).split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new TypeError("unrecognised git ls-tree record");
    const [mode, type, oid, extra] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (mode === undefined || type === undefined || oid === undefined || extra !== undefined || !MODE_RE.test(mode) || !isSha(oid) || path === "") {
      throw new TypeError("unrecognised git ls-tree record");
    }
    out.push({ mode, type, oid, path });
  }
  return out;
}

/** Every entry of the tree at `sha`, recursively, from the repository root. */
export async function lsTree(cwd: string, sha: string, env: Readonly<Record<string, string | undefined>>): Promise<TreeEntry[]> {
  assertSha(sha, "tree revision");
  return parseLsTreeZ(await git(cwd, ["ls-tree", "-r", "-z", "--full-tree", sha], env));
}

// ---- git cat-file --batch / --batch-check ---------------------------------------------------

/** Which of `shas` name a commit in the repository at `cwd`. */
export async function existingCommits(
  cwd: string,
  shas: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<Set<string>> {
  for (const sha of shas) assertSha(sha, "commit");
  if (shas.length === 0) return new Set();
  const input = Buffer.from(shas.map((sha) => `${sha}^{commit}\n`).join(""), "utf8");
  const out = (await git(cwd, ["cat-file", "--batch-check"], env, input)).toString("utf8");
  const lines = out.split("\n");
  const found = new Set<string>();
  shas.forEach((sha, index) => {
    const line = lines[index] ?? "";
    const [oid, type] = line.split(" ");
    if (type === "commit" && oid === sha) found.add(sha);
  });
  return found;
}

/** Parses `git cat-file --batch` output for the requested object IDs. */
export function parseCatFileBatch(output: Uint8Array, oids: readonly string[]): Map<string, Buffer> {
  const buffer = Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  const out = new Map<string, Buffer>();
  let pos = 0;
  for (const requested of oids) {
    const eol = buffer.indexOf(0x0a, pos);
    if (eol < 0) throw new TypeError("git cat-file output ends early");
    const header = buffer.subarray(pos, eol).toString("utf8");
    pos = eol + 1;
    const parts = header.split(" ");
    if (parts.length === 2 && parts[1] === "missing") continue;
    const [oid, , sizeText] = parts;
    if (parts.length !== 3 || oid !== requested || sizeText === undefined || !/^[0-9]+$/.test(sizeText)) {
      throw new TypeError("unrecognised git cat-file header");
    }
    const size = Number(sizeText);
    if (pos + size + 1 > buffer.length || buffer[pos + size] !== 0x0a) throw new TypeError("git cat-file output is truncated");
    out.set(oid, Buffer.from(buffer.subarray(pos, pos + size)));
    pos += size + 1;
  }
  return out;
}

/** The contents of each blob in `oids` (an object that is missing is left out). */
export async function readBlobs(
  cwd: string,
  oids: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<Map<string, Buffer>> {
  const unique = [...new Set(oids)];
  for (const oid of unique) assertSha(oid, "object");
  if (unique.length === 0) return new Map();
  const input = Buffer.from(unique.map((oid) => `${oid}\n`).join(""), "utf8");
  return parseCatFileBatch(await git(cwd, ["cat-file", "--batch"], env, input), unique);
}
