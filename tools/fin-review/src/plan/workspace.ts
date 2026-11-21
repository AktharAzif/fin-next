// The workspace package graph, read from each package.json's workspace dependencies at the base
// and the head (spec 07 §2.3.1 step 5, §10.2). No pnpm call: the manifests are read from git, so
// the same base and head always give the same graph. An edge present on either side counts, so a
// pull request cannot drop a dependent's e2e by deleting the dependency it changes.
//
// A dependency is a workspace edge when its spec is `workspace:*` (or any `workspace:` range) on
// the package's own name, `workspace:<name>@<range>` (pnpm's alias form, an edge to <name>), or a
// path into the workspace (`workspace:../x`, `link:`, `file:`, `portal:`). A path that names no
// package folder, a package name outside npm's grammar, and two package folders whose names differ
// only by case (one folder on a case-insensitive disk) make the graph unusable, which runs
// everything.
//
// A package is a package.json, a regular file, in a folder the workspace globs name in their own
// case: what pnpm reads on a case-sensitive disk (CI's). Any other file pnpm, or a disk that
// ignores case, could read as a workspace package's manifest (package.yaml, package.json5,
// Package.json, a package.json in a folder spelled in another case, or in a folder whose name is
// not plain ASCII) makes the graph unusable too: the machines would not agree on it, and the plan
// cannot read YAML or JSON5. So does a manifest that is a symbolic link or a submodule (git keeps a
// link as a blob whose content is the link text, while pnpm reads the file the link points to),
// and a link or submodule at a workspace folder or at a folder above one, through which pnpm reads
// packages the plan cannot see. A link that can only lead to a regular file of the tree holds no
// package (links.ts says which), so it leaves the graph readable.

import { posix } from "node:path";
import { shownText } from "../display.ts";
import type { TreeEntry } from "../git.ts";
import { GITLINK_MODE, SYMLINK_MODE } from "../git.ts";
import { isJsonObject, parseJsonBytes } from "../json.ts";
import type { Glob } from "./glob.ts";
import { compileGlob, foldAscii, isPlainPath, matchesAny } from "./glob.ts";
import type { TreeIndex } from "./links.ts";
import { indexTree, isRegularFile, leadsOnlyToFile } from "./links.ts";

export interface Workspace {
  /** Every package folder, at the base or the head, mapped to its package names. */
  readonly namesByDir: ReadonlyMap<string, ReadonlySet<string>>;
  /** Each package name's folders. */
  readonly dirsByName: ReadonlyMap<string, ReadonlySet<string>>;
  /** Each package's workspace dependencies (names). */
  readonly deps: ReadonlyMap<string, ReadonlySet<string>>;
  /** Packages that hold a *.db.test.ts at the base or the head. */
  readonly withDbTests: ReadonlySet<string>;
  /** The segment count of each workspace glob, longest first, for owner lookups. */
  readonly depths: readonly number[];
}

export type WorkspaceResult = { ok: true; value: Workspace } | { ok: false; error: string };

const MANIFEST = "package.json";
/** The file names, ASCII case folded, that pnpm reads as a project's manifest. */
const MANIFEST_NAMES: ReadonlySet<string> = new Set([MANIFEST, "package.json5", "package.yaml"]);
const DB_TEST_SUFFIX = ".db.test.ts";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const MAX_MANIFEST_BYTES = 1 << 20;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGE_NAME_LENGTH = 214;
const PATH_PROTOCOLS = ["link:", "file:", "portal:"] as const;
/** `workspace:<name>@<range>`: the name, scoped or not, then `@` and the range. */
const WORKSPACE_ALIAS_RE = /^((?:@[^@/]+\/)?[^@/]+)@(.*)$/;

/** True for an npm package name (lower case, at most 214 characters, optionally scoped). */
export function isPackageName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_PACKAGE_NAME_LENGTH &&
    PACKAGE_NAME_RE.test(value)
  );
}

/** True when `dir` is a workspace folder as pnpm reads the globs on a case-sensitive disk. */
function isPackageFolder(dir: string, workspaces: readonly Glob[]): boolean {
  return isPlainPath(dir) && workspaces.some((glob) => glob.exact(dir));
}

/** True for a file name, in any case, that pnpm reads as a project's manifest. */
function isManifestName(name: string): boolean {
  return (
    name.length >= MANIFEST.length &&
    name.length <= MANIFEST.length + 1 &&
    MANIFEST_NAMES.has(foldAscii(name))
  );
}

/** Globs for the folders above the workspace folders (`apps` for `apps/*`). */
function parentGlobs(workspaces: readonly Glob[]): Glob[] {
  const out: Glob[] = [];
  for (const glob of workspaces) {
    const segments = glob.pattern.split("/");
    for (let depth = 1; depth < segments.length; depth++)
      out.push(compileGlob(segments.slice(0, depth).join("/")));
  }
  return out;
}

/** "a symbolic link" or "a submodule" for an entry that is either, null for any other. */
function linkKind(entry: TreeEntry): string | null {
  if (entry.mode === SYMLINK_MODE) return "a symbolic link";
  if (entry.mode === GITLINK_MODE) return "a submodule";
  return null;
}

/** The package.json entries of a tree that are regular files directly in a workspace folder (named in the globs' own case). */
export function manifestEntries(
  tree: readonly TreeEntry[],
  workspaces: readonly Glob[],
): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const entry of tree) {
    if (!isRegularFile(entry) || !entry.path.endsWith(`/${MANIFEST}`)) continue;
    const dir = entry.path.slice(0, -(MANIFEST.length + 1));
    if (isPackageFolder(dir, workspaces)) out.push(entry);
  }
  return out;
}

/** One entry pnpm may read as, or through, a workspace package's manifest that the plan cannot. */
interface UnreadEntry {
  readonly path: string;
  /** The folder, ASCII case folded, pnpm may read as a package; for `above`, every folder below it. */
  readonly folder: string;
  /** True for a link or submodule above the workspace folders. */
  readonly above: boolean;
  readonly why: string;
}

/**
 * Every entry of `tree` that pnpm, or a disk that ignores case, could read as a workspace package's
 * manifest but that manifestEntries does not take (another name or case, a link, a submodule), and
 * every link or submodule at a workspace folder or above one that may lead to a folder. `blobs`
 * holds the links' blobs; a link whose blob is missing may lead anywhere.
 */
function unreadEntries(
  tree: readonly TreeEntry[],
  workspaces: readonly Glob[],
  blobs: ReadonlyMap<string, Uint8Array>,
): UnreadEntry[] {
  const parents = parentGlobs(workspaces);
  const out: UnreadEntry[] = [];
  let index: TreeIndex | null = null;
  for (const entry of tree) {
    const kind = linkKind(entry);
    const atOrAbove =
      kind !== null && (matchesAny(workspaces, entry.path) || matchesAny(parents, entry.path));
    // A link that can only lead to a regular file holds no package: pnpm reads none through it.
    let toFile = false;
    if (atOrAbove && entry.mode === SYMLINK_MODE) {
      index ??= indexTree(tree);
      toFile = leadsOnlyToFile(entry, blobs, index);
    }
    if (atOrAbove && !toFile) {
      const above = !matchesAny(workspaces, entry.path);
      const where = above ? "above the workspace folders" : "at a workspace folder";
      out.push({
        path: entry.path,
        folder: foldAscii(entry.path),
        above,
        why: `is ${kind} ${where}, through which pnpm reads packages the plan cannot see`,
      });
      continue;
    }
    const slash = entry.path.lastIndexOf("/");
    const name = entry.path.slice(slash + 1);
    if (slash < 0 || !isManifestName(name)) continue;
    const dir = entry.path.slice(0, slash);
    if (!matchesAny(workspaces, dir)) continue;
    if (!isRegularFile(entry)) {
      const what = kind ?? `an entry of mode ${entry.mode}`;
      out.push({
        path: entry.path,
        folder: foldAscii(dir),
        above: false,
        why: `is not a regular file (${what}), and pnpm reads what it points to`,
      });
    } else if (name !== MANIFEST || !isPackageFolder(dir, workspaces)) {
      out.push({
        path: entry.path,
        folder: foldAscii(dir),
        above: false,
        why: "is a manifest pnpm or a case-insensitive disk may read, and the plan reads only package.json in a folder the workspace globs name in their own case",
      });
    }
  }
  return out;
}

/**
 * The first entry of `tree` that pnpm could read as, or through, a workspace package's manifest
 * while the plan cannot, as a problem line; null when there is none.
 */
export function unreadManifest(
  tree: readonly TreeEntry[],
  workspaces: readonly Glob[],
  blobs: ReadonlyMap<string, Uint8Array>,
): string | null {
  const first = unreadEntries(tree, workspaces, blobs)[0];
  return first === undefined ? null : `${shownText(first.path)} ${first.why}`;
}

/**
 * The folders, ASCII case folded, that pnpm may read as a workspace package in `tree`: each folder
 * with a package.json manifestEntries takes, and each folder holding (or being) an entry of
 * unreadManifest's kind. `above` holds the links and submodules above the workspace folders, any
 * folder below which may be a package.
 */
export function packageFolders(
  tree: readonly TreeEntry[],
  workspaces: readonly Glob[],
  blobs: ReadonlyMap<string, Uint8Array>,
): { folders: Set<string>; above: Set<string> } {
  const folders = new Set(
    manifestEntries(tree, workspaces).map((entry) => foldAscii(manifestDir(entry))),
  );
  const above = new Set<string>();
  for (const entry of unreadEntries(tree, workspaces, blobs))
    (entry.above ? above : folders).add(entry.folder);
  return { folders, above };
}

/** The folder of a package.json entry. */
export function manifestDir(entry: TreeEntry): string {
  return entry.path.slice(0, -(MANIFEST.length + 1));
}

export interface Manifest {
  readonly name: string;
  /** Workspace dependencies named by package. */
  readonly deps: readonly string[];
  /** Workspace dependencies named by folder (repository paths), resolved against the folders. */
  readonly pathDeps: readonly string[];
}

/** A path spec resolved against the manifest's folder: a repository path, or null outside it. */
function repositoryPath(dir: string, target: string): string | null {
  if (target === "" || target.includes("\0") || target.includes("\\") || posix.isAbsolute(target))
    return null;
  const joined = posix.normalize(posix.join(dir, target)).replace(/\/+$/, "");
  if (joined === "" || joined === "." || joined === ".." || joined.startsWith("../")) return null;
  return joined;
}

/** Parses one manifest of the folder `dir`: its name and its workspace dependencies. */
export function parseManifest(
  bytes: Uint8Array,
  dir: string,
): { ok: true; value: Manifest } | { ok: false; error: string } {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) return { ok: false, error: "is larger than 1 MiB" };
  const parsed = parseJsonBytes(bytes);
  if (!parsed.ok) return { ok: false, error: `is ${parsed.error}` };
  const value = parsed.value;
  if (!isJsonObject(value)) return { ok: false, error: "is not a JSON object" };
  const name = value["name"];
  if (typeof name !== "string" || name === "") return { ok: false, error: "has no name" };
  if (!isPackageName(name))
    return {
      ok: false,
      error: `has the name ${shownText(name, 120)}, which is not an npm package name`,
    };
  const deps = new Set<string>();
  const pathDeps = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const block = value[field];
    if (!isJsonObject(block)) return { ok: false, error: `has a ${field} that is not an object` };
    for (const [dep, spec] of Object.entries(block)) {
      if (typeof spec !== "string") continue;
      const protocol = PATH_PROTOCOLS.find((prefix) => spec.startsWith(prefix));
      let target: string | null = null;
      if (protocol !== undefined) target = spec.slice(protocol.length);
      else if (spec.startsWith("workspace:")) {
        const rest = spec.slice("workspace:".length);
        if (rest.startsWith(".") || rest.startsWith("/")) target = rest;
        else {
          const alias = WORKSPACE_ALIAS_RE.exec(rest);
          const named = alias === null ? dep : (alias[1] ?? "");
          if (!isPackageName(named)) {
            return {
              ok: false,
              error: `has the workspace dependency ${shownText(named, 120)} in ${field}, which is not an npm package name`,
            };
          }
          deps.add(named);
          continue;
        }
      } else continue; // a registry, catalog or alias spec: not a workspace edge
      const path = repositoryPath(dir, target);
      if (path === null)
        return {
          ok: false,
          error: `has the ${field} entry ${shownText(dep, 120)} with a path outside the repository`,
        };
      pathDeps.add(path);
    }
  }
  return { ok: true, value: { name, deps: [...deps].sort(), pathDeps: [...pathDeps].sort() } };
}

export interface WorkspaceSide {
  /** Every tracked entry of the tree. */
  readonly tree: readonly TreeEntry[];
  /** The blobs read for this side's manifests, by object ID. */
  readonly blobs: ReadonlyMap<string, Uint8Array>;
}

/** Builds the union graph of the given sides (the head, and the base when there is one). */
export function buildWorkspace(
  sides: readonly WorkspaceSide[],
  workspaces: readonly Glob[],
): WorkspaceResult {
  const namesByDir = new Map<string, Set<string>>();
  const dirsByName = new Map<string, Set<string>>();
  const deps = new Map<string, Set<string>>();
  const withDbTests = new Set<string>();
  const depths = [...new Set(workspaces.map((glob) => glob.pattern.split("/").length))].sort(
    (a, b) => b - a,
  );
  const dirsByFolded = new Map<string, string>();

  for (const side of sides) {
    const unread = unreadManifest(side.tree, workspaces, side.blobs);
    if (unread !== null) return { ok: false, error: unread };
    const sideDirs = new Map<string, string>();
    const sideNames = new Map<string, string>();
    const manifests: Array<{ dir: string; manifest: Manifest }> = [];
    for (const entry of manifestEntries(side.tree, workspaces)) {
      const dir = manifestDir(entry);
      const bytes = side.blobs.get(entry.oid);
      if (bytes === undefined)
        return { ok: false, error: `${shownText(entry.path)} could not be read` };
      const parsed = parseManifest(bytes, dir);
      if (!parsed.ok) return { ok: false, error: `${shownText(entry.path)} ${parsed.error}` };
      const manifest = parsed.value;
      const other = sideNames.get(manifest.name);
      if (other !== undefined) {
        return {
          ok: false,
          error: `${shownText(manifest.name)} is the name of both ${shownText(other)} and ${shownText(dir)}`,
        };
      }
      const folded = foldAscii(dir);
      const twin = dirsByFolded.get(folded);
      if (twin !== undefined && twin !== dir) {
        return {
          ok: false,
          error: `the package folders ${shownText(twin)} and ${shownText(dir)} differ only by case`,
        };
      }
      dirsByFolded.set(folded, dir);
      sideNames.set(manifest.name, dir);
      sideDirs.set(dir, manifest.name);
      manifests.push({ dir, manifest });
    }
    for (const { dir, manifest } of manifests) {
      setAdd(namesByDir, dir, manifest.name);
      setAdd(dirsByName, manifest.name, dir);
      const set = deps.get(manifest.name) ?? new Set<string>();
      for (const dep of manifest.deps) set.add(dep);
      for (const path of manifest.pathDeps) {
        const target = sideDirs.get(path);
        if (target === undefined) {
          return {
            ok: false,
            error: `${shownText(`${dir}/${MANIFEST}`)} depends on the path ${shownText(path)}, which is not a package folder`,
          };
        }
        set.add(target);
      }
      deps.set(manifest.name, set);
    }
    for (const entry of side.tree) {
      // A case-insensitive disk runs x.DB.test.ts as a db test too.
      if (
        entry.type !== "blob" ||
        foldAscii(entry.path.slice(-DB_TEST_SUFFIX.length)) !== DB_TEST_SUFFIX
      )
        continue;
      const dir = ownerDirIn(entry.path, depths, (candidate) => sideDirs.has(candidate));
      const name = dir === null ? undefined : sideDirs.get(dir);
      if (name !== undefined) withDbTests.add(name);
    }
  }
  return { ok: true, value: { namesByDir, dirsByName, deps, withDbTests, depths } };
}

function setAdd<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
}

function ownerDirIn(
  path: string,
  depths: readonly number[],
  isDir: (dir: string) => boolean,
): string | null {
  const segments = path.split("/");
  for (const depth of depths) {
    if (segments.length <= depth) continue;
    const dir = segments.slice(0, depth).join("/");
    if (isDir(dir)) return dir;
  }
  return null;
}

/** The package folder that owns `path`, or null when no package does. */
export function ownerDir(workspace: Workspace, path: string): string | null {
  return ownerDirIn(path, workspace.depths, (dir) => workspace.namesByDir.has(dir));
}

/** The package names that own `path` (two when a folder changed its name between base and head). */
export function ownerNames(workspace: Workspace, path: string): string[] {
  const dir = ownerDir(workspace, path);
  if (dir === null) return [];
  return [...(workspace.namesByDir.get(dir) ?? [])].sort();
}

/** `names` and every package that depends on one of them, directly or through others. */
export function dependentsClosure(workspace: Workspace, names: Iterable<string>): Set<string> {
  const reverse = new Map<string, Set<string>>();
  for (const [name, set] of workspace.deps) {
    for (const dep of set) setAdd(reverse, dep, name);
  }
  const out = new Set<string>();
  const queue: string[] = [];
  for (const name of names) {
    if (!out.has(name)) {
      out.add(name);
      queue.push(name);
    }
  }
  while (queue.length > 0) {
    const name = queue.pop() as string;
    for (const dependent of reverse.get(name) ?? []) {
      if (!out.has(dependent)) {
        out.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return out;
}

/** `name` and every package it depends on, directly or through others. */
export function dependencyClosure(workspace: Workspace, name: string): Set<string> {
  const out = new Set<string>([name]);
  const queue = [name];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const dep of workspace.deps.get(current) ?? []) {
      if (!out.has(dep)) {
        out.add(dep);
        queue.push(dep);
      }
    }
  }
  return out;
}
