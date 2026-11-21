// The git calls the engine makes, each through runProgram with validated arguments, and the
// parsers for their NUL-separated output (so names with spaces, quotes or newlines survive).

import { escapeText } from "./display.ts";
import { ProgramError } from "./errors.ts";
import type { RunResult } from "./exec.ts";
import { runProgram } from "./exec.ts";

export const SHA_RE = /^[0-9a-f]{40}$/;
export const ZERO_SHA = "0000000000000000000000000000000000000000";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const RAW_RECORD_RE =
  /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([ACDMRTUXB])([0-9]{0,3})$/;
const MODE_RE = /^[0-7]{6}$/;
/** A remote name the engine will place in a fetch's arguments. */
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Git's own way to say "do not fetch a missing object from a promisor remote" (git 2.44+). */
const NO_LAZY_FETCH: Readonly<Record<string, string>> = { GIT_NO_LAZY_FETCH: "1" };

export const SYMLINK_MODE = "120000";
export const GITLINK_MODE = "160000";

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
const GIT_PREFIX: readonly string[] = [
  "--no-replace-objects",
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
];

interface GitCall {
  /** Bytes for git's stdin. */
  readonly input?: Uint8Array;
  /** `name=value` settings passed with -c before the subcommand. */
  readonly config?: readonly string[];
  /** GIT_* variables the engine sets for this call (the caller's are always dropped). */
  readonly gitVariables?: Readonly<Record<string, string>>;
}

async function gitRun(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  call: GitCall = {},
): Promise<RunResult> {
  const config = (call.config ?? []).flatMap((setting) => ["-c", setting]);
  return runProgram("git", [...GIT_PREFIX, ...config, ...args], {
    cwd,
    env: { ...gitEnv(env), ...(call.gitVariables ?? {}) },
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    ...(call.input === undefined ? {} : { input: call.input }),
  });
}

function gitFailure(args: readonly string[], result: RunResult): ProgramError {
  const stderr = result.stderr.toString("utf8");
  const first = stderr.split("\n").find((line) => line.trim() !== "") ?? "";
  const status = result.code === null ? `signal ${result.signal ?? "?"}` : `exit ${result.code}`;
  return new ProgramError(
    "git",
    `git ${args[0] ?? ""} failed (${status})${first === "" ? "" : `: ${escapeText(first)}`}`,
    result.code,
    stderr,
  );
}

async function git(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  call: GitCall = {},
): Promise<Buffer> {
  const result = await gitRun(cwd, args, env, call);
  if (result.code !== 0) throw gitFailure(args, result);
  return result.stdout;
}

// ---- git merge-base --all ------------------------------------------------------------------

/**
 * Every merge base of `base` and `head`: one for an ordinary history, none for unrelated
 * histories, several after criss-cross merges.
 */
export async function mergeBases(
  cwd: string,
  base: string,
  head: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  assertSha(base, "base");
  assertSha(head, "head");
  const args = ["merge-base", "--all", base, head];
  const result = await gitRun(cwd, args, env);
  const lines = result.stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "");
  // Exit 1 with no output is "no merge base"; anything else but exit 0 is a failure.
  if (result.code === 1 && lines.length === 0) return [];
  if (result.code !== 0) throw gitFailure(args, result);
  for (const line of lines)
    if (!isSha(line)) throw new TypeError("unrecognised git merge-base output");
  return [...new Set(lines)];
}

// ---- git diff --raw -z ------------------------------------------------------------------------

export interface DiffEntry {
  /** A, C, D, M, R or T (and U, X or B, which git prints only in unusual states). */
  readonly status: string;
  /** The similarity score of a rename or copy; null otherwise. */
  readonly score: number | null;
  /** The path at head; for a deletion, the deleted path. */
  readonly path: string;
  /** The path at base of a rename or copy; null otherwise. */
  readonly oldPath: string | null;
  /** The entry's mode on each side; 000000 where it is absent. */
  readonly oldMode: string;
  readonly newMode: string;
}

/** Parses `git diff --raw -z --no-abbrev` output. Throws TypeError on output it does not recognise. */
export function parseRawDiffZ(output: Uint8Array): DiffEntry[] {
  const text = Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString("utf8");
  if (text === "") return [];
  if (!text.endsWith("\0")) throw new TypeError("git diff -z output does not end with NUL");
  const tokens = text.slice(0, -1).split("\0");
  const out: DiffEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i++] ?? "";
    const match = RAW_RECORD_RE.exec(record);
    if (match === null)
      throw new TypeError(`unrecognised git diff record "${escapeText(record, 120)}"`);
    const oldMode = match[1] ?? "";
    const newMode = match[2] ?? "";
    const letter = match[5] ?? "";
    const score = match[6] === undefined || match[6] === "" ? null : Number(match[6]);
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      if (oldPath === undefined || path === undefined || oldPath === "" || path === "") {
        throw new TypeError("git diff output ends inside a rename or copy");
      }
      out.push({ status: letter, score, path, oldPath, oldMode, newMode });
    } else {
      if (score !== null)
        throw new TypeError("git diff gave a score to an entry that is not a rename or copy");
      const path = tokens[i++];
      if (path === undefined || path === "")
        throw new TypeError("git diff output ends inside an entry");
      out.push({ status: letter, score: null, path, oldPath: null, oldMode, newMode });
    }
  }
  return out;
}

/**
 * The diff from commit `from` to commit `head` (spec 07 §2.3.1 step 1, with `from` the merge
 * base), with renames and copies at 50% similarity and each side's mode. Submodule changes are
 * never hidden, whatever a .gitmodules file or the configuration says.
 */
export async function diffRaw(
  cwd: string,
  from: string,
  head: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<DiffEntry[]> {
  assertSha(from, "diff base");
  assertSha(head, "head");
  const out = await git(
    cwd,
    [
      "diff",
      "--raw",
      "-z",
      "--no-abbrev",
      "-M50",
      "--no-color",
      "--no-ext-diff",
      "--no-relative",
      "--ignore-submodules=none",
      from,
      head,
      "--",
    ],
    env,
  );
  return parseRawDiffZ(out);
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
    if (
      mode === undefined ||
      type === undefined ||
      oid === undefined ||
      extra !== undefined ||
      !MODE_RE.test(mode) ||
      !isSha(oid) ||
      path === ""
    ) {
      throw new TypeError("unrecognised git ls-tree record");
    }
    out.push({ mode, type, oid, path });
  }
  return out;
}

/** Every entry of the tree at `sha`, recursively, from the repository root. */
export async function lsTree(
  cwd: string,
  sha: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<TreeEntry[]> {
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
  const out = (await git(cwd, ["cat-file", "--batch-check"], env, { input })).toString("utf8");
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
export function parseCatFileBatch(
  output: Uint8Array,
  oids: readonly string[],
): Map<string, Buffer> {
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
    if (
      parts.length !== 3 ||
      oid !== requested ||
      sizeText === undefined ||
      !/^[0-9]+$/.test(sizeText)
    ) {
      throw new TypeError("unrecognised git cat-file header");
    }
    const size = Number(sizeText);
    if (pos + size + 1 > buffer.length || buffer[pos + size] !== 0x0a)
      throw new TypeError("git cat-file output is truncated");
    out.set(oid, Buffer.from(buffer.subarray(pos, pos + size)));
    pos += size + 1;
  }
  return out;
}

/**
 * The remote a partial clone fetches missing objects from (the one git's own lazy fetch uses),
 * or null when the repository is not a partial clone.
 */
export async function promisorRemote(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  // Exit 1 is "not set". Any other failure leaves the question open, and the caller then reads
  // only what is present: a missing object makes the plan run everything.
  const named = await gitRun(cwd, ["config", "--get", "extensions.partialclone"], env);
  if (named.code === 0) {
    const name = named.stdout.toString("utf8").replace(/\n$/, "");
    if (REMOTE_RE.test(name)) return name;
  }
  const listed = await gitRun(
    cwd,
    ["config", "--type=bool", "--get-regexp", "^remote\\..+\\.promisor$"],
    env,
  );
  if (listed.code !== 0) return null;
  for (const line of listed.stdout.toString("utf8").split("\n")) {
    const match = /^remote\.(.+)\.promisor true$/.exec(line);
    const name = match?.[1];
    if (name !== undefined && REMOTE_RE.test(name)) return name;
  }
  return null;
}

export interface BlobRead {
  /** Each blob that could be read, by object ID; a missing one is left out. */
  readonly blobs: Map<string, Buffer>;
  /** What went wrong fetching missing objects, for the caller to report. */
  readonly problems: readonly string[];
}

/**
 * The contents of each blob in `oids`. In a partial clone (CI's blobless checkout), the blobs the
 * checkout lacks are fetched from the promisor remote in one request, never one round trip each.
 */
export async function readBlobs(
  cwd: string,
  oids: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<BlobRead> {
  const unique = [...new Set(oids)];
  for (const oid of unique) assertSha(oid, "object");
  if (unique.length === 0) return { blobs: new Map(), problems: [] };
  const lines = (list: readonly string[]): Buffer =>
    Buffer.from(list.map((oid) => `${oid}\n`).join(""), "utf8");
  const batch = async (list: readonly string[]): Promise<Map<string, Buffer>> =>
    parseCatFileBatch(
      await git(cwd, ["cat-file", "--batch"], env, {
        input: lines(list),
        gitVariables: NO_LAZY_FETCH,
      }),
      list,
    );

  const blobs = await batch(unique);
  const missing = unique.filter((oid) => !blobs.has(oid));
  if (missing.length === 0) return { blobs, problems: [] };
  const remote = await promisorRemote(cwd, env);
  if (remote === null) return { blobs, problems: [] };
  try {
    await git(
      cwd,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--no-auto-maintenance",
        "--filter=blob:none",
        "--stdin",
        remote,
      ],
      env,
      { input: lines(missing), config: ["fetch.negotiationAlgorithm=noop"] },
    );
  } catch (error) {
    if (!(error instanceof ProgramError)) throw error;
    return {
      blobs,
      problems: [
        `could not fetch ${missing.length} missing objects from the promisor remote: ${error.message}`,
      ],
    };
  }
  for (const [oid, bytes] of await batch(missing)) blobs.set(oid, bytes);
  return { blobs, problems: [] };
}
