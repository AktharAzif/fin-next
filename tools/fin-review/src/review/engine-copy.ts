// The engine copy (spec 07 §0.3): every gating review runs the default branch's engine over the pull
// request's tree as data, so a pull request is never reviewed by its own procedure. The checkout the
// engine runs from must hold, under tools/fin-review, docs/review, AGENTS.md and CONTRIBUTING.md,
// exactly what the default branch holds there; otherwise a gating run is refused and only an
// advisory one goes ahead.
//
// What is checked is what the engine runs, not git's view of it: git's index can be told not to
// look at a file (assume-unchanged, skip-worktree), and a stat setting or a clean filter can hide an
// edit from `git status`. So besides a clean `git status` and the trees at HEAD equal to the default
// branch's, the check walks the files on the disk, hashes each as a git blob (with no git, filter or
// configuration involved) and compares them with the entries of HEAD; refuses any index entry git
// would not compare with the disk; and compares the bytes the engine actually loaded (its config and
// its procedure, EngineConfig.sources and Procedure.sources) with HEAD's, so a file changed and
// changed back between load and check is found too. The rules files the rules lens reads are taken
// from the same verified bytes. The engine's own modules are verified on the disk only: what Node
// loaded at start cannot be hashed from inside it.
//
// Every run records the engine's commit and the procedure hash of §4.8: the SHA-256 of the sorted
// `<path> <blob id>` lines of every file under docs/review/ and tools/fin-review/config/, computed
// from the disk's bytes (equal to the commit's when the check passes), which a `commit` run compares
// with its prior run's.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { escapeText } from "../display.ts";
import { canonicalPath } from "../exec.ts";
import { gitBlobId } from "../git.ts";
import type { TreeEntry } from "../git.ts";
import { checkoutState, entriesUnder, indexFlags, objectAt } from "./repo.ts";

/** What the engine reads from its own checkout: the code, the procedure and the rules files. */
export const ENGINE_PATHS: readonly string[] = ["tools/fin-review", "docs/review", "AGENTS.md", "CONTRIBUTING.md"];
/** The paths a default branch must hold for it to have an engine copy at all. */
const REQUIRED_PATHS: ReadonlySet<string> = new Set(["tools/fin-review", "docs/review"]);
/** What the procedure hash covers (spec 07 §4.8). */
export const PROCEDURE_PATHS: readonly string[] = ["docs/review", "tools/fin-review/config"];
/** The rules files the rules lens reads, from the verified bytes. */
export const RULES_FILES: readonly string[] = ["AGENTS.md", "CONTRIBUTING.md"];
const MAX_LISTED = 10;
const MAX_RULES_BYTES = 1 << 20;
const SYMLINK_MODE = "120000";

export interface EngineCopy {
  /** The engine checkout's commit, or null when it is not a git checkout. */
  readonly commit: string | null;
  /** The procedure hash of the files on the disk, or null. */
  readonly procedureHash: string | null;
  /** Why the engine is not the default branch's engine copy; empty when it is. */
  readonly problems: readonly string[];
  /** The rules files as the check read and hashed them; absent when it did not read them. */
  readonly rulesFiles?: ReadonlyArray<{ readonly path: string; readonly text: string }>;
}

export interface EngineCopyInput {
  readonly mirror: string;
  readonly defaultBranch: string;
  readonly defaultTip: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The blob ID of the bytes the engine loaded, by repository path (EngineConfig.sources, Procedure.sources). */
  readonly loaded?: ReadonlyMap<string, string>;
}

/** The procedure hash of `[path, blob id]` lines (spec 07 §4.8). */
export function procedureHash(files: ReadonlyArray<readonly [string, string]>): string {
  const lines = files.map(([path, oid]) => `${path} ${oid}`).sort();
  return createHash("sha256").update(`${lines.join("\n")}\n`, "utf8").digest("hex");
}

interface DiskEntry {
  readonly oid: string;
  readonly link: boolean;
  /** A file's bytes, kept for the rules files only. */
  readonly bytes?: Buffer;
}

/**
 * Every file and link under `paths` of `root` on the disk, as git would store it (a link's blob
 * is its target), and what could not be read. Links are not followed.
 */
export function diskEntries(root: string, paths: readonly string[]): { entries: Map<string, DiskEntry>; problems: string[] } {
  const entries = new Map<string, DiskEntry>();
  const problems: string[] = [];
  const visit = (rel: string): void => {
    const abs = join(root, rel);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") problems.push(`${rel} cannot be read (${String(code ?? "error")})`);
      return;
    }
    try {
      if (stat.isSymbolicLink()) entries.set(rel, { oid: gitBlobId(readlinkSync(abs, { encoding: "buffer" })), link: true });
      else if (stat.isFile()) {
        const bytes = readFileSync(abs);
        entries.set(rel, { oid: gitBlobId(bytes), link: false, ...(RULES_FILES.includes(rel) ? { bytes } : {}) });
      } else if (stat.isDirectory()) for (const name of readdirSync(abs).sort()) visit(`${rel}/${name}`);
      else problems.push(`${rel} is neither a file, a link nor a folder`);
    } catch (error) {
      problems.push(`${rel} cannot be read (${String((error as NodeJS.ErrnoException).code ?? "error")})`);
    }
  };
  for (const path of paths) visit(path);
  return { entries, problems };
}

function listed(paths: readonly string[]): string {
  const shown = paths
    .slice(0, MAX_LISTED)
    .map((path) => escapeText(path, 200))
    .join(", ");
  return `${shown}${paths.length > MAX_LISTED ? ", ..." : ""}`;
}

/** The paths where the disk and the commit's entries differ: content, kind, or presence. */
function differences(disk: ReadonlyMap<string, DiskEntry>, tree: readonly TreeEntry[]): string[] {
  const out = new Set<string>();
  const inTree = new Map(tree.map((entry) => [entry.path, entry]));
  for (const [path, entry] of inTree) {
    const found = disk.get(path);
    if (entry.type !== "blob" || found === undefined || found.oid !== entry.oid || found.link !== (entry.mode === SYMLINK_MODE)) out.add(path);
  }
  for (const path of disk.keys()) if (!inTree.has(path)) out.add(path);
  return [...out].sort();
}

/** Checks the engine checkout at `engineRoot` against the default branch's tip in the mirror. */
export async function checkEngineCopy(engineRoot: string, input: EngineCopyInput): Promise<EngineCopy> {
  const state = await checkoutState(engineRoot, ENGINE_PATHS, input.env);
  if (state === null) return { commit: null, procedureHash: null, problems: ["the engine does not run from a git checkout"] };
  const problems: string[] = [];
  if (canonicalPath(state.top) !== canonicalPath(engineRoot)) problems.push("the engine's folder is not the top of its git checkout");
  if (state.changed.length > 0) problems.push(`the engine checkout has changes under ${ENGINE_PATHS.join(", ")}: ${listed(state.changed)}`);
  const flagged = await indexFlags(engineRoot, ENGINE_PATHS, input.env);
  if (flagged.length > 0) problems.push(`git is told not to compare these engine files with the disk (assume-unchanged or skip-worktree): ${listed(flagged)}`);
  for (const path of ENGINE_PATHS) {
    const ours = await objectAt(engineRoot, state.head, path, input.env);
    const theirs = await objectAt(input.mirror, input.defaultTip, path, input.env);
    if (theirs === null && REQUIRED_PATHS.has(path)) problems.push(`${input.defaultBranch} has no ${path}, so there is no engine copy to run`);
    else if (ours !== theirs) problems.push(`${path} at the engine's commit differs from ${input.defaultBranch}'s`);
  }

  // The bytes on the disk against the commit's entries.
  const tree = await entriesUnder(engineRoot, state.head, ENGINE_PATHS, input.env);
  const disk = diskEntries(engineRoot, ENGINE_PATHS);
  problems.push(...disk.problems);
  const differ = differences(disk.entries, tree);
  if (differ.length > 0) problems.push(`the engine's files on the disk differ from its commit: ${listed(differ)}`);

  // The bytes the engine loaded against the commit's.
  const blobs = new Map(tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry.oid]));
  const stale = [...(input.loaded ?? new Map<string, string>())].filter(([path, oid]) => blobs.get(path) !== oid).map(([path]) => path).sort();
  if (stale.length > 0) problems.push(`the engine loaded files whose bytes differ from its commit: ${listed(stale)}`);

  const procedureFiles: Array<[string, string]> = [];
  for (const [path, entry] of disk.entries) if (PROCEDURE_PATHS.some((root) => path === root || path.startsWith(`${root}/`))) procedureFiles.push([path, entry.oid]);
  const rulesFiles: Array<{ path: string; text: string }> = [];
  for (const path of RULES_FILES) {
    const bytes = disk.entries.get(path)?.bytes;
    if (bytes !== undefined && bytes.length <= MAX_RULES_BYTES) rulesFiles.push({ path, text: bytes.toString("utf8") });
  }
  return { commit: state.head, procedureHash: procedureHash(procedureFiles), problems, rulesFiles };
}
