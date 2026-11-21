// `plan` (spec 07 §2.3.1, §10.1, §10.2; spec 01 §5.3): changed files, tiers, CI path classes, job
// flags and the affected workspace packages, from git and files only.
//
// Inputs are a base and a head SHA (the merge-base diff `base...head`) and the event. Tiers come
// from tools/layout.json as it is at the base, which is main's for a pull request, so a pull
// request that edits the layout cannot lower its own tier; with no base, from the head. The path
// classes come from this engine's own config/ci-map.json (the engine copy from main in CI,
// S7-04). The package graph is the union of the base's and the head's manifests.

import type { EngineConfig } from "../config.ts";
import { DataError } from "../errors.ts";
import { diffNameStatus, existingCommits, isSha, lsTree, readBlobs } from "../git.ts";
import type { DiffEntry, TreeEntry } from "../git.ts";
import { parseJsonBytes } from "../json.ts";
import type { Tier } from "../roles.ts";
import { CLASS_NAMES, UNMAPPED, classesOf } from "./ci-map.ts";
import type { CiClass, JobName } from "./ci-map.ts";
import { matchesAny } from "./glob.ts";
import { maxTier, parseLayout, tierOf } from "./tiers.ts";
import type { Layout, TierSource } from "./tiers.ts";
import { buildWorkspace, dependencyClosure, dependentsClosure, manifestEntries, ownerDir, ownerNames } from "./workspace.ts";
import type { Workspace } from "./workspace.ts";

export const LAYOUT_PATH = "tools/layout.json";
export const MAX_PLAN_BYTES = 64 * 1024;
const MAX_LAYOUT_BYTES = 4 << 20;

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

export type Reason = "event" | "layout" | "global" | "unmapped" | "workspace" | "classes";

export interface PlanJobs {
  check: boolean;
  db: boolean;
  build: boolean;
  seams: boolean;
  e2e: boolean;
  e2e_shards: number;
  static: boolean;
  bun: boolean;
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
  /** The web apps whose e2e projects run (their folder names under apps/), and the shards. */
  e2e: { apps: string[]; shards: number };
  /** The affected workspace packages: those owning changed files and their dependents. */
  packages: string[];
  /** The images and static outputs (from tools/layout.json) of the affected packages. */
  images: string[];
  static: string[];
  /** Whether tools/layout.json was usable; when not, every path is tier S and everything runs. */
  layout: "ok" | "missing" | "invalid";
}

export interface PlanFile {
  readonly path: string;
  readonly status: string;
  /** "new" for the path at head, "old" for the base path of a rename or copy. */
  readonly side: "new" | "old";
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

interface LoadedLayout {
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

  const [diff, headTree, baseTree] = await Promise.all([
    base === null ? Promise.resolve<DiffEntry[] | null>(null) : diffNameStatus(treeDir, base, head, env),
    lsTree(treeDir, head, env),
    base === null ? Promise.resolve<TreeEntry[] | null>(null) : lsTree(treeDir, base, env),
  ]);

  const layoutEntry = findBlob(baseTree ?? headTree, LAYOUT_PATH);
  const manifests = [...manifestEntries(headTree, config.ci.workspaces), ...(baseTree === null ? [] : manifestEntries(baseTree, config.ci.workspaces))];
  const blobs = await readBlobs(treeDir, [...(layoutEntry === null ? [] : [layoutEntry.oid]), ...manifests.map((entry) => entry.oid)], env);

  const loaded = loadLayout(layoutEntry, blobs);
  const sides = [{ tree: headTree, blobs }, ...(baseTree === null ? [] : [{ tree: baseTree, blobs }])];
  const built = buildWorkspace(sides, config.ci.workspaces);
  const workspace: Workspace | null = built.ok ? built.value : null;

  return assemble({
    event,
    computed,
    base,
    head,
    config,
    diff,
    loaded,
    workspace,
    workspaceProblem: built.ok ? null : built.error,
    notes,
  });
}

interface AssembleInput {
  event: string;
  computed: boolean;
  base: string | null;
  head: string;
  config: EngineConfig;
  diff: readonly DiffEntry[] | null;
  loaded: LoadedLayout;
  workspace: Workspace | null;
  workspaceProblem: string | null;
  notes?: readonly string[];
}

function sortedNames(set: Iterable<string>): string[] {
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The deterministic part of the plan, from the git facts. Exported for tests. */
export function assemble(input: AssembleInput): PlanResult {
  const { event, computed, base, head, config, diff, loaded, workspace } = input;
  const { ciMap, ci } = config;
  const layout = loaded.layout;

  // Every path of the change: a rename or copy counts at its old and its new path.
  const changedPaths: Array<{ path: string; status: string; side: "new" | "old" }> = [];
  for (const entry of diff ?? []) {
    changedPaths.push({ path: entry.path, status: entry.status, side: "new" });
    if (entry.oldPath !== null) changedPaths.push({ path: entry.oldPath, status: entry.status, side: "old" });
  }

  let tier: Tier | null = diff === null ? "S" : null;
  const classSet = new Set<string>();
  const files: PlanFile[] = [];
  const pathClasses: Array<{ path: string; classes: CiClass[]; owners: string[] }> = [];
  let nonPackageFolder = false;

  for (const { path, status, side } of changedPaths) {
    const pathTier = tierOf(layout, path);
    tier = tier === null ? pathTier.tier : maxTier(tier, pathTier.tier);
    const classes = classesOf(ciMap, path);
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
  else if (loaded.status !== "ok") reason = "layout";
  else if (globalHit) reason = "global";
  else if (classSet.has(UNMAPPED)) reason = "unmapped";
  else if (workspace === null || nonPackageFolder) reason = "workspace";
  const everything = reason !== "classes";

  // Packages known at the base or the head, and the e2e apps that exist as packages.
  const allNames = workspace === null ? [] : sortedNames(workspace.dirsByName.keys());
  const existingE2eApps = ci.e2eApps.filter((dir) => workspace?.namesByDir.has(dir) === true);
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
    containers: false,
  };
  const e2eDirs = new Set<string>();
  let affected = new Set<string>();
  let allImages = false;

  if (everything) {
    for (const job of ["check", "db", "build", "seams", "e2e", "static", "bun", "containers"] as const) jobs[job] = true;
    for (const dir of existingE2eApps) e2eDirs.add(dir);
    affected = new Set(allNames);
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

  // Images and static outputs, from the layout entries of the affected packages.
  const images = new Set<string>();
  const statics = new Set<string>();
  if (layout !== null) {
    const affectedDirs = new Set<string>();
    for (const name of affected) for (const dir of workspace?.dirsByName.get(name) ?? []) affectedDirs.add(dir.toLowerCase());
    for (const entry of layout.entries) {
      const hit = everything || affectedDirs.has(entry.path.toLowerCase());
      if (entry.image !== null && (allImages || hit)) images.add(entry.image);
      if (hit) for (const output of entry.static) statics.add(output);
    }
  }

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
    e2e: { apps: ci.e2eApps.filter((dir) => e2eDirs.has(dir)).map((dir) => dir.slice(dir.lastIndexOf("/") + 1)), shards: jobs.e2e_shards },
    packages: sortedNames(affected),
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
    layoutProblems: loaded.problems,
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
