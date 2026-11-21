// Where a symbolic link of a tree leads, from its link text alone. The plan follows changed paths
// through links (plan.ts), and the package graph asks whether a link may lead to a folder through
// which pnpm reads packages (workspace.ts).

import { posix } from "node:path";
import type { TreeEntry } from "../git.ts";
import { foldAscii, isPlainPath } from "./glob.ts";

/** The modes of a regular file; git gives every file one of these, and a link or submodule none. */
const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

/** True for the mode of a regular file (a diff side's mode is 000000 where the path is absent). */
export function isRegularMode(mode: string): boolean {
  return REGULAR_FILE_MODES.has(mode);
}

/**
 * True when `entry` is a regular file. A symbolic link is a blob too, but its content is the link
 * text, while every program that opens the path reads the file the link points to.
 */
export function isRegularFile(entry: TreeEntry): boolean {
  return entry.type === "blob" && isRegularMode(entry.mode);
}

/** The repository path a symbolic link reaches: "" (the whole tree) when that cannot be known. */
export function linkTarget(linkPath: string, bytes: Uint8Array | undefined): string {
  if (bytes === undefined) return "";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return "";
  }
  // An absolute target, or one that leaves the tree, may land anywhere on the machine that runs
  // the code, the checkout included; so may one this cannot read, and one outside printable ASCII
  // (a disk that folds more than ASCII may read it as another path). Each counts as the whole tree.
  if (text === "" || !isPlainPath(text) || text.includes("\\") || posix.isAbsolute(text)) return "";
  // Leading ".." segments climb the link's own folders, which are real folders of the tree, so
  // they resolve by name. A ".." after a folder the target names climbs out of wherever that
  // folder leads, and the folder may itself be a link: the kernel follows it first, so the name
  // alone cannot tell where the target lands.
  let named = false;
  for (const segment of text.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") named = true;
    else if (named) return "";
  }
  const joined = posix.normalize(posix.join(posix.dirname(linkPath), text)).replace(/\/+$/, "");
  if (joined === "." || joined === "" || joined === ".." || joined.startsWith("../")) return "";
  return joined;
}

/** A tree's entries by path, with the folded names a disk that ignores case would see. */
export interface TreeIndex {
  readonly byPath: ReadonlyMap<string, TreeEntry>;
  /** How many entries have each path, ASCII case folded. */
  readonly foldedPaths: ReadonlyMap<string, number>;
  /** Every folder that holds an entry, ASCII case folded. */
  readonly foldedFolders: ReadonlySet<string>;
  /** The paths of the links and submodules, ASCII case folded. */
  readonly foldedNonFiles: ReadonlySet<string>;
}

export function indexTree(tree: readonly TreeEntry[]): TreeIndex {
  const byPath = new Map<string, TreeEntry>();
  const foldedPaths = new Map<string, number>();
  const foldedFolders = new Set<string>();
  const foldedNonFiles = new Set<string>();
  for (const entry of tree) {
    byPath.set(entry.path, entry);
    const folded = foldAscii(entry.path);
    foldedPaths.set(folded, (foldedPaths.get(folded) ?? 0) + 1);
    if (!isRegularFile(entry)) foldedNonFiles.add(folded);
    for (let slash = folded.indexOf("/"); slash > 0; slash = folded.indexOf("/", slash + 1))
      foldedFolders.add(folded.slice(0, slash));
  }
  return { byPath, foldedPaths, foldedFolders, foldedNonFiles };
}

/**
 * True when the symbolic link `entry` can only lead to a regular file: its target is a regular
 * file of the same tree, named in its own case, that no other entry or folder shares in any case
 * and that no link or submodule lies above (a disk that ignores case, or the kernel following a
 * link on the way, could open something else). False for a target that cannot be known, leaves
 * the tree, is missing, or is a folder, a link or a submodule, any of which may lead to a folder.
 */
export function leadsOnlyToFile(
  entry: TreeEntry,
  blobs: ReadonlyMap<string, Uint8Array>,
  index: TreeIndex,
): boolean {
  const target = linkTarget(entry.path, blobs.get(entry.oid));
  if (target === "") return false;
  const found = index.byPath.get(target);
  if (found === undefined || !isRegularFile(found)) return false;
  const folded = foldAscii(target);
  if (index.foldedPaths.get(folded) !== 1 || index.foldedFolders.has(folded)) return false;
  for (let slash = folded.indexOf("/"); slash > 0; slash = folded.indexOf("/", slash + 1))
    if (index.foldedNonFiles.has(folded.slice(0, slash))) return false;
  return true;
}
