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
// (for a pull request, from the base's as well), and only for packages that exist at the head. The
// path classes come from this engine's own config/ci-map.json (the engine copy from main in CI,
// S7-04). The package graph is the union of the base's and the head's manifests.
//
// Links: a changed symbolic link or submodule runs everything at tier S, and a changed path that a
// symbolic link in either tree reaches also counts at the link's path (code reached through a link
// is the link's code). Tier D is documentation (EXECUTION §1.7): a path the layout calls D that is
// not a documentation file, as the docs class of ci-map.json defines it, counts as S.

import { posix } from "node:path";
import type { EngineConfig } from "../config.ts";
import { DataError } from "../errors.ts";
import { GITLINK_MODE, SYMLINK_MODE, diffRaw, existingCommits, isSha, lsTree, mergeBases, readBlobs } from "../git.ts";
import type { DiffEntry, TreeEntry } from "../git.ts";
import { parseJsonBytes } from "../json.ts";
import type { Tier } from "../roles.ts";
import { CLASS_NAMES, UNMAPPED, classesOf } from "./ci-map.ts";
import type { CiClass, JobName } from "./ci-map.ts";
import { compileGlob, matchesAny } from "./glob.ts";
import { maxTier, parseLayout, tierOf } from "./tiers.ts";
import type { Layout, PathTier, TierSource } from "./tiers.ts";
import { buildWorkspace, dependencyClosure, dependentsClosure, manifestDir, manifestEntries, ownerDir, ownerNames } from "./workspace.ts";
import type { Workspace } from "./workspace.ts";

export const LAYOUT_PATH = "tools/layout.json";
export const MAX_PLAN_BYTES = 64 * 1024;
const MAX_LAYOUT_BYTES = 4 << 20;
/** More merge bases than this is no history a pull request has; the plan refuses it. */
const MAX_MERGE_BASES = 64;
/** How many links deep a changed path is followed, and how many link paths one path may have. */
const MAX_LINK_DEPTH = 8;
const MAX_LINK_ALIASES = 64;
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
  /** The images and static outputs (from tools/layout.json) of the affected packages that exist at the head. */
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
  // the code, the checkout included; so may one this cannot read. Each counts as the whole tree.
  if (text === "" || text.includes("\0") || text.includes("\\") || posix.isAbsolute(text)) return "";
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

function unionOfDiffs(diffs: readonly DiffEntry[][]): DiffEntry[] {
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
  const manifests = [...headManifests, ...(baseTree === null ? [] : manifestEntries(baseTree, workspaces))];
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
    headPackageDirs: new Set(headManifests.map(manifestDir)),
    links: [...links.values()],
    notes,
  });
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
  /** The package folders at the head (a package.json there, readable or not); the workspace's when absent. */
  headPackageDirs?: ReadonlySet<string>;
  /** The symbolic links of the base and head trees. */
  links?: readonly TreeLink[];
  notes?: readonly string[];
}

function sortedNames(set: Iterable<string>): string[] {
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Folds ASCII letters only, so the length (and every slice offset) is kept. */
function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * The paths through which the links reach `path`, or null when there are more than the cap.
 * A link to the whole tree reaches every path once; other links are followed up to the depth cap.
 */
export function linkPaths(path: string, links: readonly TreeLink[]): Array<{ path: string; link: string }> | null {
  const out: Array<{ path: string; link: string }> = [];
  const seen = new Set<string>([foldAscii(path)]);
  let frontier = [path];
  for (let depth = 0; depth < MAX_LINK_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      const folded = foldAscii(current);
      for (const link of links) {
        const target = foldAscii(link.target);
        let rest: string | null = null;
        if (target === "") rest = current;
        else if (folded === target) rest = "";
        else if (folded.startsWith(`${target}/`)) rest = current.slice(target.length + 1);
        if (rest === null) continue;
        const alias = rest === "" ? link.path : `${link.path}/${rest}`;
        const key = foldAscii(alias);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path: alias, link: link.path });
        if (out.length > MAX_LINK_ALIASES) return null;
        // Through a link to the whole tree every path is reached once; going round again adds nothing.
        if (target !== "") next.push(alias);
      }
    }
    frontier = next;
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
  const headPackageDirs = input.headPackageDirs ?? new Set(workspace === null ? [] : workspace.namesByDir.keys());

  // Every path of the change: a rename or copy counts at its old and its new path, and a path a
  // link reaches also counts at the link's path.
  const changedPaths: Array<{ path: string; status: string; side: "new" | "old" | "link"; link: string | null }> = [];
  for (const entry of diff ?? []) {
    changedPaths.push({ path: entry.path, status: entry.status, side: "new", link: null });
    if (entry.oldPath !== null) changedPaths.push({ path: entry.oldPath, status: entry.status, side: "old", link: null });
  }
  let linkOverflow = false;
  if (links.length > 0) {
    const seen = new Set(changedPaths.map(({ path }) => foldAscii(path)));
    const reached: typeof changedPaths = [];
    for (const { path, status } of changedPaths) {
      const aliases = linkPaths(path, links);
      if (aliases === null) {
        linkOverflow = true;
        continue;
      }
      for (const alias of aliases) {
        const key = foldAscii(alias.path);
        if (seen.has(key)) continue;
        seen.add(key);
        reached.push({ path: alias.path, status, side: "link", link: alias.link });
      }
    }
    changedPaths.push(...reached);
  }
  const linkChanged = (diff ?? []).some((entry) => [entry.oldMode, entry.newMode].some((mode) => mode === SYMLINK_MODE || mode === GITLINK_MODE));

  let tier: Tier | null = diff === null || historyAmbiguous || linkChanged || linkOverflow ? "S" : null;
  const classSet = new Set<string>();
  const files: PlanFile[] = [];
  const pathClasses: Array<{ path: string; classes: CiClass[]; owners: string[] }> = [];
  let nonPackageFolder = false;

  for (const { path, status, side, link } of changedPaths) {
    const classes = classesOf(ciMap, path);
    let pathTier: PathTier = tierOf(layout, path);
    if (pathTier.tier === "D" && !classes.some((cls) => cls.name === "docs")) {
      pathTier = { tier: "S", source: "not-documentation", entry: pathTier.entry };
    }
    tier = tier === null ? pathTier.tier : maxTier(tier, pathTier.tier);
    if (classes.length === 0) classSet.add(UNMAPPED);
    for (const cls of classes) classSet.add(cls.name);
    const owners = workspace === null ? [] : ownerNames(workspace, path);
    const top = (path.split("/")[0] ?? "").toLowerCase();
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

  // The e2e apps that exist as packages at the head.
  const existingE2eApps = ci.e2eApps.filter((dir) => headPackageDirs.has(dir));
  const appNames = (dirs: readonly string[]): Set<string> => {
    const out = new Set<string>();
    for (const dir of dirs) for (const name of workspace?.namesByDir.get(dir) ?? []) out.add(name);
    return out;
  };

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
    const e2eAppNames = appNames(existingE2eApps);
    const dirsOf = (names: Iterable<string>): void => {
      for (const name of names) {
        if (!e2eAppNames.has(name)) continue;
        for (const dir of workspace.dirsByName.get(name) ?? []) if (existingE2eApps.includes(dir)) e2eDirs.add(dir);
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
  const selfTest = SELF_TEST_PATTERNS.map(compileGlob);
  jobs.selfTest = diff === null || changedPaths.some(({ path }) => matchesAny(selfTest, path));

  // Images and static outputs: the layout entries of the affected packages, for packages that
  // exist at the head (a planned entry's package may not exist yet).
  const images = new Set<string>();
  const statics = new Set<string>();
  const headDirs = new Set([...headPackageDirs].map((dir) => dir.toLowerCase()));
  const affectedDirs = new Set<string>();
  if (everything) for (const dir of headDirs) affectedDirs.add(dir);
  else for (const name of affected) for (const dir of workspace?.dirsByName.get(name) ?? []) affectedDirs.add(dir.toLowerCase());
  for (const outputs of input.outputLayouts ?? (layout === null ? [] : [layout])) {
    for (const entry of outputs.entries) {
      const key = entry.path.toLowerCase();
      if (entry.isRoot || !headDirs.has(key)) continue;
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
    notes: input.notes ?? [],
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
