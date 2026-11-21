// The reviewed tree (spec 07 §2.5, §4.4). The head's blobs, read once from the mirror by object ID,
// are both what the engine reviews (unit text, the import graph, every quote check) and what it
// writes to $FIN_REVIEW_HOME/trees/<run-id> for the sessions' Read, Grep and Glob. No checkout runs,
// so nothing in the tree under review (a .gitattributes encoding, filter or line-ending rule) and
// nothing on the machine (git configuration, a disk that folds case or Unicode) can make what a
// session or the engine reads differ from what the commit holds.
//
// Paths the engine cannot present faithfully are refused before anything is written: a control or
// format character (a new line in a name would put a forged DATA marker at the start of a prompt
// line), bytes that are not UTF-8, an empty, `.` or `..` segment, a segment a disk would read as
// `.git`, and two paths a disk that ignores case or Unicode normalisation would take for one. Every
// file is then created exclusively, so a fold this check does not know still fails closed.
// Symbolic links are written as plain files holding the link's target; a submodule is an empty
// folder.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shownText } from "../display.ts";
import { GITLINK_MODE, SYMLINK_MODE } from "../git.ts";
import type { TreeEntry } from "../git.ts";

export type EntryKind = "file" | "link" | "submodule";

/** The head cannot be written as one faithful tree on this disk. */
export class TreeError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(problems[0] ?? "the head cannot be written as a tree");
    this.name = "TreeError";
    this.problems = problems;
  }
}

/** Control, format, line and paragraph separators, lone surrogates, and U+FFFD (bytes that were not UTF-8). */
const UNSAFE_CHAR_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}�]/u;
const IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/gu;
const MAX_LISTED = 20;

/** What a tree entry is: a file, a symbolic link, a submodule, or null for anything else. */
export function entryKind(entry: TreeEntry): EntryKind | null {
  if (entry.mode === GITLINK_MODE) return entry.type === "commit" ? "submodule" : null;
  if (entry.type !== "blob") return null;
  return entry.mode === SYMLINK_MODE ? "link" : "file";
}

/** A path as a disk that ignores case and Unicode normalisation (and ignorable code points) would compare it. */
export function foldPath(path: string): string {
  return path.normalize("NFC").replace(IGNORABLE_RE, "").toUpperCase().toLowerCase().normalize("NFC");
}

/** True for a segment some disk reads as `.git` (any case, ignorable code points, trailing dots or spaces, a short name). */
function isGitSegment(segment: string): boolean {
  const folded = foldPath(segment).replace(/[. ]+$/, "");
  return folded === ".git" || /^git~[0-9]+$/.test(folded);
}

/**
 * Why `path` cannot appear in a prompt or on the disk as it is, or null: a control or format
 * character, bytes that were not UTF-8, or an empty, `.` or `..` segment.
 */
export function pathTextProblem(path: string): string | null {
  if (path === "" || UNSAFE_CHAR_RE.test(path)) return `${shownText(path)} holds a control or format character, or bytes that are not UTF-8`;
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return `${shownText(path)} has an empty, . or .. segment`;
  return null;
}

function capped(problems: readonly string[]): string[] {
  if (problems.length <= MAX_LISTED) return [...problems];
  return [...problems.slice(0, MAX_LISTED), `and ${problems.length - MAX_LISTED} more`];
}

/**
 * Why the head's entries cannot be written as one tree that shows each path's own bytes, or []
 * when they can: a path `pathTextProblem` refuses, a `.git` segment, an entry that is neither a
 * file, a link nor a submodule, and two paths (or a path and a folder) that fold to one name.
 */
export function treeProblems(entries: readonly TreeEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, { spelling: string; folder: boolean }>();
  for (const entry of entries) {
    const text = pathTextProblem(entry.path);
    if (text !== null) {
      problems.push(text);
      continue;
    }
    const segments = entry.path.split("/");
    if (segments.some(isGitSegment)) {
      problems.push(`${shownText(entry.path)} has a segment a disk reads as .git`);
      continue;
    }
    if (entryKind(entry) === null) {
      problems.push(`${shownText(entry.path)} is a ${shownText(entry.type, 40)} entry (mode ${entry.mode}), neither a file, a link nor a submodule`);
      continue;
    }
    for (let i = 1; i <= segments.length; i++) {
      const spelling = segments.slice(0, i).join("/");
      const folder = i < segments.length;
      const folded = foldPath(spelling);
      const prior = seen.get(folded);
      if (prior === undefined) {
        seen.set(folded, { spelling, folder });
        continue;
      }
      if (prior.spelling === spelling && prior.folder && folder) continue;
      problems.push(
        prior.spelling === spelling
          ? `${shownText(spelling)} is listed twice, or as both a file and a folder`
          : `${shownText(spelling)} and ${shownText(prior.spelling)} are one name on a disk that ignores case or Unicode normalisation`,
      );
      break;
    }
  }
  return capped(problems);
}

function collision(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR" || code === "ENAMETOOLONG" || code === "EILSEQ";
}

/**
 * Writes every entry of the head into the new directory `treeDir` from `blobs`, each file created
 * exclusively. Throws TreeError when the entries have problems (`treeProblems`), a blob is missing,
 * or the disk takes two entries for one.
 */
export function writeTree(treeDir: string, entries: readonly TreeEntry[], blobs: ReadonlyMap<string, Buffer>): void {
  const problems = treeProblems(entries);
  if (problems.length > 0) throw new TreeError(problems);
  const missing = entries.filter((entry) => entryKind(entry) !== "submodule" && !blobs.has(entry.oid));
  if (missing.length > 0) throw new TreeError(capped(missing.map((entry) => `the mirror lacks the blob of ${shownText(entry.path)}`)));
  mkdirSync(treeDir, { recursive: true, mode: 0o700 });
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of sorted) {
    const target = join(treeDir, ...entry.path.split("/"));
    try {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (entryKind(entry) === "submodule") mkdirSync(target, { mode: 0o700 });
      else writeFileSync(target, blobs.get(entry.oid) ?? Buffer.alloc(0), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!collision(error)) throw error;
      throw new TreeError([`${shownText(entry.path)} is the same file as another path of the head on this disk`]);
    }
  }
}
