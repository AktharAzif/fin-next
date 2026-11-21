// The review modes `pr` and `commit` (spec 07 §2.3.2, §2.3.3), run locally with locked sessions.
//
// A run: read the pull request's facts; fetch its head and base into the mirror; plan the units,
// their tiers and the lenses and attack profiles of the change's tier; check the effort floor
// (exit 64 before any session); read the head's blobs and write them as the tree under
// $FIN_REVIEW_HOME/trees/<run-id> (src/review/tree.ts; exit 65 for paths that cannot be shown as
// they are); run the lens, joins and attack sessions with bounded concurrency, validating every
// output in code; send each validated finding at medium or above to its sceptics as soon as it is
// validated; apply the verdict table; write findings.json, summary.md and result.json under
// runs/<run-id>/; print counts. Unit text, the import graph and every quote check read the blobs,
// never the disk.
//
// Trimmed Phase 0 (docs/review/README.md): no receipts. Coverage that a receipt chain would carry is
// not read, so `pr` reviews every unit of the patch; `commit` takes its last reviewed head from
// `--since` and that head's local run record in runs/, and escalates to `pr` by §2.3.2's rules.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Clock, RandomSource } from "../clock.ts";
import { compactUtc } from "../clock.ts";
import type { EngineConfig } from "../config.ts";
import { EXIT } from "../errors.ts";
import { diffRaw, isSha, lsTree, readBlobs } from "../git.ts";
import type { DiffEntry, TreeEntry } from "../git.ts";
import type { PullFacts } from "../gh.ts";
import { isJsonObject, parseJsonBytes, readJsonFile } from "../json.ts";
import type { ReviewOptions } from "../options.ts";
import { buildGraph, CODE_FILE_RE, exportHeads } from "../plan/graph.ts";
import { linkTarget } from "../plan/plan.ts";
import type { ImportGraph } from "../plan/graph.ts";
import { maxTier, parseLayout, tierOf } from "../plan/tiers.ts";
import type { Layout } from "../plan/tiers.ts";
import { checkFloor, floorViolations, sessionModel } from "../roles.ts";
import type { Role, Tier } from "../roles.ts";
import { RunBudget } from "../budget.ts";
import { packShards } from "../shard.ts";
import type { Shard } from "../shard.ts";
import { blocksCoverage, decodeText, inventory } from "../units/inventory.ts";
import type { Excluded, Unit } from "../units/inventory.ts";
import type { SessionResult, SessionRunner, SessionSpec } from "../runner/types.ts";
import { profilesFor } from "./attack.ts";
import { outputProblem, SEVERITIES, validateOutput } from "./findings.ts";
import type { FileSource, Finding, Quote, Severity, ValidationContext } from "./findings.ts";
import { attackRequired, isLens, requiredLenses } from "./lenses.ts";
import type { Lens } from "./lenses.ts";
import { acquireLock, LockHeldError } from "./lock.ts";
import type { Lock } from "./lock.ts";
import { Pool } from "./pool.ts";
import { ATTACK, checklistIds, sessionSchema } from "./procedure.ts";
import type { AttackProfile, Procedure } from "./procedure.ts";
import { buildContextPack, dataBlock, lensPrompt, numberedFile, PACK_TOKENS, scepticPrompt, secondLookPrompt } from "./prompts.ts";
import { compileSchema } from "./schema.ts";
import type { Refutation } from "./prompts.ts";
import { entryKind, pathTextProblem, TreeError, treeProblems, writeTree } from "./tree.ts";
import type { EntryKind } from "./tree.ts";
import {
  changedLines,
  diffTwoDot,
  ensureMirror,
  fetchPull,
  isAncestor,
  isRefName,
  mergeBase,
  pullBaseRef,
  pullDefaultRef,
  pullHeadRef,
  RemoteError,
  resolveCommit,
  unifiedDiff,
} from "./repo.ts";
import { countFindings, countLines, Lines, summaryMarkdown, writeJson } from "./report.ts";
import type { Blocker, FindingRecord, LensState, OpenBlocker, RunResultName, RunSummary, VerdictRecord } from "./report.ts";
import { combine, severityRank } from "./verdicts.ts";
import type { Verdict } from "./verdicts.ts";

export type Mode = "pr" | "commit";

export interface ReviewRequest {
  readonly mode: Mode;
  readonly pr: number;
  /** `commit`'s last reviewed head (H0). */
  readonly since: string | null;
  readonly options: ReviewOptions;
  readonly advisory: boolean;
}

export interface ReviewDeps {
  readonly config: EngineConfig;
  readonly procedure: Procedure;
  /** The environment git and gh run with. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** $FIN_REVIEW_HOME, created and resolved. */
  readonly home: string;
  readonly originUrl: string;
  readonly facts: (pr: number) => Promise<PullFacts>;
  readonly makeRunner: (run: { readonly runId: string; readonly runDir: string }) => SessionRunner;
  readonly maxSessions: number;
  /** The engine copy's repository root, where the rules lens reads AGENTS.md and CONTRIBUTING.md. */
  readonly engineRoot: string;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly signal?: AbortSignal;
}

/** §2.3.2: a `commit` run stays a delta up to this many changed lines (S7-31). */
export const COMMIT_MAX_LINES = 400;
const MAX_SCAN_BYTES = 1 << 20;
const MAX_DIFF_BYTES = Math.floor(PACK_TOKENS * 3.5 * 0.8);
const RULES_FILES = ["AGENTS.md", "CONTRIBUTING.md"];
const TEST_RE = /\.(?:db\.)?test\.[cm]?[jt]sx?$/;
const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z-pr[0-9]{1,7}-[0-9a-f]{8}$/;

interface ChangedPath {
  readonly path: string;
  readonly status: string;
  readonly side: "new" | "old";
  readonly tier: Tier;
}

interface PriorRun {
  readonly runId: string;
  /** The tier the gating chain recorded at that head. */
  readonly tier: Tier | null;
  readonly result: RunResultName;
  readonly lensNames: readonly string[];
  readonly profiles: readonly string[];
  readonly openBlockers: readonly OpenBlocker[];
  /** The default branch and the merge base the run reviewed from; null in a record that has none. */
  readonly defaultBranch: string | null;
  readonly mergeBase: string | null;
}

interface SessionPlan {
  readonly id: string;
  readonly role: Role;
  readonly lensKey: string;
  readonly lens: string;
  readonly profile: AttackProfile | null;
  readonly shard: number | null;
  readonly units: readonly Unit[];
  readonly prompt: string;
  readonly schema: object;
  readonly checklist: readonly string[];
  readonly allowed: ReadonlySet<string> | null;
  /** Prompt IDs (P1, P2, ...) of the prior blockers shown to this session. */
  readonly priors: ReadonlyMap<string, OpenBlocker>;
}

interface SessionRecord {
  readonly id: string;
  readonly role: Role;
  readonly lensKey: string;
  state: LensState;
  result: Omit<SessionResult, "output"> | null;
  readonly unitIds: readonly string[];
}

// ---- Run state (spec 07 §2.12) -----------------------------------------------------------------

class RunState {
  private readonly path: string;
  private readonly clock: Clock;
  private readonly doc: { v: 1; runId: string; state: string; history: Array<{ state: string; at: string }>; [key: string]: unknown };

  constructor(runDir: string, runId: string, clock: Clock, fields: Record<string, unknown>) {
    this.path = join(runDir, "state.json");
    this.clock = clock;
    this.doc = { v: 1, runId, state: "requested", history: [], ...fields };
    this.to("requested");
  }

  to(state: string, fields: Record<string, unknown> = {}): void {
    Object.assign(this.doc, fields);
    this.doc.state = state;
    this.doc.history.push({ state, at: new Date(this.clock.now()).toISOString() });
    writeJson(this.path, this.doc);
  }
}

// ---- Files of the reviewed tree -----------------------------------------------------------------

/**
 * The head's files from their blobs, by the object IDs of the head's tree (never from the disk, so
 * nothing a checkout or a disk would change reaches a unit or a quote check), and deleted files
 * from the blobs of the side they were deleted from.
 */
class TreeFiles implements FileSource {
  private readonly head: ReadonlyMap<string, TreeEntry>;
  private readonly blobs: ReadonlyMap<string, Buffer>;
  private readonly deleted: ReadonlyMap<string, string>;
  private readonly cache = new Map<string, string | null>();

  constructor(head: ReadonlyMap<string, TreeEntry>, blobs: ReadonlyMap<string, Buffer>, deleted: ReadonlyMap<string, string>) {
    this.head = head;
    this.blobs = blobs;
    this.deleted = deleted;
  }

  has(path: string): boolean {
    return this.head.has(path);
  }

  /** What `path` is at the head: a file, a symbolic link or a submodule; null when it is not there. */
  kind(path: string): EntryKind | null {
    const entry = this.head.get(path);
    return entry === undefined ? null : entryKind(entry);
  }

  /** The bytes of a file or link of the head; only paths the head's tree lists are ever read. */
  bytes(path: string): Buffer | null {
    const entry = this.head.get(path);
    if (entry === undefined || entry.type !== "blob") return null;
    return this.blobs.get(entry.oid) ?? null;
  }

  text(path: string): string | null {
    if (this.cache.has(path)) return this.cache.get(path) ?? null;
    let text: string | null = null;
    const bytes = this.bytes(path);
    if (bytes !== null) text = decodeText(bytes).replace(/\r\n/g, "\n");
    else if (this.deleted.has(path)) text = (this.deleted.get(path) ?? "").replace(/\r\n/g, "\n");
    this.cache.set(path, text);
    return text;
  }
}

/** A changed path that is not a unit, as the lenses are told of it and the run records it. */
interface NonUnit {
  readonly path: string;
  readonly tier: Tier;
  /** Deleted, moved away, or one of inventory()'s reasons, with the verified content. */
  readonly note: string;
  /** True when it blocks as a coverage gap (spec 07 §2.11 rule 6). */
  readonly blocking: boolean;
}

function excludedNote(item: Excluded): string {
  switch (item.reason) {
    case "excluded":
      return `excluded: ${item.content ?? "content"}`;
    case "binary":
      return item.content === null ? "binary, not reviewed" : `binary ${item.content}, never sent to a model`;
    case "missing":
      return "missing from the mirror, not reviewed";
    case "submodule":
      return "a submodule, not reviewed";
    default: {
      const unreachable: never = item.reason;
      throw new TypeError(`unknown reason ${String(unreachable)}`);
    }
  }
}

// ---- Prior run records (the trimmed `commit`'s H0) ----------------------------------------------

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** A run record as `commit` and the carried blockers read it: its head and when it finished, too. */
export interface RunRecord extends PriorRun {
  readonly head: string;
  readonly finishedAt: string;
}

/** Every gating (non-advisory, finished) run record of pull request `pr` in runs/, newest first. */
export function readRunRecords(home: string, pr: number): RunRecord[] {
  const runsDir = join(home, "runs");
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const name of names) {
    if (!RUN_ID_RE.test(name)) continue;
    const read = readJsonFile(join(runsDir, name, "result.json"), 16 << 20);
    if (!read.ok || !isJsonObject(read.value)) continue;
    const doc = read.value;
    const head = doc["head"];
    if (doc["pr"] !== pr || !isSha(head) || doc["advisory"] !== false) continue;
    const result = doc["result"];
    if (result !== "pass" && result !== "blocked" && result !== "could_not_check") continue;
    const tier = doc["tier"];
    const openBlockers: OpenBlocker[] = [];
    for (const item of Array.isArray(doc["openBlockers"]) ? doc["openBlockers"] : []) {
      if (!isJsonObject(item) || typeof item["id"] !== "string" || typeof item["lensKey"] !== "string" || typeof item["lens"] !== "string") continue;
      if (!isJsonObject(item["finding"])) continue;
      const profile = typeof item["profile"] === "string" ? item["profile"] : null;
      openBlockers.push({ id: item["id"], lensKey: item["lensKey"], lens: item["lens"], profile, finding: item["finding"] as unknown as Finding });
    }
    const defaultBranch = doc["defaultBranch"];
    const recordedBase = doc["mergeBase"];
    out.push({
      runId: name,
      head,
      finishedAt: typeof doc["finishedAt"] === "string" ? doc["finishedAt"] : "",
      tier: tier === "S" || tier === "N" || tier === "D" ? tier : null,
      result,
      lensNames: strings(doc["lensNames"]),
      profiles: strings(doc["profiles"]),
      openBlockers,
      defaultBranch: typeof defaultBranch === "string" && isRefName(defaultBranch) ? defaultBranch : null,
      mergeBase: isSha(recordedBase) ? recordedBase : null,
    });
  }
  return out.sort((a, b) => (a.finishedAt !== b.finishedAt ? (a.finishedAt < b.finishedAt ? 1 : -1) : a.runId < b.runId ? 1 : -1));
}

/** The newest gating run record of pull request `pr` at `head` in runs/, or null. */
export function readPriorRun(home: string, pr: number, head: string): RunRecord | null {
  return readRunRecords(home, pr).find((record) => record.head === head) ?? null;
}

// ---- Planning helpers -------------------------------------------------------------------------

function changedPaths(diff: readonly DiffEntry[], layout: Layout | null): ChangedPath[] {
  const out: ChangedPath[] = [];
  for (const entry of diff) {
    out.push({ path: entry.path, status: entry.status, side: "new", tier: tierOf(layout, entry.path).tier });
    if (entry.oldPath !== null) out.push({ path: entry.oldPath, status: entry.status, side: "old", tier: tierOf(layout, entry.oldPath).tier });
  }
  return out;
}

function highestTier(paths: readonly ChangedPath[]): Tier | null {
  let tier: Tier | null = null;
  for (const path of paths) tier = tier === null ? path.tier : maxTier(tier, path.tier);
  return tier;
}

async function layoutAt(mirror: string, sha: string, env: Readonly<Record<string, string | undefined>>): Promise<Layout | null> {
  const tree = await lsTree(mirror, sha, env);
  const entry = tree.find((item) => item.path === "tools/layout.json" && item.type === "blob");
  if (entry === undefined) return null;
  const bytes = (await readBlobs(mirror, [entry.oid], env)).blobs.get(entry.oid);
  if (bytes === undefined) return null;
  const parsed = parseJsonBytes(bytes);
  if (!parsed.ok) return null;
  const layout = parseLayout(parsed.value);
  return layout.ok ? layout.value : null;
}

function sortedUnique(items: Iterable<string>): string[] {
  return [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function readTestsFor(unitPath: string, files: TreeFiles, graph: ImportGraph): string[] {
  if (TEST_RE.test(unitPath)) return [];
  const dir = posix.dirname(unitPath);
  const stem = posix.basename(unitPath).replace(/\.[^.]+$/, "");
  const named = [`${stem}.test.ts`, `${stem}.test.tsx`, `${stem}.db.test.ts`]
    .map((name) => (dir === "." ? name : `${dir}/${name}`))
    .filter((path) => files.has(path));
  const importing = graph
    .importersOf(unitPath)
    .filter((path) => TEST_RE.test(path) && !named.includes(path))
    .slice(0, 3);
  return [...named, ...importing];
}

function readRulesFiles(engineRoot: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const name of RULES_FILES) {
    try {
      const path = join(engineRoot, name);
      if (statSync(path).size > MAX_SCAN_BYTES) continue;
      out.push({ path: name, text: readFileSync(path, "utf8") });
    } catch {
      // Absent in the engine copy: the rules lens records it as a procedure gap.
    }
  }
  return out;
}

function priorBlockData(priors: ReadonlyMap<string, OpenBlocker>): string {
  const list = [...priors].map(([promptId, blocker]) => ({
    id: promptId,
    lens: blocker.finding.lens,
    ...(blocker.finding.profile === undefined ? {} : { profile: blocker.finding.profile }),
    class: blocker.finding.class,
    severity: blocker.finding.severity,
    where: blocker.finding.where,
    quotes: blocker.finding.quotes,
    title: blocker.finding.title,
    claim: blocker.finding.claim,
    scenario: blocker.finding.scenario,
  }));
  return dataBlock(`# Prior blockers\n${JSON.stringify(list, null, 2)}\n`);
}

/** A session's lens state from its result (spec 07 §2.12). */
export function lensStateOf(result: SessionResult): LensState {
  if (result.state === "ok") return "done";
  switch (result.failure) {
    case "model_mismatch":
    case "refusal":
      return "refused";
    case "budget":
      return "budget_reached";
    case "exit":
      return result.failureDetail === "cancelled" ? "cancelled" : "incomplete";
    default:
      return "incomplete";
  }
}

const STATE_ORDER: readonly LensState[] = ["refused", "budget_reached", "incomplete", "cancelled", "pending", "running", "done"];

function worst(states: readonly LensState[]): LensState {
  for (const state of STATE_ORDER) if (states.includes(state)) return state;
  return "done";
}

function quotesProblem(quotes: readonly Quote[], files: FileSource): string | null {
  for (const quote of quotes) {
    if (!isJsonObject(quote) || typeof quote.path !== "string" || typeof quote.text !== "string") return "a quote is not { path, text }";
    const text = files.text(quote.path);
    if (text === null) return "a quote names a path that is not a file of the reviewed tree";
    const wanted = quote.text.replace(/\r\n/g, "\n");
    if (wanted.trim() === "" || !text.includes(wanted)) return `a quote is not an exact substring of ${quote.path}`;
  }
  return null;
}

// ---- The run -----------------------------------------------------------------------------------

/** Runs `pr` or `commit` and returns the exit code (spec 07 §2.1). */
export async function runReview(req: ReviewRequest, deps: ReviewDeps): Promise<number> {
  const { config, procedure, env, home, clock } = deps;
  const startedAt = new Date(clock.now()).toISOString();
  const runId = `${compactUtc(clock.now())}-pr${req.pr}-${deps.random(4).toString("hex")}`;
  const runDir = join(home, "runs", runId);
  mkdirSync(join(runDir, "sessions"), { recursive: true, mode: 0o700 });
  const lines = new Lines(runDir, runId, clock);
  const state = new RunState(runDir, runId, clock, { mode: req.mode, pr: req.pr, options: req.options, advisory: req.advisory });
  const treeDir = join(home, "trees", runId);
  const signal = deps.signal ?? new AbortController().signal;
  /** Exit 65 before any session: the head holds paths the engine cannot show as they are. */
  const refuseTree = (problems: readonly string[]): number => {
    for (const problem of problems) deps.stderr(`fin-review: error: the head cannot be reviewed: ${problem}\n`);
    state.to("refused", { reason: "unsafe_tree" });
    return EXIT.data;
  };
  let lock: Lock | null = null;
  try {
    // ---- planning ----
    state.to("planning");
    let facts: PullFacts;
    let mirror: string;
    let head: string | null;
    let baseTip: string | null;
    let defaultTip: string | null;
    try {
      facts = await deps.facts(req.pr);
      mirror = await ensureMirror(home, deps.originUrl, env);
      await fetchPull(mirror, deps.originUrl, req.pr, facts.baseRef, facts.defaultBranch, env);
      head = await resolveCommit(mirror, pullHeadRef(req.pr), env);
      if (head !== facts.head) {
        // The pull request moved between the two reads; read and fetch once more.
        facts = await deps.facts(req.pr);
        await fetchPull(mirror, deps.originUrl, req.pr, facts.baseRef, facts.defaultBranch, env);
        head = await resolveCommit(mirror, pullHeadRef(req.pr), env);
      }
      baseTip = await resolveCommit(mirror, pullBaseRef(req.pr), env);
      defaultTip = await resolveCommit(mirror, pullDefaultRef(req.pr), env);
    } catch (error) {
      if (!(error instanceof RemoteError)) throw error;
      deps.stderr(`fin-review: unavailable: ${error.message}\n`);
      state.to("failed", { reason: "unavailable" });
      return EXIT.unavailable;
    }
    if (head === null || head !== facts.head || baseTip === null || defaultTip === null) {
      deps.stderr("fin-review: unavailable: the pull request's head moved while it was fetched; run again\n");
      state.to("failed", { reason: "head_moved" });
      return EXIT.unavailable;
    }
    const defaultBranch = facts.defaultBranch;
    try {
      lock = acquireLock(home, req.pr, { runId, head }, clock, (stale, why) => lines.write("review.lock_broken", { staleRunId: stale, why }));
    } catch (error) {
      if (!(error instanceof LockHeldError)) throw error;
      deps.stderr(`fin-review: busy: ${error.message}\n`);
      state.to("refused", { reason: "busy" });
      return EXIT.busy;
    }
    // Tiers and scope come from the default branch, never from the base the pull request names
    // (spec 07 §2.4): the layout is the default branch's, and the change is everything on the head
    // since its merge base with that branch, so a pull request stacked on an unmerged branch is
    // reviewed with the branch's changes and cannot lower its own tier through it.
    const base = await mergeBase(mirror, defaultTip, head, env);
    if (base === null) {
      deps.stderr(`fin-review: error: the pull request's head shares no history with ${defaultBranch}\n`);
      state.to("refused", { reason: "no_merge_base" });
      return EXIT.data;
    }
    if (facts.baseRef !== defaultBranch) {
      deps.stderr(`fin-review: the base is ${facts.baseRef}, not ${defaultBranch}: the run reviews everything on the head since its merge base with ${defaultBranch}\n`);
    }
    const layout = await layoutAt(mirror, defaultTip, env);
    const prDiff = await diffRaw(mirror, base, head, env);

    // `commit`: stay a delta, or escalate to `pr` (§2.3.2).
    let mode: Mode = req.mode;
    let escalated: string | null = null;
    let prior: PriorRun | null = null;
    let scopeDiff: readonly DiffEntry[] = prDiff;
    let deltaFrom: string | null = null;
    if (req.mode === "commit") {
      const since = req.since ?? "";
      const decision = await commitDecision(req, deps, mirror, since, head, layout, { defaultBranch, mergeBase: base });
      if (decision.escalate !== null) {
        mode = "pr";
        escalated = decision.escalate;
      } else {
        prior = decision.prior;
        scopeDiff = decision.delta;
        deltaFrom = since;
      }
    }
    const changed = changedPaths(scopeDiff, layout);
    // The change's own tier picks the lenses; a delta's tier never lowers the gating chain's, so the
    // floor, the budget and the recorded tier use the higher of the two (spec 07 §2.3.2, §2.4).
    const tier = highestTier(changed);
    const gateTier: Tier | null = prior === null ? tier : tier === null ? prior.tier : prior.tier === null ? tier : maxTier(tier, prior.tier);
    const changedAtHead = sortedUnique(scopeDiff.filter((entry) => entry.status !== "D").map((entry) => entry.path));

    // The effort floor ([RV-06]) for a gating run, before any session or checkout.
    if (gateTier !== null) {
      const violations = floorViolations(gateTier, req.options, config.floor, config.models);
      if (violations.length > 0 && !req.advisory) {
        for (const violation of violations) deps.stderr(`fin-review: refused: ${violation.code}: ${violation.message}\n`);
        state.to("refused", { reason: "floor", tier: gateTier });
        return EXIT.usage;
      }
    }
    if (req.advisory) deps.stderr("advisory: not a gate receipt\n");
    if (req.options.fast) deps.stderr("fast: applies to Opus sessions only\n");

    // The head's paths: refused before anything is read or written when one cannot be shown to a
    // session as it is (a control character, a .git segment, two names a disk folds into one).
    const headTree = await lsTree(mirror, head, env);
    const headMap = new Map(headTree.map((entry) => [entry.path, entry]));
    const pathProblems = treeProblems(headTree);
    for (const path of sortedUnique(changed.filter((item) => !headMap.has(item.path)).map((item) => item.path))) {
      const problem = pathTextProblem(path);
      if (problem !== null) pathProblems.push(problem);
    }
    if (pathProblems.length > 0) return refuseTree(pathProblems);

    // The head's blobs, by object ID: the units, the graph and every quote check read them, and
    // the tree the sessions read is written from them.
    const { blobs } = await readBlobs(mirror, headTree.filter((entry) => entry.type === "blob").map((entry) => entry.oid), env);
    const deletedPaths = new Set(changed.filter((path) => !headMap.has(path.path)).map((path) => path.path));
    const deleted = new Map<string, string>();
    if (deletedPaths.size > 0) {
      const baseTree = await lsTree(mirror, deltaFrom ?? base, env);
      const wanted = baseTree.filter((entry) => entry.type === "blob" && deletedPaths.has(entry.path));
      const read = await readBlobs(mirror, wanted.map((entry) => entry.oid), env);
      for (const entry of wanted) {
        const bytes = read.blobs.get(entry.oid);
        if (bytes !== undefined) deleted.set(entry.path, decodeText(bytes));
      }
    }
    rmSync(treeDir, { recursive: true, force: true });
    try {
      writeTree(treeDir, headTree, blobs);
    } catch (error) {
      if (!(error instanceof TreeError)) throw error;
      return refuseTree(error.problems);
    }
    const files = new TreeFiles(headMap, blobs, deleted);
    const codeTexts = new Map<string, string>();
    const manifests = new Map<string, string>();
    for (const entry of headTree) {
      if (entryKind(entry) !== "file" || entry.path.split("/").includes("node_modules")) continue;
      const isManifest = entry.path === "package.json" || entry.path.endsWith("/package.json");
      if (!isManifest && !CODE_FILE_RE.test(entry.path)) continue;
      const bytes = files.bytes(entry.path);
      if (bytes === null || bytes.length > MAX_SCAN_BYTES) continue;
      (isManifest ? manifests : codeTexts).set(entry.path, decodeText(bytes));
    }
    const graph = buildGraph(new Set(headMap.keys()), codeTexts, manifests);

    // Units: every changed path at the head; in a delta, also the files that import them. A path
    // that yields no unit is named to every lens and, when nothing could review it, blocks.
    const unitPaths = new Set(changedAtHead);
    if (mode === "commit") {
      for (const path of changedAtHead) for (const importer of graph.importersOf(path)) if (files.kind(importer) === "file") unitPaths.add(importer);
    }
    const { units, excluded } = inventory(
      sortedUnique(unitPaths).map((path) => ({ path, tier: tierOf(layout, path).tier, kind: files.kind(path) })),
      (path) => files.bytes(path),
      procedure.exclusions,
    );
    const nonUnits: NonUnit[] = [
      ...excluded.map((item) => ({ path: item.path, tier: item.tier, note: excludedNote(item), blocking: blocksCoverage(item) })),
      ...sortedUnique(deletedPaths).map((path) => {
        const item = changed.find((entry) => entry.path === path);
        return { path, tier: item?.tier ?? "S", note: item?.status === "D" ? "deleted" : "moved away", blocking: false };
      }),
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // Lenses and attack profiles of the change's tier, and any lens a prior blocker needs.
    const priorBlockers = prior?.openBlockers ?? [];
    const lensSet = new Set<Lens>(tier === null ? [] : requiredLenses(config.lenses, tier, changed.map((path) => path.path)));
    for (const blocker of priorBlockers) if (blocker.profile === null && isLens(blocker.lens)) lensSet.add(blocker.lens);
    const lenses = [...lensSet];
    const attack = tier !== null && attackRequired(config.lenses, tier);
    const sPaths = sortedUnique(changed.filter((path) => path.tier === "S").map((path) => path.path));
    const profileMap = attack ? profilesFor(procedure.profiles, sPaths) : new Map<string, string[]>();
    for (const blocker of priorBlockers) {
      if (blocker.profile !== null && !profileMap.has(blocker.profile) && procedure.profiles.some((profile) => profile.id === blocker.profile)) {
        profileMap.set(blocker.profile, []);
      }
    }

    // The diffs the sessions see: the patch for joins, and each changed unit's delta in `commit`.
    const patch = await unifiedDiff(mirror, deltaFrom ?? defaultTip, head, deltaFrom === null, MAX_DIFF_BYTES, env);
    const unitDiffs = new Map<string, string>();
    if (deltaFrom !== null) {
      for (const path of changedAtHead) {
        if (!unitPaths.has(path)) continue;
        unitDiffs.set(path, (await unifiedDiff(mirror, deltaFrom, head, false, Math.floor(MAX_DIFF_BYTES / 4), env, [path])).text);
      }
    }

    // ---- sessions ----
    const plans = planSessions({ deps, units, lenses, profileMap, files, graph, changed, nonUnits, deleted, priorBlockers, patch, unitDiffs });
    writeJson(join(runDir, "plan.json"), {
      v: 1,
      runId,
      mode,
      requestedMode: req.mode,
      escalated,
      pr: req.pr,
      head,
      baseRef: facts.baseRef,
      base: baseTip,
      defaultBranch,
      defaultTip,
      mergeBase: base,
      since: req.since,
      tier: gateTier,
      deltaTier: tier,
      changed,
      units: units.map((unit) => ({ id: unit.id, path: unit.path, startLine: unit.startLine, endLine: unit.endLine, tier: unit.tier, kind: unit.kind })),
      excluded,
      notUnits: nonUnits,
      lenses,
      profiles: Object.fromEntries(profileMap),
      sessions: plans.map((plan) => ({ id: plan.id, role: plan.role, lensKey: plan.lensKey, shard: plan.shard, units: plan.units.map((unit) => unit.id) })),
    });
    state.to("planned", { mode, escalated, head, baseRef: facts.baseRef, base: baseTip, defaultBranch, defaultTip, mergeBase: base, tier: gateTier });

    const cap = mode === "commit" ? config.budgets.runUsd.commit : config.budgets.runUsd.pr[gateTier ?? "D"];
    const budget = new RunBudget(cap);
    const runner = deps.makeRunner({ runId, runDir });
    const pool = new Pool(deps.maxSessions);
    const records: SessionRecord[] = [];
    const findings: FindingRecord[] = [];
    const verifications: Array<Promise<void>> = [];
    const priorStatus = new Map<string, "fixed" | "open">();
    let findingCount = 0;
    let verifyCouldNotCheck = false;
    state.to("reviewing");

    const specFor = (role: Role, id: string, extra: { lens?: string; profile?: string; shard?: number }, prompt: string, schema: object): SessionSpec => {
      const model = sessionModel(role, req.options, config.models);
      if (gateTier !== null && !req.advisory && !checkFloor(gateTier, role, model.effort, config.floor).ok) {
        throw new Error(`${role} would start below the effort floor after planning passed it`);
      }
      return {
        id,
        role,
        ...extra,
        modelId: model.modelId,
        effort: model.effort,
        fast: req.options.fast,
        treeDir,
        prompt,
        schema,
        maxTurns: config.budgets.maxTurns[role],
        maxBudgetUsd: config.budgets.sessionUsd[role],
        timeoutMs: config.budgets.timeoutMinutes[role] * 60_000,
      };
    };

    /** Runs one session through the pool and the run budget; null when it never started. */
    const runSession = (record: SessionRecord, spec: SessionSpec, accept: (output: unknown) => string | null): Promise<SessionResult | null> =>
      pool.run(async () => {
        if (signal.aborted) {
          record.state = "cancelled";
          return null;
        }
        if (budget.reached()) {
          record.state = "budget_reached";
          return null;
        }
        record.state = "running";
        const result = await runner.run(spec, signal, accept);
        budget.add(result.costMicroUsd);
        const { output: _output, ...rest } = result;
        record.result = rest;
        record.state = lensStateOf(result);
        writeJson(join(runDir, "sessions", `${spec.id}.result.json`), { ...rest, role: spec.role, lensKey: record.lensKey, state: record.state, maxTurns: spec.maxTurns });
        if (result.failure === "model_mismatch") {
          lines.write("review.model_mismatch", { session: spec.id, role: spec.role, requested: spec.modelId, observed: result.modelObserved });
        } else if (record.state === "refused") {
          lines.write("review.refused", { session: spec.id, role: spec.role, failure: result.failure ?? "" });
        }
        return result;
      });

    const verify = async (rec: FindingRecord, finding: Finding, number: string): Promise<void> => {
      let verdicts: Verdict[] = [];
      let roundVerdicts: VerdictRecord[] = [];
      let round = 1;
      for (;;) {
        const step = combine(finding.severity, verdicts);
        if (step.kind === "outcome") {
          rec.state = step.outcome;
          rec.severity = step.severity;
          return;
        }
        const role: Role = step.kind === "sceptic" ? step.role : "second-look";
        const id = `${role}-f${number}-r${round}`;
        const record: SessionRecord = { id, role, lensKey: `verify:${rec.id}`, state: "pending", result: null, unitIds: [] };
        records.push(record);
        const isSceptic = step.kind === "sceptic";
        const refutations: Refutation[] = roundVerdicts
          .filter((v) => v.verdict === "REFUTED" && v.guarded)
          .map((v) => ({ verdict: v.verdict, guardQuotes: v.guardQuotes, reason: v.reason }));
        const prompt = isSceptic ? scepticPrompt(finding, procedure.scepticPrompt) : secondLookPrompt(finding, refutations, procedure.secondLookPrompt);
        const schema = isSceptic ? procedure.schemas.sceptic : procedure.schemas.secondLook;
        const accept = (output: unknown): string | null => {
          if (!isJsonObject(output)) return "the output is not an object";
          const quotes = isSceptic ? output["guardQuotes"] : output["quotes"];
          return Array.isArray(quotes) ? quotesProblem(quotes as unknown as Quote[], files) : null;
        };
        const result = await runSession(record, specFor(role, id, {}, prompt, schema), accept);
        // A verdict whose quotes failed on both attempts still counts, without its quotes: a
        // refutation without valid guard quotes is UNSURE (§2.9), and a second look's quotes only
        // explain it.
        const usable =
          result !== null &&
          isJsonObject(result.output) &&
          (result.state === "ok" || (result.failure === "schema" && compileSchema(schema)(result.output).length === 0));
        if (result === null || !usable || !isJsonObject(result.output)) {
          // Fail closed: a finding no sceptic could judge stays unverified, which blocks at medium
          // and above; a mismatch or a budget stop also makes the run "could not check".
          rec.state = "unverified";
          rec.verifyIssue = result === null ? `${role} ${record.state}` : `${role} ${record.state}${result.failure === undefined ? "" : ` (${result.failure})`}`;
          if (result === null || result.failure === "model_mismatch" || result.failure === "budget") verifyCouldNotCheck = true;
          return;
        }
        const out = result.output;
        if (isSceptic) {
          const verdict = out["verdict"] as Verdict["verdict"];
          const guardQuotes = Array.isArray(out["guardQuotes"]) ? (out["guardQuotes"] as unknown as Quote[]) : [];
          const severity = SEVERITIES.includes(out["severity"] as Severity) ? (out["severity"] as Severity) : undefined;
          const guarded = verdict === "REFUTED" && guardQuotes.length > 0 && quotesProblem(guardQuotes, files) === null;
          verdicts = [...verdicts, { verdict, guarded, ...(severity === undefined ? {} : { severity }) }];
          const entry: VerdictRecord = {
            role,
            session: id,
            verdict,
            guarded,
            guardQuotes,
            reason: typeof out["reason"] === "string" ? out["reason"] : "",
            ...(severity === undefined ? {} : { severity }),
          };
          rec.verdicts.push(entry);
          roundVerdicts.push(entry);
          continue;
        }
        const look = out["verdict"] === "BROKEN" ? "BROKEN" : "STANDS";
        rec.secondLooks.push({
          session: id,
          verdict: look,
          quotes: Array.isArray(out["quotes"]) ? (out["quotes"] as unknown as Quote[]) : [],
          reason: typeof out["reason"] === "string" ? out["reason"] : "",
        });
        if (look === "STANDS") {
          rec.state = "refuted";
          rec.severity = finding.severity;
          return;
        }
        // Broken: the finding goes through the table once more; broken twice, it stays plausible.
        if (round === 2) {
          rec.state = "plausible";
          rec.severity = finding.severity;
          return;
        }
        round = 2;
        verdicts = [];
        roundVerdicts = [];
      }
    };

    const runLens = async (plan: SessionPlan): Promise<void> => {
      const record: SessionRecord = { id: plan.id, role: plan.role, lensKey: plan.lensKey, state: "pending", result: null, unitIds: plan.units.map((unit) => unit.id) };
      records.push(record);
      const ctx: ValidationContext = { schema: plan.schema, checklist: plan.checklist, allowed: plan.allowed, files };
      const extra: { lens?: string; profile?: string; shard?: number } = {
        lens: plan.lens,
        ...(plan.profile === null ? {} : { profile: plan.profile.id }),
        ...(plan.shard === null ? {} : { shard: plan.shard }),
      };
      const result = await runSession(record, specFor(plan.role, plan.id, extra, plan.prompt, plan.schema), (output) => outputProblem(validateOutput(output, ctx)));
      if (result === null || result.output === undefined) return;
      const validated = validateOutput(result.output, ctx);
      for (const check of validated.findings) {
        findingCount++;
        const number = String(findingCount).padStart(3, "0");
        const finding = check.finding as Finding;
        const firstPath = check.ok ? finding.where[0]?.path : undefined;
        const rec: FindingRecord = {
          id: `F-${runId}-${number}`,
          session: plan.id,
          lensKey: plan.lensKey,
          state: check.ok ? "kept" : "invalid",
          problems: check.problems,
          finding: check.finding,
          reportedSeverity: check.ok ? finding.severity : null,
          severity: check.ok ? finding.severity : null,
          tier: firstPath === undefined ? null : tierOf(layout, firstPath).tier,
          verdicts: [],
          secondLooks: [],
          verifyIssue: null,
          blocking: false,
          blockingRule: null,
        };
        findings.push(rec);
        if (!check.ok) continue;
        // Streaming (§2.9): a finding's sceptics start as soon as it is validated.
        if (severityRank(finding.severity) >= severityRank("medium")) verifications.push(verify(rec, finding, number));
        else {
          rec.state = "unverified";
          rec.verifyIssue = "low findings get no sceptic in this slice";
        }
      }
      for (const check of validated.prior) {
        const blocker = plan.priors.get(check.id);
        if (blocker !== undefined && check.status === "fixed" && check.problems.length === 0) priorStatus.set(blocker.id, "fixed");
      }
    };

    // Every session settles before the outcome (or an error) is reported, so none outlives the tree.
    const lensRuns = await Promise.allSettled(plans.map((plan) => runLens(plan)));
    state.to("verifying");
    const verifyRuns = await Promise.allSettled(verifications);
    for (const run of [...lensRuns, ...verifyRuns]) if (run.status === "rejected") throw run.reason;

    // ---- outcome (§2.11) ----
    const lensKeys = sortedUnique(plans.map((plan) => plan.lensKey));
    const lensStates: Record<string, LensState> = {};
    for (const key of lensKeys) lensStates[key] = worst(records.filter((record) => record.lensKey === key).map((record) => record.state));
    const blockers: Blocker[] = [];
    for (const rec of findings) {
      if (rec.state === "invalid" || rec.state === "refuted" || rec.severity === null) continue;
      const finding = rec.finding as Finding;
      const rank = severityRank(rec.severity);
      let rule: Blocker["rule"] | null = null;
      if (rec.state === "confirmed" && rank >= severityRank("medium")) rule = "confirmed";
      else if (rec.state === "plausible" && rank >= severityRank("high")) rule = "plausible";
      else if ((rec.state === "unverified" || rec.state === "kept") && rank >= severityRank("medium")) rule = "unverified";
      else if (finding.class === "test-cannot-fail" && rec.tier === "S") rule = "test-cannot-fail";
      if (rule !== null) {
        rec.blocking = true;
        rec.blockingRule = rule;
        blockers.push({ rule, finding: rec.id, detail: `${rec.state} ${rec.severity}` });
      }
    }
    for (const key of lensKeys) {
      const lensState = lensStates[key] ?? "pending";
      if (lensState !== "done") blockers.push({ rule: "lens", lens: key, detail: `the ${key} lens is ${lensState}` });
    }
    for (const plan of plans) {
      const record = records.find((item) => item.id === plan.id);
      if (record !== undefined && record.state !== "done" && plan.units.length > 0) {
        blockers.push({ rule: "coverage", lens: plan.lensKey, detail: `${plan.units.length} units not covered by ${plan.lensKey} (session ${plan.id})` });
      }
    }
    // A changed path no lens could read (binary, a submodule, missing) is a coverage gap too.
    for (const item of nonUnits) {
      if (item.blocking) blockers.push({ rule: "coverage", path: item.path, detail: `${item.path} changed and no lens could review it (${item.note}; tier ${item.tier})` });
    }
    const stillOpen = priorBlockers.filter((blocker) => priorStatus.get(blocker.id) !== "fixed");
    for (const blocker of stillOpen) blockers.push({ rule: "prior", finding: blocker.id, lens: blocker.lensKey, detail: "a blocker open at the last reviewed head is not shown fixed" });

    const couldNotCheck = lensKeys.some((key) => lensStates[key] !== "done") || verifyCouldNotCheck;
    const result: RunResultName = couldNotCheck ? "could_not_check" : blockers.length > 0 ? "blocked" : "pass";
    const exitCode = result === "pass" ? EXIT.pass : result === "blocked" ? EXIT.blocked : EXIT.couldNotCheck;
    const openBlockers: OpenBlocker[] = [
      ...findings
        .filter((rec) => rec.blocking)
        .map((rec) => {
          const finding = rec.finding as Finding;
          return { id: rec.id, lensKey: rec.lensKey, lens: finding.lens, profile: finding.profile ?? null, finding };
        }),
      ...stillOpen,
    ];
    const sessionCount = records.filter((record) => record.result !== null).length;
    const summary: RunSummary = {
      v: 1,
      runId,
      mode,
      requestedMode: req.mode,
      escalated,
      since: req.since,
      pr: req.pr,
      head,
      baseRef: facts.baseRef,
      base: baseTip,
      defaultBranch,
      defaultTip,
      mergeBase: base,
      tier: gateTier,
      deltaTier: tier,
      result,
      exitCode,
      advisory: req.advisory,
      options: req.options,
      lenses: lensStates,
      lensNames: lenses,
      profiles: [...profileMap.keys()],
      counts: countFindings(findings, lensStates, units.length, sessionCount, blockers.length),
      notUnits: nonUnits,
      blockers,
      openBlockers,
      sessions: sessionCount,
      costMicroUsd: budget.spentMicroUsd,
      startedAt,
      finishedAt: new Date(clock.now()).toISOString(),
    };
    writeJson(join(runDir, "findings.json"), {
      v: 1,
      runId,
      findings,
      priorBlockers: priorBlockers.map((blocker) => ({ id: blocker.id, status: priorStatus.get(blocker.id) ?? "open" })),
    });
    writeJson(join(runDir, "sessions.json"), { v: 1, runId, sessions: records });
    writeJson(join(runDir, "result.json"), summary);
    writeFileSync(join(runDir, "summary.md"), summaryMarkdown(summary, findings), { mode: 0o600 });
    lines.write("review.run", { mode, pr: req.pr, tier: gateTier, result, sessions: sessionCount, costMicroUsd: budget.spentMicroUsd, findings: summary.counts.findings, blockers: blockers.length });
    state.to("done", { result });
    deps.stdout(countLines(summary));
    return exitCode;
  } catch (error) {
    state.to("failed", { reason: "internal" });
    throw error;
  } finally {
    lock?.release();
    rmSync(treeDir, { recursive: true, force: true });
  }
}

// ---- commit: stay a delta or escalate (§2.3.2) ---------------------------------------------------

type CommitDecision = { escalate: string; prior: null; delta: readonly DiffEntry[] } | { escalate: null; prior: PriorRun; delta: readonly DiffEntry[] };

/** The scope a run reviews from: the default branch and the head's merge base with it. */
interface Scope {
  readonly defaultBranch: string;
  readonly mergeBase: string;
}

async function commitDecision(
  req: ReviewRequest,
  deps: ReviewDeps,
  mirror: string,
  since: string,
  head: string,
  layout: Layout | null,
  scope: Scope,
): Promise<CommitDecision> {
  const { env, config, procedure } = deps;
  const escalate = (reason: string): CommitDecision => ({ escalate: reason, prior: null, delta: [] });
  const prior = readPriorRun(deps.home, req.pr, since);
  if (prior === null) return escalate("no_prior_run");
  if (!isSha(since) || (await resolveCommit(mirror, since, env)) === null || !(await isAncestor(mirror, since, head, env))) return escalate("not_ancestor");
  // The prior run must have reviewed from the same branch and from a merge base this one still
  // contains; otherwise what lies between the two bases was never reviewed with the head.
  if (prior.defaultBranch !== scope.defaultBranch || prior.mergeBase === null || (await resolveCommit(mirror, prior.mergeBase, env)) === null) return escalate("base_changed");
  if (prior.mergeBase !== scope.mergeBase && !(await isAncestor(mirror, prior.mergeBase, scope.mergeBase, env))) return escalate("base_changed");
  if ((await changedLines(mirror, since, head, env)) > COMMIT_MAX_LINES) return escalate("delta_lines");
  const delta = await diffTwoDot(mirror, since, head, env);
  const changed = changedPaths(delta, layout);
  const tier = highestTier(changed);
  if (tier !== null && (prior.tier === null || maxTier(tier, prior.tier) !== prior.tier)) return escalate("tier_raised");
  if (tier !== null) {
    const lenses = requiredLenses(config.lenses, tier, changed.map((path) => path.path));
    if (lenses.some((lens) => !prior.lensNames.includes(lens))) return escalate("new_lens");
    if (attackRequired(config.lenses, tier)) {
      const profiles = profilesFor(procedure.profiles, sortedUnique(changed.filter((path) => path.tier === "S").map((path) => path.path)));
      if ([...profiles.keys()].some((profile) => !prior.profiles.includes(profile))) return escalate("new_profile");
    }
  }
  if (prior.result === "could_not_check") return escalate("prior_could_not_check");
  return { escalate: null, prior, delta };
}

// ---- Session plans -------------------------------------------------------------------------------

interface PlanInput {
  readonly deps: ReviewDeps;
  readonly units: readonly Unit[];
  readonly lenses: readonly Lens[];
  readonly profileMap: ReadonlyMap<string, readonly string[]>;
  readonly files: TreeFiles;
  readonly graph: ImportGraph;
  readonly changed: readonly ChangedPath[];
  /** The changed paths that are not units, each with why; every pack names them. */
  readonly nonUnits: readonly NonUnit[];
  /** The text of each deleted path as it was before the change. */
  readonly deleted: ReadonlyMap<string, string>;
  readonly priorBlockers: readonly OpenBlocker[];
  readonly patch: { readonly text: string; readonly truncated: boolean };
  /** `commit` only: each changed unit's diff since the last reviewed head. */
  readonly unitDiffs: ReadonlyMap<string, string>;
}

/** The changed paths that are not units, so no lens is told less of the change than it holds. */
function nonUnitNote(nonUnits: readonly NonUnit[]): string {
  if (nonUnits.length === 0) return "";
  const lines = nonUnits.map((item) => `- ${item.path} (${item.note}; tier ${item.tier})`);
  return `\n# Changed paths with no unit text\nThese paths changed but are not units of this run. A deleted path is in the patch; a path still in the tree can be read with your tools.\n${lines.join("\n")}\n`;
}

function shardPack(units: readonly Unit[], input: PlanInput): { evidence: string; allowed: Set<string> } {
  const { files, graph } = input;
  const paths = sortedUnique(units.map((unit) => unit.path));
  // A symbolic link's target is one hop from it, so the lens sees what the link now stands for.
  const linkTargets = units
    .filter((unit) => unit.kind === "link")
    .map((unit) => linkTarget(unit.path, files.bytes(unit.path) ?? undefined))
    .filter((target) => target !== "" && files.has(target));
  const tests = sortedUnique(paths.flatMap((path) => readTestsFor(path, files, graph))).filter((path) => !paths.includes(path));
  const oneHop = sortedUnique([...paths.flatMap((path) => [...graph.importsOf(path), ...graph.importersOf(path)]), ...linkTargets]).filter((path) => !paths.includes(path));
  const pack = buildContextPack({
    units,
    tests: tests.map((path) => ({ path, text: files.text(path) ?? "" })),
    heads: oneHop.map((path) => ({ path, lines: exportHeads(files.text(path) ?? "") })),
    oneHop,
    digest: input.deps.procedure.rulesDigest,
    diffs: paths.filter((path) => input.unitDiffs.has(path)).map((path) => ({ path, text: input.unitDiffs.get(path) ?? "" })),
  });
  const allowed = new Set<string>([...paths, ...tests, ...oneHop]);
  for (const item of input.nonUnits) if (files.text(item.path) !== null) allowed.add(item.path);
  return { evidence: dataBlock(`${pack.content}${nonUnitNote(input.nonUnits)}`), allowed };
}

const MAX_DELETED_TESTS_BYTES = 200 * 1024;

/** For test-truth: every test the change deletes, numbered as it was, so a removed guard is seen. */
function deletedTestsBlock(input: PlanInput): string | null {
  const paths = sortedUnique([...input.deleted.keys()].filter((path) => TEST_RE.test(path)));
  if (paths.length === 0) return null;
  const parts: string[] = [];
  let used = 0;
  for (const path of paths) {
    const file = numberedFile(input.files.text(path) ?? "");
    const part = `# Deleted test ${path} (lines 1-${file.lines} of ${file.lines}, as it was before this change)\n${file.text}\n`;
    const size = Buffer.byteLength(part, "utf8");
    if (used + size > MAX_DELETED_TESTS_BYTES) {
      parts.push(`# Deleted test ${path} (too long to show here; it is in the patch)\n`);
      continue;
    }
    used += size;
    parts.push(part);
  }
  return dataBlock(`# Tests this change deletes\n${parts.join("\n")}`);
}

function joinsEvidence(input: PlanInput): string {
  const paths = input.changed.map((path) => `- ${path.path} (${path.status}, ${path.side === "old" ? "old path" : "at head"}, tier ${path.tier})`);
  const cut = input.patch.truncated ? " (cut at the context budget: read the files with your tools)" : "";
  return dataBlock(`# The patch\nChanged paths:\n${paths.join("\n")}\n\n# Unified diff${cut}\n${input.patch.text}\n`);
}

function planSessions(input: PlanInput): SessionPlan[] {
  const { deps, units, lenses, profileMap, priorBlockers } = input;
  const { procedure } = deps;
  const shards = packShards(units);
  const plans: SessionPlan[] = [];
  const shardPacks = new Map<number, { evidence: string; allowed: Set<string> }>();
  const packFor = (shard: Shard): { evidence: string; allowed: Set<string> } => {
    let pack = shardPacks.get(shard.index);
    if (pack === undefined) shardPacks.set(shard.index, (pack = shardPack(shard.units, input)));
    return pack;
  };
  const deletedTests = deletedTestsBlock(input);
  const rulesFiles = readRulesFiles(deps.engineRoot);
  const rulesBlock = dataBlock(
    rulesFiles.length === 0
      ? "# Rules files\nThe engine copy has no AGENTS.md or CONTRIBUTING.md.\n"
      : rulesFiles.map((file) => `# Rules file ${file.path} (from the engine copy)\n${file.text}\n`).join("\n"),
  );
  const priorsFor = (lensKey: string): Map<string, OpenBlocker> => {
    const map = new Map<string, OpenBlocker>();
    for (const blocker of priorBlockers) if (blocker.lensKey === lensKey) map.set(`P${map.size + 1}`, blocker);
    return map;
  };
  const make = (opts: {
    lens: string;
    lensKey: string;
    role: Role;
    id: string;
    shard: Shard | null;
    evidence: string;
    allowed: ReadonlySet<string> | null;
    profile: AttackProfile | null;
    extraBlocks: readonly string[];
    showPriors: boolean;
  }): SessionPlan => {
    const checklistKey = opts.profile === null ? opts.lens : ATTACK;
    const items = procedure.checklists.get(checklistKey) ?? [];
    const priors = opts.showPriors ? priorsFor(opts.lensKey) : new Map<string, OpenBlocker>();
    const lensName = opts.profile === null ? opts.lens : ATTACK;
    const instruction = opts.profile === null ? (procedure.lensPrompts.get(opts.lens as Lens) ?? "") : procedure.attackPrompt;
    const prompt = lensPrompt({
      evidence: opts.evidence,
      extra: [...opts.extraBlocks, ...(priors.size > 0 ? [priorBlockData(priors)] : [])],
      instruction,
      lens: lensName,
      checklist: items,
      priorIds: [...priors.keys()],
      ...(opts.profile === null ? {} : { profile: opts.profile }),
    });
    const schema = sessionSchema(procedure, lensName, opts.profile?.id ?? null, checklistIds(procedure, checklistKey), [...priors.keys()]);
    return {
      id: opts.id,
      role: opts.role,
      lensKey: opts.lensKey,
      lens: lensName,
      profile: opts.profile,
      shard: opts.shard?.index ?? null,
      units: opts.shard?.units ?? [],
      prompt,
      schema,
      checklist: items.map((item) => item.id),
      allowed: opts.allowed,
      priors,
    };
  };

  for (const lens of lenses) {
    if (lens === "joins") continue;
    const role: Role = lens === "test-truth" ? "test-truth" : "lens";
    const extraBlocks = lens === "rules" ? [rulesBlock] : lens === "test-truth" && deletedTests !== null ? [deletedTests] : [];
    if (shards.length === 0) {
      // No units (only deletions or files no lens is sent): one session over the changed paths,
      // so the lens still runs and any prior blocker of it is still shown.
      const pack = shardPack([], input);
      plans.push(make({ lens, lensKey: lens, role, id: `${lens}-s0`, shard: null, evidence: pack.evidence, allowed: pack.allowed, profile: null, extraBlocks, showPriors: true }));
      continue;
    }
    for (const shard of shards) {
      const pack = packFor(shard);
      plans.push(make({ lens, lensKey: lens, role, id: `${lens}-s${shard.index}`, shard, evidence: pack.evidence, allowed: pack.allowed, profile: null, extraBlocks, showPriors: shard.index === 0 }));
    }
  }
  if (lenses.includes("joins")) {
    plans.push(make({ lens: "joins", lensKey: "joins", role: "joins", id: "joins", shard: null, evidence: joinsEvidence(input), allowed: null, profile: null, extraBlocks: [], showPriors: true }));
  }
  for (const [profileId, paths] of profileMap) {
    const profile = procedure.profiles.find((item) => item.id === profileId);
    if (profile === undefined) continue;
    const lensKey = `${ATTACK}:${profileId}`;
    const profileShards = packShards(units.filter((unit) => paths.includes(unit.path)));
    if (profileShards.length === 0) {
      const pack = shardPack([], input);
      plans.push(make({ lens: ATTACK, lensKey, role: "attack", id: `attack-${profileId}-s0`, shard: null, evidence: pack.evidence, allowed: null, profile, extraBlocks: [], showPriors: true }));
      continue;
    }
    for (const shard of profileShards) {
      const pack = shardPack(shard.units, input);
      plans.push(make({ lens: ATTACK, lensKey, role: "attack", id: `attack-${profileId}-s${shard.index}`, shard, evidence: pack.evidence, allowed: null, profile, extraBlocks: [], showPriors: shard.index === 0 }));
    }
  }
  return plans;
}
