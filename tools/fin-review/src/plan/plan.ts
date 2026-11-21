// `plan` (spec 07 §2.3.1, §10.1, §10.2; spec 01 §5.3): changed files, tiers, CI path classes, job
// flags and the affected workspace packages, from git and files only.
//
// Inputs are a base and a head SHA and the event. The change is the diff from the merge base of
// base and head to head. When the two have no single merge base (criss-cross merges, or unrelated
// histories) git alone would pick one by date, so the change is the union of the diffs from every
// merge base (or, with none, the difference between the two trees) and the plan runs everything
// at tier S. Tiers come from tools/layout.json as it is at the base, which is main's for a pull
// request, so a pull request that edits the layout cannot lower its own tier; with no base, from
// the head. Images and static outputs come from the layout at the head, what the commit builds
// (for a pull request, from the base's as well), for the folders that are live at the head; so do
// the e2e apps. A folder is live when it is a package there, or when it was a package at the base
// and still holds tracked files: such a folder stopped being a package, so the plan runs
// everything (spec 07 §10.2's non-package folder) and keeps its jobs, which then fail rather than
// vanish. The path classes come from this engine's own config/ci-map.json (the engine copy from
// main in CI, S7-04). The package graph is the union of the base's and the head's manifests.
//
// The tiers of a change are counted by changeTiers, which the review modes use too (src/review/run.ts),
// so a review never runs at a lower tier than the plan gives the same change.
//
// Links: a changed symbolic link or submodule runs everything at tier S (and is itself tier S), and a changed path that a
// symbolic link in either tree reaches also counts at the link's path (code reached through a link
// is the link's code), through chains of links as a kernel follows them. When that reach cannot be
// bounded (a link that may reach any path, a chain longer than a kernel follows, or more link paths
// than the caps), the plan runs everything at tier S. Tier D is documentation (EXECUTION §1.7): a
// path the layout calls D that is not a documentation file, as the docs class of ci-map.json
// defines it, counts as S. A path with a character outside printable ASCII is tier S and unmapped
// (glob.ts: a disk that folds more than ASCII may read it as any path), and turns on the self-test.

import { posix } from "node:path";
import type { EngineConfig } from "../config.ts";
import { DataError } from "../errors.ts";
import { GITLINK_MODE, SYMLINK_MODE, diffRaw, existingCommits, isSha, lsTree, mergeBases, readBlobs } from "../git.ts";
import type { DiffEntry, TreeEntry } from "../git.ts";
import { parseJsonBytes } from "../json.ts";
import type { Tier } from "../roles.ts";
import { CLASS_NAMES, UNMAPPED, classesOf } from "./ci-map.ts";
import type { CiClass, CiMap, JobName } from "./ci-map.ts";
import { compileGlob, foldAscii, isPlainPath, matchesAny } from "./glob.ts";
import { maxTier, parseLayout, tierOf } from "./tiers.ts";
import type { Layout, PathTier, TierSource } from "./tiers.ts";
import { buildWorkspace, dependencyClosure, dependentsClosure, manifestDir, manifestEntries, ownerDir, ownerNames } from "./workspace.ts";
import type { Workspace } from "./workspace.ts";

export const LAYOUT_PATH = "tools/layout.json";
export const MAX_PLAN_BYTES = 64 * 1024;
const MAX_LAYOUT_BYTES = 4 << 20;
/** More merge bases than this is no history a pull request has; the plan refuses it. */
const MAX_MERGE_BASES = 64;
/**
 * How many links in a row a changed path is followed through: Linux's limit (macOS stops at 32).
 * A path reached through a longer chain, a path with more link paths than MAX_LINK_ALIASES, and a
 * change with more than MAX_LINK_ALIASES_TOTAL run everything at tier S.
 */
const MAX_LINK_DEPTH = 40;
const MAX_LINK_ALIASES = 64;
const MAX_LINK_ALIASES_TOTAL = 2_000;
/** The paths whose change turns on the engine's self-test (spec 07 §10.1's selfTest). */
const SELF_TEST_PATTERNS: readonly string[] = ["tools/fin-review", "tools/fin-review/**", "docs/review", "docs/review/**"];

/** Events whose plan is computed from the diff; every other event runs everything. */
export const COMPUTED_EVENTS: readonly string[] = ["pull_request", "local"];
export const EVENT_RE = /^[a-z][a-z_]{0,39}$/;

export interface PlanRequest {
  /** The repository work tree (or bare repository) git runs in. */
  readonly treeDir: string;
  /** `pull_request`, `local`, or a CI event that runs everything (`push`, `workflow_dispatch`, ...). */
  readonly event: string;
  /** The base SHA; null only for an event that runs everything (no usable `before`). */
  readonly base: string | null;
  readonly head: string;
  readonly config: EngineConfig;
  /** The environment git inherits (less its GIT_* variables). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type Reason = "event" | "history" | "layout" | "link" | "global" | "unmapped" | "workspace" | "classes";

export interface PlanJobs {
  check: boolean;
  db: boolean;
  build: boolean;
  seams: boolean;
  e2e: boolean;
  e2e_shards: number;
  static: boolean;
  bun: boolean;
  /** The CI review job (spec 07 §8, H-03). No such job runs before H-03, so this is false. */
  review: boolean;
  /** The engine's self-test: tools/fin-review/** or docs/review/** changed, or the change is unknown. */
  selfTest: boolean;
  containers: boolean;
}

/** The plan document (spec 07 §10.1): one line of JSON, at most 64 KB. */
export interface PlanDocument {
  v: 1;
  event: string;
  base: string | null;
  head: string;
  /** The change's tier, the highest of its paths'; null when nothing changed. */
  tier: Tier | null;
  /** Diff entries (a rename is one entry with two paths). */
  changed: number;
  classes: string[];
  everything: boolean;
  reason: Reason;
  jobs: PlanJobs;
  /**
   * The web apps whose e2e runs (their folder names under apps/), their Playwright projects
   * (`<app>-<variant>` for each variant of config/ci.json's e2eProjects), and the shards.
   */
  e2e: { apps: string[]; projects: string[]; shards: number };
  /**
   * The affected workspace packages: those owning changed files and their dependents. Null when
   * the package graph could not be read, which runs everything: every package counts.
   */
  packages: string[] | null;
  /** The images and static outputs (from tools/layout.json) of the affected packages whose folders are live at the head. */
  images: string[];
  static: string[];
  /** Whether the tier layout (the base's) was usable; when not, every path is tier S and everything runs. */
  layout: "ok" | "missing" | "invalid";
}

export interface PlanFile {
  readonly path: string;
  readonly status: string;
  /** "new" for the path at head, "old" for the base path of a rename or copy, "link" for a path reached through a symbolic link. */
  readonly side: "new" | "old" | "link";
  /** For side "link", the link the path is reached through. */
  readonly link: string | null;
  readonly tier: Tier;
  readonly tierSource: TierSource;
  readonly classes: readonly string[];
  readonly packages: readonly string[];
}

export interface PlanResult {
  readonly document: PlanDocument;
  readonly files: readonly PlanFile[];
  readonly layoutProblems: readonly string[];
  readonly workspaceProblem: string | null;
  /** Other things the caller should print, such as a push base the checkout lacks. */
  readonly notes: readonly string[];
}

/** A symbolic link of the base or the head tree and the repository path it reaches ("" for the whole tree). */
export interface TreeLink {
  readonly path: string;
  readonly target: string;
}

export interface LoadedLayout {
  layout: Layout | null;
  status: "ok" | "missing" | "invalid";
  problems: string[];
}

function findBlob(tree: readonly TreeEntry[], path: string): TreeEntry | null {
  for (const entry of tree) if (entry.path === path && entry.type === "blob") return entry;
  return null;
}

function loadLayout(entry: TreeEntry | null, blobs: ReadonlyMap<string, Uint8Array>): LoadedLayout {
  if (entry === null) return { layout: null, status: "missing", problems: [`${LAYOUT_PATH} is not in the tree`] };
  const bytes = blobs.get(entry.oid);
  if (bytes === undefined) return { layout: null, status: "missing", problems: [`${LAYOUT_PATH} could not be read`] };
  if (bytes.byteLength > MAX_LAYOUT_BYTES) return { layout: null, status: "invalid", problems: [`${LAYOUT_PATH} is too large`] };
  const parsed = parseJsonBytes(bytes);
  if (!parsed.ok) return { layout: null, status: "invalid", problems: [`${LAYOUT_PATH} is ${parsed.error}`] };
  const layout = parseLayout(parsed.value);
  if (!layout.ok) return { layout: null, status: "invalid", problems: layout.errors };
  return { layout: layout.value, status: "ok", problems: [] };
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

interface Change {
  diff: DiffEntry[];
  /** True when base and head have no single merge base. */
  ambiguous: boolean;
  notes: string[];
}

/** The change from base to head: the diff since their merge base, or the union described above. */
async function changeSince(cwd: string, base: string, head: string, env: Readonly<Record<string, string | undefined>>): Promise<Change> {
  const bases = await mergeBases(cwd, base, head, env);
  const only = bases.length === 1 ? bases[0] : undefined;
  if (only !== undefined) return { diff: await diffRaw(cwd, only, head, env), ambiguous: false, notes: [] };
  if (bases.length === 0) {
    return {
      diff: await diffRaw(cwd, base, head, env),
      ambiguous: true,
      notes: [`base ${base} and head ${head} share no history; planning every difference between their trees, and everything`],
    };
  }
  if (bases.length > MAX_MERGE_BASES) throw new DataError(`base ${base} and head ${head} have ${bases.length} merge bases`);
  const diffs: DiffEntry[][] = [];
  for (const mergeBase of bases) diffs.push(await diffRaw(cwd, mergeBase, head, env));
  return {
    diff: unionOfDiffs(diffs),
    ambiguous: true,
    notes: [`base ${base} and head ${head} have ${bases.length} merge bases; planning the changes since each of them, and everything`],
  };
}

/** Computes the plan. Throws DataError when base or head is not a commit in the tree. */
export async function computePlan(request: PlanRequest): Promise<PlanResult> {
  const { treeDir, event, head, config, env } = request;
  let base = request.base;
  if (!EVENT_RE.test(event)) throw new TypeError("event must be a lower-case event name");
  if (!isSha(head)) throw new TypeError("head must be a 40-character lower-case SHA");
  if (base !== null && !isSha(base)) throw new TypeError("base must be a 40-character lower-case SHA or null");
  const computed = COMPUTED_EVENTS.includes(event);
  if (computed && base === null) throw new TypeError(`a ${event} plan needs a base`);

  const wanted = base === null ? [head] : [base, head];
  const found = await existingCommits(treeDir, wanted, env);
  if (!found.has(head)) throw new DataError(`head ${head} is not a commit in ${treeDir}`);
  const notes: string[] = [];
  if (base !== null && !found.has(base)) {
    // A push's `before` can be a commit the checkout does not have (a new or rewritten branch).
    // Such an event runs everything anyway, so it is planned without the diff; a pull request's
    // plan needs its base.
    if (computed) throw new DataError(`base ${base} is not a commit in ${treeDir}`);
    notes.push(`base ${base} is not a commit here; planning the ${event} without a diff`);
    base = null;
  }

  const [change, headTree, baseTree] = await Promise.all([
    base === null ? Promise.resolve<Change | null>(null) : changeSince(treeDir, base, head, env),
    lsTree(treeDir, head, env),
    base === null ? Promise.resolve<TreeEntry[] | null>(null) : lsTree(treeDir, base, env),
  ]);
  if (change !== null) notes.push(...change.notes);

  const workspaces = config.ci.workspaces;
  const headLayoutEntry = findBlob(headTree, LAYOUT_PATH);
  const baseLayoutEntry = baseTree === null ? null : findBlob(baseTree, LAYOUT_PATH);
  const headManifests = manifestEntries(headTree, workspaces);
  const baseManifests = baseTree === null ? [] : manifestEntries(baseTree, workspaces);
  const manifests = [...headManifests, ...baseManifests];
  const linkEntries = [...headTree, ...(baseTree ?? [])].filter((entry) => entry.mode === SYMLINK_MODE);
  const read = await readBlobs(
    treeDir,
    [
      ...(headLayoutEntry === null ? [] : [headLayoutEntry.oid]),
      ...(baseLayoutEntry === null ? [] : [baseLayoutEntry.oid]),
      ...manifests.map((entry) => entry.oid),
      ...linkEntries.map((entry) => entry.oid),
    ],
    env,
  );
  notes.push(...read.problems);
  const blobs = read.blobs;

  // Tiers: the base's layout (the head's when there is no base).
  const loaded = loadLayout(baseTree === null ? headLayoutEntry : baseLayoutEntry, blobs);
  // Images and static outputs: the head's layout too, unless it is the same file (or both lack it).
  const sameLayout = baseTree === null || headLayoutEntry?.oid === baseLayoutEntry?.oid;
  const headLoaded = sameLayout ? loaded : loadLayout(headLayoutEntry, blobs);
  const outputLayouts: Layout[] = [];
  if (computed) {
    // A pull request: what main lists and what the pull request lists.
    if (loaded.layout !== null) outputLayouts.push(loaded.layout);
    if (headLoaded !== loaded && headLoaded.layout !== null) outputLayouts.push(headLoaded.layout);
  } else if (headLoaded.layout !== null) outputLayouts.push(headLoaded.layout);
  else if (loaded.layout !== null) outputLayouts.push(loaded.layout);
  const layoutProblems = [...loaded.problems, ...(headLoaded === loaded ? [] : headLoaded.problems.map((problem) => `at the head: ${problem}`))];

  const sides = [{ tree: headTree, blobs }, ...(baseTree === null ? [] : [{ tree: baseTree, blobs }])];
  const built = buildWorkspace(sides, workspaces);
  const links = new Map<string, TreeLink>();
  for (const entry of linkEntries) {
    const link = { path: entry.path, target: linkTarget(entry.path, blobs.get(entry.oid)) };
    links.set(`${link.path}\0${link.target}`, link);
  }
  const folders = liveFolders(headTree, headManifests, baseManifests);

  return assemble({
    event,
    computed,
    base,
    head,
    config,
    diff: change === null ? null : change.diff,
    historyAmbiguous: change?.ambiguous ?? false,
    loaded,
    outputLayouts,
    layoutProblems,
    workspace: built.ok ? built.value : null,
    workspaceProblem: built.ok ? null : built.error,
    liveDirs: folders.live,
    stalePackageDirs: folders.stale,
    links: [...links.values()],
    notes,
  });
}

/**
 * The folders, ASCII case folded, whose e2e, image and static outputs count: each package folder
 * of the head, and each package folder of the base that still holds tracked files at the head.
 * Those last are `stale` as well: they stopped being packages (a deleted or renamed package.json).
 */
function liveFolders(headTree: readonly TreeEntry[], headManifests: readonly TreeEntry[], baseManifests: readonly TreeEntry[]): { live: Set<string>; stale: string[] } {
  const live = new Set(headManifests.map((entry) => foldAscii(manifestDir(entry))));
  const stale: string[] = [];
  let held: Set<string> | null = null;
  for (const entry of baseManifests) {
    const dir = manifestDir(entry);
    if (live.has(foldAscii(dir))) continue;
    held ??= heldFolders(headTree);
    if (held.has(foldAscii(dir))) stale.push(dir);
  }
  for (const dir of stale) live.add(foldAscii(dir));
  return { live, stale };
}

/** Every folder that holds a tracked entry of `tree`, ASCII case folded (as the disk that ignores case sees it). */
function heldFolders(tree: readonly TreeEntry[]): Set<string> {
  const out = new Set<string>();
  for (const entry of tree) {
    const folded = foldAscii(entry.path);
    for (let slash = folded.indexOf("/"); slash > 0; slash = folded.indexOf("/", slash + 1)) out.add(folded.slice(0, slash));
  }
  return out;
}

export interface AssembleInput {
  event: string;
  computed: boolean;
  base: string | null;
  head: string;
  config: EngineConfig;
  diff: readonly DiffEntry[] | null;
  /** True when base and head have no single merge base (the diff is then the union described above). */
  historyAmbiguous?: boolean;
  /** The tier layout. */
  loaded: LoadedLayout;
  /** The layouts whose images and static outputs count; the tier layout's when absent. */
  outputLayouts?: readonly Layout[];
  /** Problems to report; the tier layout's when absent. */
  layoutProblems?: readonly string[];
  workspace: Workspace | null;
  workspaceProblem: string | null;
  /**
   * The folders, ASCII case folded, whose e2e, image and static outputs count (a package at the
   * head, or a package of the base that still holds tracked files there); the workspace's package
   * folders when absent.
   */
  liveDirs?: ReadonlySet<string>;
  /** The package folders of the base that hold tracked files at the head but are no package there. */
  stalePackageDirs?: readonly string[];
  /** The symbolic links of the base and head trees. */
  links?: readonly TreeLink[];
  notes?: readonly string[];
}

function sortedNames(set: Iterable<string>): string[] {
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The links of the trees, looked up by the folded path each one reaches. */
export interface LinkIndex {
  /** A link that may reach any path (its target is "", the whole tree), or null when none does. */
  readonly wholeTree: TreeLink | null;
  readonly byTarget: ReadonlyMap<string, readonly TreeLink[]>;
}

/** Indexes the links once, so each changed path looks up its own folders rather than every link. */
export function indexLinks(links: readonly TreeLink[]): LinkIndex {
  let wholeTree: TreeLink | null = null;
  const byTarget = new Map<string, TreeLink[]>();
  for (const link of links) {
    if (link.target === "") {
      wholeTree ??= link;
      continue;
    }
    const key = foldAscii(link.target);
    const list = byTarget.get(key);
    if (list === undefined) byTarget.set(key, [link]);
    else list.push(link);
  }
  return { wholeTree, byTarget };
}

/**
 * The paths through which the links reach `path`: for each link whose target is `path` or a folder
 * above it, the link's path with the rest of `path` below it, and again through the links that
 * reach those paths. Null when the reach cannot be bounded: a link may reach any path, a chain is
 * longer than MAX_LINK_DEPTH, or there are more than `cap` paths.
 */
export function linkPaths(path: string, index: LinkIndex, cap: number = MAX_LINK_ALIASES): Array<{ path: string; link: string }> | null {
  if (index.wholeTree !== null) return null;
  const out: Array<{ path: string; link: string }> = [];
  const seen = new Set<string>([foldAscii(path)]);
  let frontier = [path];
  for (let hops = 1; frontier.length > 0; hops++) {
    const next: string[] = [];
    for (const current of frontier) {
      const folded = foldAscii(current);
      // The path itself, then each folder above it. foldAscii keeps every offset.
      for (let end = folded.length; end > 0; end = folded.lastIndexOf("/", end - 1)) {
        const reaching = index.byTarget.get(end === folded.length ? folded : folded.slice(0, end));
        if (reaching === undefined) continue;
        const rest = current.slice(end + 1);
        for (const link of reaching) {
          const alias = rest === "" ? link.path : `${link.path}/${rest}`;
          const key = foldAscii(alias);
          if (seen.has(key)) continue;
          if (hops > MAX_LINK_DEPTH) return null;
          seen.add(key);
          out.push({ path: alias, link: link.path });
          if (out.length > cap) return null;
          next.push(alias);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * A path's tier as the plan and the review both count it: the layout's (tierOf), and a path the
 * layout calls D that is not a documentation file, as ci-map.json's docs class defines one, is S
 * (tier D is documentation, EXECUTION §1.7).
 */
export function pathTier(layout: Layout | null, ciMap: CiMap, path: string, classes: readonly CiClass[] = classesOf(ciMap, path)): PathTier {
  const found = tierOf(layout, path);
  if (found.tier === "D" && !classes.some((cls) => cls.name === "docs")) return { tier: "S", source: "not-documentation", entry: found.entry };
  return found;
}

/** One path of a change, with its tier. */
export interface TieredPath {
  readonly path: string;
  readonly status: string;
  /** "new" for the path at head, "old" for the base path of a rename or copy, "link" for a path reached through a symbolic link. */
  readonly side: "new" | "old" | "link";
  readonly link: string | null;
  readonly classes: readonly CiClass[];
  readonly tier: Tier;
  readonly tierSource: TierSource;
}

export interface ChangeTiersInput {
  /** The change; null when it is unknown (every path then counts, and the change is tier S). */
  readonly diff: readonly DiffEntry[] | null;
  readonly layout: Layout | null;
  readonly ciMap: CiMap;
  /** The symbolic links of every tree the change is read against. */
  readonly links: readonly TreeLink[];
  /** True when the change has no single merge base. */
  readonly historyAmbiguous: boolean;
}

export interface ChangeTiers {
  readonly paths: readonly TieredPath[];
  /** The change's tier, the highest of its paths' (S when forced below); null when nothing changed. */
  readonly tier: Tier | null;
  /** A diff entry changed a symbolic link or a submodule. */
  readonly linkChanged: boolean;
  /** What the change reaches through links cannot be bounded. */
  readonly linkOverflow: boolean;
  readonly notes: readonly string[];
}

/**
 * The tiers of a change, one function for the plan and the review (spec 07 §2.4): every path at
 * its tier (pathTier), a changed link or submodule at tier S itself, a path a link reaches also at
 * the link's path; the change is tier S when it is unknown, has no single merge base, changes a
 * link or submodule, or reaches further through links than can be bounded.
 */
export function changeTiers(input: ChangeTiersInput): ChangeTiers {
  const { diff, layout, ciMap, links, historyAmbiguous } = input;
  const notes: string[] = [];
  const changedPaths: Array<{ path: string; status: string; side: "new" | "old" | "link"; link: string | null; isLink: boolean }> = [];
  for (const entry of diff ?? []) {
    const isLink = [entry.oldMode, entry.newMode].some((mode) => mode === SYMLINK_MODE || mode === GITLINK_MODE);
    changedPaths.push({ path: entry.path, status: entry.status, side: "new", link: null, isLink });
    if (entry.oldPath !== null) changedPaths.push({ path: entry.oldPath, status: entry.status, side: "old", link: null, isLink });
  }
  let linkOverflow = false;
  if (links.length > 0 && changedPaths.length > 0) {
    const index = indexLinks(links);
    if (index.wholeTree !== null) {
      linkOverflow = true;
      notes.push(`the symbolic link ${index.wholeTree.path} may reach any path, so what the change reaches cannot be bounded; planning everything at tier S`);
    } else {
      const seen = new Set(changedPaths.map(({ path }) => foldAscii(path)));
      const reached: typeof changedPaths = [];
      let budget = MAX_LINK_ALIASES_TOTAL;
      for (const { path, status } of changedPaths) {
        const aliases = linkPaths(path, index, Math.min(MAX_LINK_ALIASES, budget));
        if (aliases === null) {
          linkOverflow = true;
          notes.push(
            `symbolic links reach ${path} by more paths or longer chains than the plan follows (${MAX_LINK_ALIASES} a path, ${MAX_LINK_ALIASES_TOTAL} a change, ${MAX_LINK_DEPTH} links in a row); planning everything at tier S`,
          );
          break;
        }
        budget -= aliases.length;
        for (const alias of aliases) {
          const key = foldAscii(alias.path);
          if (seen.has(key)) continue;
          seen.add(key);
          reached.push({ path: alias.path, status, side: "link", link: alias.link, isLink: false });
        }
      }
      changedPaths.push(...reached);
    }
  }
  const linkChanged = changedPaths.some((path) => path.isLink);
  let tier: Tier | null = diff === null || historyAmbiguous || linkChanged || linkOverflow ? "S" : null;
  const paths: TieredPath[] = [];
  for (const { path, status, side, link, isLink } of changedPaths) {
    const classes = classesOf(ciMap, path);
    let found: PathTier = pathTier(layout, ciMap, path, classes);
    // A changed link or submodule is tier S itself: what it stands for is not in the diff.
    if (isLink && found.tier !== "S") found = { tier: "S", source: "link", entry: found.entry };
    tier = tier === null ? found.tier : maxTier(tier, found.tier);
    paths.push(Object.freeze({ path, status, side, link, classes, tier: found.tier, tierSource: found.source }));
  }
  return { paths, tier, linkChanged, linkOverflow, notes };
}

/** The union of several diffs, each entry once (a change with several merge bases). */
export function unionOfDiffs(diffs: readonly DiffEntry[][]): DiffEntry[] {
  const seen = new Set<string>();
  const out: DiffEntry[] = [];
  for (const diff of diffs) {
    for (const entry of diff) {
      const key = `${entry.status}\0${entry.oldPath ?? ""}\0${entry.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

/** The deterministic part of the plan, from the git facts. Exported for tests. */
export function assemble(input: AssembleInput): PlanResult {
  const { event, computed, base, head, config, diff, loaded, workspace } = input;
  const { ciMap, ci } = config;
  const layout = loaded.layout;
  const historyAmbiguous = input.historyAmbiguous ?? false;
  const links = input.links ?? [];
  const liveDirs = input.liveDirs ?? new Set(workspace === null ? [] : [...workspace.namesByDir.keys()].map(foldAscii));
  const stalePackageDirs = input.stalePackageDirs ?? [];
  const notes = [...(input.notes ?? [])];

  // Every path of the change with its tier (changeTiers): a rename or copy counts at its old and its
  // new path, and a path a link reaches also counts at the link's path.
  const change = changeTiers({ diff, layout, ciMap, links, historyAmbiguous });
  notes.push(...change.notes);
  const { linkChanged, linkOverflow } = change;

  const tier: Tier | null = change.tier;
  const classSet = new Set<string>();
  const files: PlanFile[] = [];
  const pathClasses: Array<{ path: string; classes: readonly CiClass[]; owners: string[] }> = [];
  // A folder that stopped being a package but still holds files is a non-package folder (§10.2).
  let nonPackageFolder = stalePackageDirs.some((dir) => ci.packageRoots.includes(foldAscii(dir.split("/")[0] ?? "")));

  for (const { path, status, side, link, classes, tier: pathTierValue, tierSource } of change.paths) {
    const pathTier = { tier: pathTierValue, source: tierSource };
    if (classes.length === 0) classSet.add(UNMAPPED);
    for (const cls of classes) classSet.add(cls.name);
    const owners = workspace === null ? [] : ownerNames(workspace, path);
    const top = foldAscii(path.split("/")[0] ?? "");
    if (workspace !== null && ci.packageRoots.includes(top) && ownerDir(workspace, path) === null) nonPackageFolder = true;
    pathClasses.push({ path, classes, owners });
    files.push(
      Object.freeze({
        path,
        status,
        side,
        link,
        tier: pathTier.tier,
        tierSource: pathTier.source,
        classes: Object.freeze(classes.length === 0 ? [UNMAPPED] : classes.map((cls) => cls.name)),
        packages: Object.freeze(owners),
      }),
    );
  }

  const globalHit = pathClasses.some(({ classes }) => classes.some((cls) => cls.everything));
  let reason: Reason = "classes";
  if (!computed) reason = "event";
  else if (historyAmbiguous) reason = "history";
  else if (loaded.status !== "ok") reason = "layout";
  else if (linkChanged || linkOverflow) reason = "link";
  else if (globalHit) reason = "global";
  else if (classSet.has(UNMAPPED)) reason = "unmapped";
  else if (workspace === null || nonPackageFolder) reason = "workspace";
  const everything = reason !== "classes";

  // The e2e apps whose folders are live at the head, by their folded folder.
  const existingE2eApps = ci.e2eApps.filter((dir) => liveDirs.has(foldAscii(dir)));
  const e2eAppByFolded = new Map(existingE2eApps.map((dir) => [foldAscii(dir), dir]));

  const jobs: PlanJobs = {
    check: true,
    db: false,
    build: false,
    seams: false,
    e2e: false,
    e2e_shards: 0,
    static: true,
    bun: false,
    review: false,
    selfTest: false,
    containers: false,
  };
  const e2eDirs = new Set<string>();
  let affected = new Set<string>();
  let allImages = false;

  if (everything) {
    for (const job of ["check", "db", "build", "seams", "e2e", "static", "bun", "containers"] as const) jobs[job] = true;
    for (const dir of existingE2eApps) e2eDirs.add(dir);
    if (workspace !== null) affected = new Set(workspace.dirsByName.keys());
    allImages = true;
  } else if (workspace !== null) {
    for (const job of ciMap.always) setJob(jobs, job);
    const changedNames = new Set<string>();
    for (const { owners } of pathClasses) for (const name of owners) changedNames.add(name);
    affected = dependentsClosure(workspace, changedNames);
    const dirsOf = (names: Iterable<string>): void => {
      for (const name of names) {
        for (const dir of workspace.dirsByName.get(name) ?? []) {
          const app = e2eAppByFolded.get(foldAscii(dir));
          if (app !== undefined) e2eDirs.add(app);
        }
      }
    };
    for (const { path, classes, owners } of pathClasses) {
      for (const cls of classes) {
        for (const job of cls.jobs) if (job !== "e2e") setJob(jobs, job);
        if (cls.name === "docker") allImages = true;
        if (cls.jobs.has("e2e")) {
          const selection = cls.e2e;
          if (selection.kind === "every" || (selection.kind === "affected" && matchesAny(cls.e2eEvery, path))) {
            for (const dir of existingE2eApps) e2eDirs.add(dir);
          } else if (selection.kind === "apps") {
            for (const dir of selection.apps) if (existingE2eApps.includes(dir)) e2eDirs.add(dir);
          } else if (selection.kind === "affected") {
            dirsOf(dependentsClosure(workspace, owners));
          }
        }
        if (cls.dbWhenPackageNeedsDb) {
          for (const owner of owners) {
            if (workspace.withDbTests.has(owner) || dependencyClosure(workspace, owner).has(ci.dbPackage)) jobs.db = true;
          }
        }
      }
      if (matchesAny(ci.bun, path)) jobs.bun = true;
    }
  }
  jobs.e2e = everything || e2eDirs.size > 0;
  jobs.e2e_shards = jobs.e2e ? ci.e2eShards : 0;
  // The engine's paths changed, or may have: a path that is not plain may be one of them on the
  // build machine, and an unbounded link reach may include them.
  const selfTest = SELF_TEST_PATTERNS.map(compileGlob);
  jobs.selfTest = diff === null || linkOverflow || change.paths.some(({ path }) => !isPlainPath(path) || matchesAny(selfTest, path));

  // Images and static outputs: the layout entries of the affected packages whose folders are live
  // at the head (a planned entry's package may not exist yet).
  const images = new Set<string>();
  const statics = new Set<string>();
  const affectedDirs = new Set<string>();
  if (everything) for (const dir of liveDirs) affectedDirs.add(dir);
  else for (const name of affected) for (const dir of workspace?.dirsByName.get(name) ?? []) affectedDirs.add(foldAscii(dir));
  for (const outputs of input.outputLayouts ?? (layout === null ? [] : [layout])) {
    for (const entry of outputs.entries) {
      const key = foldAscii(entry.path);
      if (entry.isRoot || !liveDirs.has(key)) continue;
      const hit = affectedDirs.has(key);
      if (entry.image !== null && (allImages || hit)) images.add(entry.image);
      if (hit) for (const output of entry.static) statics.add(output);
    }
  }

  const apps = ci.e2eApps.filter((dir) => e2eDirs.has(dir)).map((dir) => dir.slice(dir.lastIndexOf("/") + 1));
  const classOrder = [...CLASS_NAMES, UNMAPPED];
  const document: PlanDocument = {
    v: 1,
    event,
    base,
    head,
    tier,
    changed: diff === null ? 0 : diff.length,
    classes: classOrder.filter((name) => classSet.has(name)),
    everything,
    reason,
    jobs,
    e2e: { apps, projects: apps.flatMap((app) => ci.e2eProjects.map((variant) => `${app}-${variant}`)), shards: jobs.e2e_shards },
    packages: workspace === null ? null : sortedNames(affected),
    images: sortedNames(images),
    static: sortedNames(statics),
    layout: loaded.status,
  };
  if (Buffer.byteLength(JSON.stringify(document), "utf8") > MAX_PLAN_BYTES) {
    throw new Error(`the plan document is larger than ${MAX_PLAN_BYTES} bytes`);
  }
  return Object.freeze({
    document,
    files: Object.freeze(files),
    layoutProblems: input.layoutProblems ?? loaded.problems,
    workspaceProblem: input.workspaceProblem,
    notes,
  });
}

function setJob(jobs: PlanJobs, job: JobName): void {
  if (job === "e2e") return;
  jobs[job] = true;
}

/** The one-line form CI appends to $GITHUB_OUTPUT. */
export function planOutputLine(document: PlanDocument): string {
  return `plan=${JSON.stringify(document)}\n`;
}
