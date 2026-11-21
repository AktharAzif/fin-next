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
import { DataError, EXIT } from "../errors.ts";
import { diffRaw, isSha, lsTree, mergeBases, readBlobs, SYMLINK_MODE } from "../git.ts";
import type { DiffEntry, TreeEntry } from "../git.ts";
import type { PullFacts } from "../gh.ts";
import { isJsonObject, parseJsonBytes, readJsonFile } from "../json.ts";
import type { ReviewOptions } from "../options.ts";
import { buildGraph, CODE_FILE_RE, exportHeads } from "../plan/graph.ts";
import { changeTiers, linkTarget, pathTier, unionOfDiffs } from "../plan/plan.ts";
import type { TreeLink } from "../plan/plan.ts";
import type { CiMap } from "../plan/ci-map.ts";
import type { ImportGraph } from "../plan/graph.ts";
import { maxTier, parseLayout } from "../plan/tiers.ts";
import type { Layout } from "../plan/tiers.ts";
import type { TransportKind } from "../transport.ts";
import { checkFloor, floorViolations, sessionModel } from "../roles.ts";
import type { Role, Tier } from "../roles.ts";
import { RunBudget } from "../budget.ts";
import { packShards } from "../shard.ts";
import type { Shard } from "../shard.ts";
import { blocksCoverage, decodeText, inventory } from "../units/inventory.ts";
import type { Excluded, Unit } from "../units/inventory.ts";
import { MAX_PROMPT_BYTES } from "../runner/cli.ts";
import type { SessionResult, SessionRunner, SessionSpec } from "../runner/types.ts";
import { profilesFor } from "./attack.ts";
import { outputProblem, SEVERITIES, validateOutput } from "./findings.ts";
import type { FileSource, Finding, FixScope, PriorCheck, Quote, Severity, ValidationContext, Where } from "./findings.ts";
import { attackRequired, isLens, requiredLenses } from "./lenses.ts";
import type { Lens } from "./lenses.ts";
import { acquireLock, LockHeldError } from "./lock.ts";
import type { Lock } from "./lock.ts";
import { Pool } from "./pool.ts";
import { ATTACK, checklistIds, sessionSchema } from "./procedure.ts";
import type { AttackProfile, Procedure } from "./procedure.ts";
import { buildContextPack, dataBlock, fixCheckPrompt, lensPrompt, numberedFile, PACK_TOKENS, scepticPrompt, secondLookPrompt } from "./prompts.ts";
import { compileSchema } from "./schema.ts";
import type { Refutation } from "./prompts.ts";
import type { EngineCopy, EngineCopyInput } from "./engine-copy.ts";
import { filterFreeText, filterText } from "./injection.ts";
import { entryKind, pathTextProblem, TreeError, treeProblems, writeTree } from "./tree.ts";
import type { EntryKind } from "./tree.ts";
import {
  changedLineNumbers,
  changedLines,
  diffTwoDot,
  ensureMirror,
  fetchPull,
  isAncestor,
  isRefName,
  pullBaseRef,
  pullDefaultRef,
  pullHeadRef,
  RemoteError,
  resolveCommit,
  unifiedDiff,
} from "./repo.ts";
import { countFindings, countLines, Lines, summaryMarkdown, writeJson } from "./report.ts";
import type { Blocker, FindingRecord, LensState, OpenBlocker, RunOutcomeName, RunResultName, RunSummary, VerdictRecord } from "./report.ts";
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
  /** How the sessions reach Claude (src/transport.ts), recorded in every run; direct when absent. */
  readonly transport?: TransportKind;
  readonly facts: (pr: number) => Promise<PullFacts>;
  readonly makeRunner: (run: { readonly runId: string; readonly runDir: string }) => SessionRunner;
  readonly maxSessions: number;
  /** The engine copy's repository root, where the rules lens reads AGENTS.md and CONTRIBUTING.md. */
  readonly engineRoot: string;
  /** Whether the engine that runs is the default branch's engine copy (src/review/engine-copy.ts). */
  readonly engineCopy: (input: EngineCopyInput) => Promise<EngineCopy>;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly signal?: AbortSignal;
}

/** §2.3.2: a `commit` run stays a delta up to this many changed lines (S7-31). */
export const COMMIT_MAX_LINES = 400;
/** More merge bases than this is no history a pull request has (as plan.ts refuses it). */
const MAX_MERGE_BASES = 64;
const MAX_SCAN_BYTES = 1 << 20;
const MAX_DIFF_BYTES = Math.floor(PACK_TOKENS * 3.5 * 0.8);
const RULES_FILES = ["AGENTS.md", "CONTRIBUTING.md"];
const TEST_RE = /\.(?:db\.)?test\.[cm]?[jt]sx?$/;
const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z-pr[0-9]{1,7}-[0-9a-f]{8}$/;

interface ChangedPath {
  readonly path: string;
  readonly status: string;
  /** "link" for a path a symbolic link reaches (it counts at the link's path; it is no file of the head). */
  readonly side: "new" | "old" | "link";
  readonly link: string | null;
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
  /**
   * The blockers that run left open that are no finding: a changed path no lens could review, or a
   * lens that was not done. No delta can show one resolved, so a `commit` after it escalates.
   */
  readonly openGaps: number;
  /** The default branch and the merge base the run reviewed from; null in a record that has none. */
  readonly defaultBranch: string | null;
  readonly mergeBase: string | null;
  /** The procedure hash of the engine that ran (spec 07 §4.8); null in a record that has none. */
  readonly procedureHash: string | null;
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
  /** For each prompt ID, where a fix of that blocker may be quoted (its tied files and their changed lines). */
  readonly fixScopes: ReadonlyMap<string, FixScope>;
}

/** One sceptic's answer in a prior blocker's fix check (findings.json). */
interface FixCheckRecord {
  readonly role: Role;
  readonly session: string;
  /** CONFIRMED (the defect is still there), REFUTED or UNSURE; null when the session gave no usable answer. */
  readonly verdict: string | null;
  /** True for a refutation whose guard quotes are exact substrings of the head's files. */
  readonly guarded: boolean;
  readonly guardQuotes: readonly Quote[];
  readonly reason: string;
  readonly issue?: string;
}

/** What the lens shown a prior blocker said of it, and what came of it (findings.json). */
interface PriorClaim {
  readonly session: string;
  /** What the lens answered: `fixed` or `open` (silence records no claim). */
  readonly said: "fixed" | "open";
  /** Why the engine could not take a `fixed` claim, which leaves the blocker open. */
  readonly notAccepted: readonly string[];
  readonly fixWhere?: Where;
  readonly fixQuote?: Quote;
  /** open (the lens said so), not_accepted, checking, fixed, still_there, unsure or unchecked. */
  outcome: "open" | "not_accepted" | "checking" | "fixed" | "still_there" | "unsure" | "unchecked";
  readonly checks: FixCheckRecord[];
}

function claimOf(session: string, check: PriorCheck): PriorClaim {
  const said = check.status === "fixed" || check.notAccepted.length > 0 ? "fixed" : "open";
  return {
    session,
    said,
    notAccepted: check.notAccepted,
    ...(check.fixWhere === undefined ? {} : { fixWhere: check.fixWhere }),
    ...(check.fixQuote === undefined ? {} : { fixQuote: check.fixQuote }),
    outcome: check.notAccepted.length > 0 ? "not_accepted" : said === "fixed" ? "checking" : "open",
    checks: [],
  };
}

/** Why a prior blocker the run carried is still open, for its blocker's detail. */
function stillOpenDetail(claim: PriorClaim | undefined): string {
  switch (claim?.outcome) {
    case undefined:
    case "open":
      return "a blocker open at the last reviewed head is not shown fixed";
    case "not_accepted":
      return "a blocker open at the last reviewed head is claimed fixed, but the claim cannot be accepted";
    case "still_there":
      return "a blocker open at the last reviewed head is claimed fixed, and its fix check found the defect still there";
    case "unsure":
      return "a blocker open at the last reviewed head is claimed fixed, and its fix check could not confirm the fix";
    default:
      return "a blocker open at the last reviewed head is claimed fixed, and its fix check did not finish";
  }
}

interface SessionRecord {
  readonly id: string;
  readonly role: Role;
  readonly lensKey: string;
  state: LensState;
  result: Omit<SessionResult, "output"> | null;
  /** Why a session was never started, when it was not. */
  detail?: string;
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
      return item.looksLike === undefined ? "binary, not reviewed" : `binary, not reviewed (its bytes start like ${item.looksLike === "image" ? "an image" : "a font"}, but its name is not one)`;
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

/** The blocker rules that name no finding: a coverage gap and a lens that was not done. */
const GAP_RULES: ReadonlySet<string> = new Set(["coverage", "lens"]);
/** The blocker rules a record may hold; any other value is read as a gap (fail closed). */
const KNOWN_RULES: ReadonlySet<string> = new Set(["confirmed", "plausible", "lens", "test-cannot-fail", "coverage", "unverified", "prior"]);

/**
 * How many blockers a run record left open that are no finding (spec 07 §2.11 rules 3 and 6). A
 * record that is not a pass but lists no readable blockers counts as one: what it left open is unknown.
 */
function openGapsOf(doc: Record<string, unknown>): number {
  const blockers = doc["blockers"];
  if (!Array.isArray(blockers)) return doc["result"] === "pass" ? 0 : 1;
  let gaps = 0;
  for (const blocker of blockers) {
    const rule = isJsonObject(blocker) ? blocker["rule"] : undefined;
    if (typeof rule !== "string" || !KNOWN_RULES.has(rule) || GAP_RULES.has(rule)) gaps++;
  }
  return gaps;
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
      // A record that does not say where a blocker was found gives the run's own head: a fix must
      // then change something since that head.
      const foundAt = isSha(item["foundAt"]) ? item["foundAt"] : head;
      openBlockers.push({ id: item["id"], lensKey: item["lensKey"], lens: item["lens"], profile, finding: item["finding"] as unknown as Finding, foundAt });
    }
    const defaultBranch = doc["defaultBranch"];
    const recordedBase = doc["mergeBase"];
    const engine = doc["engine"];
    const hash = isJsonObject(engine) ? engine["procedureHash"] : undefined;
    out.push({
      runId: name,
      head,
      finishedAt: typeof doc["finishedAt"] === "string" ? doc["finishedAt"] : "",
      tier: tier === "S" || tier === "N" || tier === "D" ? tier : null,
      result,
      lensNames: strings(doc["lensNames"]),
      profiles: strings(doc["profiles"]),
      openBlockers,
      openGaps: openGapsOf(doc),
      defaultBranch: typeof defaultBranch === "string" && isRefName(defaultBranch) ? defaultBranch : null,
      mergeBase: isSha(recordedBase) ? recordedBase : null,
      procedureHash: typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? hash : null,
    });
  }
  return out.sort((a, b) => (a.finishedAt !== b.finishedAt ? (a.finishedAt < b.finishedAt ? 1 : -1) : a.runId < b.runId ? 1 : -1));
}

/** The newest gating run record of pull request `pr` at `head` in runs/, or null. */
export function readPriorRun(home: string, pr: number, head: string): RunRecord | null {
  return readRunRecords(home, pr).find((record) => record.head === head) ?? null;
}

/**
 * The newest gating run of pull request `pr` at `head` or at one of its ancestors: the blockers it
 * left open are carried into this run, whatever the mode (spec 07 §2.3.2, §5.3).
 */
async function newestRunOnHistory(home: string, pr: number, head: string, mirror: string, env: Readonly<Record<string, string | undefined>>): Promise<RunRecord | null> {
  for (const record of readRunRecords(home, pr)) {
    if (record.head === head) return record;
    if ((await resolveCommit(mirror, record.head, env)) === null) continue;
    if (await isAncestor(mirror, record.head, head, env)) return record;
  }
  return null;
}

/** Most paths a blocker may name whose changed lines are read for checking a quoted fix. */
const MAX_FIX_PATHS = 64;
/** Most files tied to one blocker whose changed lines are read; past it the rest hold no fix (fail closed). */
const MAX_FIX_FILES = 256;
/** Most files the prompt lists as where a blocker's fix may lie. */
const MAX_FIX_LISTED = 64;

/** A text with every white-space character taken out, so a moved quote is found however it is laid out. */
function squeezed(text: string): string {
  return text.replace(/\s+/g, "");
}

function occurrences(text: string, part: string): number {
  if (part === "") return 0;
  let count = 0;
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length)) count++;
  return count;
}

/** The tree of `sha` by path, read once per run for every blocker found there. */
type TreeAt = (sha: string) => Promise<Map<string, TreeEntry>>;

/**
 * Where a fix of a blocker found at `from` may be quoted at `head` (FixScope, src/review/findings.ts):
 *
 * - each file the blocker's `where` names, at its path at the head (followed through a rename since
 *   `from`, never a copy), and the files tied to one: its tests (by name, or a test that imports
 *   it) and the files one hop from it in the head's import graph (its imports and importers);
 * - each file changed since `from`, other than a quote's own file, in which a text the blocker quotes
 *   (white space taken out) now occurs more often than it did at `from`: the defect may have moved
 *   or been copied there, so it is followed like a rename (`quotedElsewhere`, which the fix check is
 *   shown, whether or not the text is still in its own file);
 * - when a file it names was deleted since `from`, every file changed since then too;
 *
 * each with the lines of it that changed since `from` (rename-aware, so a file moved as it was has
 * none, and a file unchanged since has none). Nothing here refuses a claim: a text match cannot tell
 * a move from a fix, so the fix check decides, shown where the quoted code now also appears.
 */
async function fixScopeFor(
  mirror: string,
  from: string,
  head: string,
  blocker: OpenBlocker,
  files: TreeFiles,
  graph: ImportGraph,
  treeAt: TreeAt,
  env: Readonly<Record<string, string | undefined>>,
): Promise<FixScope> {
  const out = new Map<string, Set<number>>();
  const where = Array.isArray(blocker.finding.where) ? blocker.finding.where : [];
  const paths = sortedUnique(where.map((item) => (isJsonObject(item) && typeof item.path === "string" ? item.path : "")).filter((path) => path !== ""));
  if (paths.length === 0 || paths.length > MAX_FIX_PATHS) return { files: out, quotedElsewhere: [] };
  if (from === head || (await resolveCommit(mirror, from, env)) === null || !(await isAncestor(mirror, from, head, env))) {
    // Nothing changed since the blocker was found (or the change cannot be shown): no line can be a fix.
    for (const path of paths) if (files.kind(path) === "file") out.set(path, new Set());
    return { files: out, quotedElsewhere: [] };
  }
  const delta = await diffTwoDot(mirror, from, head, env);
  const atHead = (path: string): string | null => {
    const renamed = delta.find((entry) => entry.status === "R" && entry.oldPath === path);
    if (renamed !== undefined) return renamed.path;
    const own = delta.find((entry) => entry.path === path && entry.oldPath === null);
    return own?.status === "D" || files.kind(path) !== "file" ? null : path;
  };
  const named = paths.map((path) => atHead(path)).filter((path): path is string => path !== null);
  const deletedNamed = named.length < paths.length;
  const changedSince = delta.filter((entry) => entry.status !== "D" && files.kind(entry.path) === "file");

  // Where the code the blocker quotes now occurs more often than it did: the defect may be there now.
  const quotes = (Array.isArray(blocker.finding.quotes) ? blocker.finding.quotes : [])
    .filter((quote) => isJsonObject(quote) && typeof quote.text === "string" && typeof quote.path === "string")
    .map((quote) => ({ home: atHead(quote.path), part: squeezed(quote.text) }))
    .filter((quote) => quote.part !== "");
  const counted: Array<{ entry: DiffEntry; part: string; now: number }> = [];
  for (const entry of changedSince) {
    const text = squeezed(files.text(entry.path) ?? "");
    for (const quote of quotes) {
      if (entry.path === quote.home) continue;
      const now = occurrences(text, quote.part);
      if (now > 0) counted.push({ entry, part: quote.part, now });
    }
  }
  const before = new Map<string, string>();
  const earlier = counted.filter((item) => item.entry.status !== "A");
  if (earlier.length > 0) {
    const tree = await treeAt(from);
    const oids = new Map<string, string>();
    for (const { entry } of earlier) {
      const old = tree.get(entry.oldPath ?? entry.path);
      if (old !== undefined && old.type === "blob") oids.set(entry.path, old.oid);
    }
    const { blobs } = await readBlobs(mirror, [...oids.values()], env);
    for (const [path, oid] of oids) {
      const bytes = blobs.get(oid);
      if (bytes !== undefined) before.set(path, squeezed(decodeText(bytes)));
    }
  }
  const elsewhere = new Set<string>();
  for (const { entry, part, now } of counted) if (now > occurrences(before.get(entry.path) ?? "", part)) elsewhere.add(entry.path);
  const quotedElsewhere = sortedUnique(elsewhere);

  // The files tied to the blocker, the named ones and those the quoted code went to first so a cap never drops them.
  const tied = new Set<string>(named);
  for (const path of quotedElsewhere) if (tied.size < MAX_FIX_FILES) tied.add(path);
  const near = new Set<string>();
  for (const path of named) {
    for (const test of readTestsFor(path, files, graph, Number.POSITIVE_INFINITY)) near.add(test);
    for (const hop of [...graph.importsOf(path), ...graph.importersOf(path)]) near.add(hop);
  }
  if (deletedNamed) for (const entry of changedSince) near.add(entry.path);
  for (const path of sortedUnique(near)) if (files.kind(path) === "file" && tied.size < MAX_FIX_FILES) tied.add(path);

  for (const path of tied) {
    const entry = delta.find((item) => item.path === path && item.status !== "D");
    if (entry === undefined) out.set(path, new Set());
    else if (entry.status === "R" && entry.oldPath !== null) out.set(path, await changedLineNumbers(mirror, from, head, path, env, entry.oldPath));
    else out.set(path, await changedLineNumbers(mirror, from, head, path, env));
  }
  return { files: out, quotedElsewhere };
}

// ---- Planning helpers -------------------------------------------------------------------------

/** Every symbolic link of the trees at `shas`, with the path each reaches (plan.ts's linkTarget). */
async function treeLinks(mirror: string, shas: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<TreeLink[]> {
  const entries: TreeEntry[] = [];
  for (const sha of sortedUnique(shas)) for (const entry of await lsTree(mirror, sha, env)) if (entry.mode === SYMLINK_MODE) entries.push(entry);
  if (entries.length === 0) return [];
  const { blobs } = await readBlobs(mirror, sortedUnique(entries.map((entry) => entry.oid)), env);
  const links = new Map<string, TreeLink>();
  for (const entry of entries) {
    const link = { path: entry.path, target: linkTarget(entry.path, blobs.get(entry.oid)) };
    links.set(`${link.path}\0${link.target}`, link);
  }
  return [...links.values()];
}

/**
 * The paths of a change and its tier, counted as `plan` counts them (plan.ts's changeTiers): tier D
 * only for documentation files, a changed link or submodule at S, a path a link reaches also at the
 * link's path, and S for a change with several merge bases or a link reach that cannot be bounded.
 */
function tieredChange(diff: readonly DiffEntry[], layout: Layout | null, ciMap: CiMap, links: readonly TreeLink[], historyAmbiguous: boolean): { changed: ChangedPath[]; tier: Tier | null } {
  const change = changeTiers({ diff, layout, ciMap, links, historyAmbiguous });
  return {
    changed: change.paths.map((path) => ({ path: path.path, status: path.status, side: path.side, link: path.link, tier: path.tier })),
    tier: change.tier,
  };
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

/** A unit's tests: those named for it, and up to `importing` other tests that import it (spec 07 §2.5: three). */
function readTestsFor(unitPath: string, files: TreeFiles, graph: ImportGraph, importing = 3): string[] {
  if (TEST_RE.test(unitPath)) return [];
  const dir = posix.dirname(unitPath);
  const stem = posix.basename(unitPath).replace(/\.[^.]+$/, "");
  const named = [`${stem}.test.ts`, `${stem}.test.tsx`, `${stem}.db.test.ts`]
    .map((name) => (dir === "." ? name : `${dir}/${name}`))
    .filter((path) => files.has(path));
  const importers = graph
    .importersOf(unitPath)
    .filter((path) => TEST_RE.test(path) && !named.includes(path))
    .slice(0, importing);
  return [...named, ...importers];
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

/** Paths as a prompt lists them: at most MAX_FIX_LISTED, then how many more. */
function listed(paths: readonly string[]): string[] {
  return paths.length > MAX_FIX_LISTED ? [...paths.slice(0, MAX_FIX_LISTED), `... and ${paths.length - MAX_FIX_LISTED} more`] : [...paths];
}

function priorBlockData(priors: ReadonlyMap<string, OpenBlocker>, scopes: ReadonlyMap<string, FixScope>): string {
  const list = [...priors].map(([promptId, blocker]) => {
    const tied = sortedUnique(scopes.get(blocker.id)?.files.keys() ?? []);
    const elsewhere = scopes.get(blocker.id)?.quotedElsewhere ?? [];
    return {
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
      fixMayBeIn: listed(tied),
      ...(elsewhere.length === 0 ? {} : { quotedCodeAlsoIn: listed(elsewhere) }),
    };
  });
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

    // The engine copy (spec 07 §0.3): a gating run is judged by the default branch's engine and
    // procedure, never by the copy a pull request carries. Anything else runs only as advisory.
    const engine = await deps.engineCopy({ mirror, defaultBranch, defaultTip, env });
    if (engine.problems.length > 0) {
      if (!req.advisory) {
        for (const problem of engine.problems) deps.stderr(`fin-review: refused: engine_not_default: ${problem}\n`);
        deps.stderr(`fin-review: run the engine from a clean checkout of ${defaultBranch}, or pass --advisory\n`);
        state.to("refused", { reason: "engine_copy" });
        return EXIT.config;
      }
      deps.stderr(`advisory: the engine is not ${defaultBranch}'s engine copy\n`);
    }
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
    // Every merge base, as `plan` reads them: with several (criss-cross merges) git alone would pick
    // one by date, so the change is the union of the diffs from each, and it is tier S (§2.4).
    const bases = (await mergeBases(mirror, defaultTip, head, env)).sort();
    const base = bases[0] ?? null;
    if (base === null) {
      deps.stderr(`fin-review: error: the pull request's head shares no history with ${defaultBranch}\n`);
      state.to("refused", { reason: "no_merge_base" });
      return EXIT.data;
    }
    if (bases.length > MAX_MERGE_BASES) throw new DataError(`the head and ${defaultBranch} have ${bases.length} merge bases`);
    const historyAmbiguous = bases.length > 1;
    if (historyAmbiguous) deps.stderr(`fin-review: the head and ${defaultBranch} have ${bases.length} merge bases: the run reviews the changes since each of them, at tier S\n`);
    if (facts.baseRef !== defaultBranch) {
      deps.stderr(`fin-review: the base is ${facts.baseRef}, not ${defaultBranch}: the run reviews everything on the head since its merge base with ${defaultBranch}\n`);
    }
    const layout = await layoutAt(mirror, defaultTip, env);
    const prDiffs: DiffEntry[][] = [];
    for (const from of bases) prDiffs.push(await diffRaw(mirror, from, head, env));
    const prDiff = unionOfDiffs(prDiffs);

    // `commit`: stay a delta, or escalate to `pr` (§2.3.2).
    let mode: Mode = req.mode;
    let escalated: string | null = null;
    let prior: PriorRun | null = null;
    let scopeDiff: readonly DiffEntry[] = prDiff;
    let deltaFrom: string | null = null;
    if (req.mode === "commit") {
      const since = req.since ?? "";
      const decision = await commitDecision(req, deps, mirror, since, head, layout, { defaultBranch, defaultTip, mergeBase: base, historyAmbiguous }, engine.procedureHash);
      if (decision.escalate !== null) {
        mode = "pr";
        escalated = decision.escalate;
      } else {
        prior = decision.prior;
        scopeDiff = decision.delta;
        deltaFrom = since;
      }
    }
    // Tiers as `plan` counts them, with the links of every tree the change is read against.
    const links = await treeLinks(mirror, [head, defaultTip, ...bases, ...(deltaFrom === null ? [] : [deltaFrom])], env);
    const { changed, tier } = tieredChange(scopeDiff, layout, config.ciMap, links, deltaFrom === null && historyAmbiguous);
    // The change's own tier picks the lenses; a delta's tier never lowers the gating chain's, so the
    // floor, the budget and the recorded tier use the higher of the two (spec 07 §2.3.2, §2.4).
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
    if (req.advisory) deps.stderr("advisory: not a gate result (exit 3)\n");
    if (req.options.fast) deps.stderr("fast: applies to Opus sessions only\n");

    // The head's paths: refused before anything is read or written when one cannot be shown to a
    // session as it is (a control character, a .git segment, two names a disk folds into one).
    const headTree = await lsTree(mirror, head, env);
    const headMap = new Map(headTree.map((entry) => [entry.path, entry]));
    const pathProblems = treeProblems(headTree);
    // A path a link reaches is a name through the link, not a path of either tree: it counts for the
    // tier and the attack profiles only.
    const diffPaths = changed.filter((item) => item.side !== "link");
    for (const path of sortedUnique(diffPaths.filter((item) => !headMap.has(item.path)).map((item) => item.path))) {
      const problem = pathTextProblem(path);
      if (problem !== null) pathProblems.push(problem);
    }
    if (pathProblems.length > 0) return refuseTree(pathProblems);

    // The head's blobs, by object ID: the units, the graph and every quote check read them, and
    // the tree the sessions read is written from them.
    const { blobs } = await readBlobs(mirror, headTree.filter((entry) => entry.type === "blob").map((entry) => entry.oid), env);
    const deletedPaths = new Set(diffPaths.filter((path) => !headMap.has(path.path)).map((path) => path.path));
    const deleted = new Map<string, string>();
    // A deleted path's text from the side it was deleted from (each merge base, when there are several).
    for (const from of deltaFrom === null ? bases : [deltaFrom]) {
      if (deleted.size >= deletedPaths.size) break;
      const baseTree = await lsTree(mirror, from, env);
      const wanted = baseTree.filter((entry) => entry.type === "blob" && deletedPaths.has(entry.path) && !deleted.has(entry.path));
      if (wanted.length === 0) continue;
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
    // A path's tier as the change counts it (a changed link at S included), else as `plan` would.
    const changedTier = new Map<string, Tier>();
    for (const item of diffPaths) changedTier.set(item.path, maxTier(changedTier.get(item.path) ?? item.tier, item.tier));
    const tierFor = (path: string): Tier => changedTier.get(path) ?? pathTier(layout, config.ciMap, path).tier;
    const { units, excluded } = inventory(
      sortedUnique(unitPaths).map((path) => ({ path, tier: tierFor(path), kind: files.kind(path) })),
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

    // The blockers left open by the newest gating run on the head's history, in every mode (an
    // escalated `commit` and a second `pr` included): each is shown again to the lens that found
    // it and stays open until that lens quotes its fix on lines changed since it was found.
    const carriedFrom = await newestRunOnHistory(deps.home, req.pr, head, mirror, env);
    const priorBlockers = carriedFrom?.openBlockers ?? [];
    const trees = new Map<string, Map<string, TreeEntry>>();
    const treeAt: TreeAt = async (sha) => {
      let tree = trees.get(sha);
      if (tree === undefined) trees.set(sha, (tree = new Map((await lsTree(mirror, sha, env)).map((entry) => [entry.path, entry]))));
      return tree;
    };
    const fixScopesByBlocker = new Map<string, FixScope>();
    for (const blocker of priorBlockers) fixScopesByBlocker.set(blocker.id, await fixScopeFor(mirror, blocker.foundAt, head, blocker, files, graph, treeAt, env));

    // Lenses and attack profiles of the change's tier, and any lens a prior blocker needs.
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
    // With several merge bases a three-dot diff would show the changes since only one of them, so
    // the patch is the diff since each, in turn.
    let patch: { text: string; truncated: boolean };
    if (deltaFrom === null && historyAmbiguous) {
      const parts: string[] = [];
      let truncated = false;
      for (const from of bases) {
        const part = await unifiedDiff(mirror, from, head, false, Math.floor(MAX_DIFF_BYTES / bases.length), env);
        parts.push(`# Since merge base ${from}\n${part.text}`);
        truncated ||= part.truncated;
      }
      patch = { text: parts.join("\n"), truncated };
    } else patch = await unifiedDiff(mirror, deltaFrom ?? defaultTip, head, deltaFrom === null, MAX_DIFF_BYTES, env);
    const unitDiffs = new Map<string, string>();
    if (deltaFrom !== null) {
      for (const path of changedAtHead) {
        if (!unitPaths.has(path)) continue;
        unitDiffs.set(path, (await unifiedDiff(mirror, deltaFrom, head, false, Math.floor(MAX_DIFF_BYTES / 4), env, [path])).text);
      }
    }

    // ---- sessions ----
    const plans = planSessions({ deps, units, lenses, profileMap, files, graph, changed, nonUnits, deleted, priorBlockers, fixScopesByBlocker, patch, unitDiffs, rulesFiles: engine.rulesFiles ?? readRulesFiles(deps.engineRoot) });
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
      mergeBases: bases,
      since: req.since,
      tier: gateTier,
      deltaTier: tier,
      engine: { commit: engine.commit, procedureHash: engine.procedureHash, defaultCopy: engine.problems.length === 0, problems: engine.problems },
      transport: deps.transport ?? "direct",
      changed,
      units: units.map((unit) => ({ id: unit.id, path: unit.path, startLine: unit.startLine, endLine: unit.endLine, tier: unit.tier, kind: unit.kind })),
      excluded,
      notUnits: nonUnits,
      priorRun: carriedFrom === null ? null : { runId: carriedFrom.runId, head: carriedFrom.head, openBlockers: priorBlockers.map((blocker) => ({ id: blocker.id, lensKey: blocker.lensKey, foundAt: blocker.foundAt })) },
      lenses,
      profiles: Object.fromEntries(profileMap),
      sessions: plans.map((plan) => ({ id: plan.id, role: plan.role, lensKey: plan.lensKey, shard: plan.shard, units: plan.units.map((unit) => unit.id) })),
    });
    state.to("planned", { mode, escalated, head, baseRef: facts.baseRef, base: baseTip, defaultBranch, defaultTip, mergeBase: base, tier: gateTier, transport: deps.transport ?? "direct" });

    const cap = mode === "commit" ? config.budgets.runUsd.commit : config.budgets.runUsd.pr[gateTier ?? "D"];
    const budget = new RunBudget(cap);
    const runner = deps.makeRunner({ runId, runDir });
    const pool = new Pool(deps.maxSessions);
    const records: SessionRecord[] = [];
    const findings: FindingRecord[] = [];
    const verifications: Array<Promise<void>> = [];
    const priorStatus = new Map<string, "fixed" | "open">();
    /** What the lens shown each prior blocker said of it, and what its fix check found. */
    const priorClaims = new Map<string, PriorClaim>();
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
        // A prompt over the runner's cap (a unit that is never cut, such as a large JSON file) is not
        // started: its lens is incomplete, so the run records that it could not check (exit 2).
        const promptBytes = Buffer.byteLength(spec.prompt, "utf8");
        if (promptBytes > MAX_PROMPT_BYTES) {
          record.state = "incomplete";
          record.detail = `its prompt is ${promptBytes} bytes, over the ${MAX_PROMPT_BYTES}-byte cap`;
          deps.stderr(`fin-review: session ${spec.id} not started: ${record.detail}\n`);
          writeJson(join(runDir, "sessions", `${spec.id}.result.json`), { id: spec.id, role: spec.role, lensKey: record.lensKey, state: record.state, notStarted: record.detail });
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
        // Rule 5 for a verifier's own free text too: a second look and the summary see it filtered.
        const reason = filterText(typeof out["reason"] === "string" ? out["reason"] : "", procedure.injectionPatterns);
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
            reason,
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
          reason,
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

    /**
     * The fix check of a prior blocker a lens claims fixed, with a claim the engine accepted: the
     * blocker's finding and the claimed fix go to a sceptic (two, the second on the attack model,
     * for a high or critical blocker, or when the code the blocker quotes now also appears in
     * another changed file, which the check is shown), asked whether the defect can still happen
     * at this head. It closes only when every one refutes it with a guard quoted from this head; a
     * confirmation, an UNSURE, an unguarded refutation or a session that could not answer leaves it
     * open (and a model mismatch or a budget stop makes the run could-not-check, as for any sceptic).
     */
    const checkFix = async (blocker: OpenBlocker, fixWhere: Where, fixQuote: Quote): Promise<void> => {
      const claim = priorClaims.get(blocker.id);
      if (claim === undefined) return;
      claim.outcome = "checking";
      const index = String(priorBlockers.indexOf(blocker) + 1).padStart(3, "0");
      const elsewhere = fixScopesByBlocker.get(blocker.id)?.quotedElsewhere ?? [];
      const roles: Role[] = severityRank(blocker.finding.severity) >= severityRank("high") || elsewhere.length > 0 ? ["sceptic1", "sceptic2"] : ["sceptic1"];
      const prompt = fixCheckPrompt(blocker.finding, { fixWhere, fixQuote }, listed(elsewhere), procedure.fixCheckPrompt);
      const schema = procedure.schemas.sceptic;
      for (const role of roles) {
        const id = `${role}-prior-${index}`;
        const record: SessionRecord = { id, role, lensKey: `fix:${blocker.id}`, state: "pending", result: null, unitIds: [] };
        records.push(record);
        const accept = (output: unknown): string | null => {
          if (!isJsonObject(output)) return "the output is not an object";
          const quotes = output["guardQuotes"];
          return Array.isArray(quotes) ? quotesProblem(quotes as unknown as Quote[], files) : null;
        };
        const result = await runSession(record, specFor(role, id, {}, prompt, schema), accept);
        const usable =
          result !== null &&
          isJsonObject(result.output) &&
          (result.state === "ok" || (result.failure === "schema" && compileSchema(schema)(result.output).length === 0));
        if (result === null || !usable || !isJsonObject(result.output)) {
          const issue = result === null ? `${role} ${record.state}` : `${role} ${record.state}${result.failure === undefined ? "" : ` (${result.failure})`}`;
          claim.checks.push({ role, session: id, verdict: null, guarded: false, guardQuotes: [], reason: "", issue });
          claim.outcome = "unchecked";
          if (result === null || result.failure === "model_mismatch" || result.failure === "budget") verifyCouldNotCheck = true;
          return;
        }
        const out = result.output;
        const verdict = typeof out["verdict"] === "string" ? out["verdict"] : "UNSURE";
        const guardQuotes = Array.isArray(out["guardQuotes"]) ? (out["guardQuotes"] as unknown as Quote[]) : [];
        const guarded = verdict === "REFUTED" && guardQuotes.length > 0 && quotesProblem(guardQuotes, files) === null;
        const reason = filterText(typeof out["reason"] === "string" ? out["reason"] : "", procedure.injectionPatterns);
        claim.checks.push({ role, session: id, verdict, guarded, guardQuotes, reason });
        if (!guarded) {
          claim.outcome = verdict === "CONFIRMED" ? "still_there" : "unsure";
          return;
        }
      }
      claim.outcome = "fixed";
      priorStatus.set(blocker.id, "fixed");
    };

    const runLens = async (plan: SessionPlan): Promise<void> => {
      const record: SessionRecord = { id: plan.id, role: plan.role, lensKey: plan.lensKey, state: "pending", result: null, unitIds: plan.units.map((unit) => unit.id) };
      records.push(record);
      const ctx: ValidationContext = { schema: plan.schema, checklist: plan.checklist, allowed: plan.allowed, files, fixScopes: plan.fixScopes };
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
        // Rule 5 before anyone else sees it: free text addressed to a reviewer is withheld.
        const finding = filterFreeText(check.finding, procedure.injectionPatterns).finding as Finding;
        const firstPath = check.ok ? finding.where[0]?.path : undefined;
        const rec: FindingRecord = {
          id: `F-${runId}-${number}`,
          session: plan.id,
          lensKey: plan.lensKey,
          state: check.ok ? "kept" : "invalid",
          problems: check.problems,
          finding,
          reportedSeverity: check.ok ? finding.severity : null,
          severity: check.ok ? finding.severity : null,
          tier: firstPath === undefined ? null : tierFor(firstPath),
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
      // A prior blocker's claim counts only in an answer the engine accepted whole: an output kept
      // after a failed attempt still adds its valid findings (that only blocks more), but claims
      // nothing. A claim the engine accepts goes to a fix check; only that can close the blocker.
      if (result.state !== "ok") return;
      for (const check of validated.prior) {
        const blocker = plan.priors.get(check.id);
        if (blocker === undefined || priorClaims.has(blocker.id)) continue;
        priorClaims.set(blocker.id, claimOf(plan.id, check));
        if (check.status === "fixed" && check.problems.length === 0 && check.notAccepted.length === 0 && check.fixWhere !== undefined && check.fixQuote !== undefined) {
          verifications.push(checkFix(blocker, check.fixWhere, check.fixQuote));
        }
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
    for (const blocker of stillOpen) blockers.push({ rule: "prior", finding: blocker.id, lens: blocker.lensKey, detail: stillOpenDetail(priorClaims.get(blocker.id)) });

    const couldNotCheck = lensKeys.some((key) => lensStates[key] !== "done") || verifyCouldNotCheck;
    const outcome: RunOutcomeName = couldNotCheck ? "could_not_check" : blockers.length > 0 ? "blocked" : "pass";
    // An advisory run is never a gate result: its own name and exit code, whatever it found.
    const result: RunResultName = req.advisory ? "advisory" : outcome;
    const exitCode = req.advisory ? EXIT.advisory : outcome === "pass" ? EXIT.pass : outcome === "blocked" ? EXIT.blocked : EXIT.couldNotCheck;
    const openBlockers: OpenBlocker[] = [
      ...findings
        .filter((rec) => rec.blocking)
        .map((rec) => {
          const finding = rec.finding as Finding;
          return { id: rec.id, lensKey: rec.lensKey, lens: finding.lens, profile: finding.profile ?? null, finding, foundAt: head };
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
      mergeBases: bases,
      tier: gateTier,
      deltaTier: tier,
      engine: { commit: engine.commit, procedureHash: engine.procedureHash, defaultCopy: engine.problems.length === 0 },
      transport: deps.transport ?? "direct",
      result,
      outcome,
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
      priorBlockers: priorBlockers.map((blocker) => ({
        id: blocker.id,
        status: priorStatus.get(blocker.id) ?? "open",
        quotedElsewhere: fixScopesByBlocker.get(blocker.id)?.quotedElsewhere ?? [],
        claim: priorClaims.get(blocker.id) ?? null,
      })),
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
  readonly defaultTip: string;
  readonly mergeBase: string;
  /** True when the head has several merge bases with the default branch. */
  readonly historyAmbiguous: boolean;
}

async function commitDecision(
  req: ReviewRequest,
  deps: ReviewDeps,
  mirror: string,
  since: string,
  head: string,
  layout: Layout | null,
  scope: Scope,
  procedureHash: string | null,
): Promise<CommitDecision> {
  const { env, config, procedure } = deps;
  const escalate = (reason: string): CommitDecision => ({ escalate: reason, prior: null, delta: [] });
  const prior = readPriorRun(deps.home, req.pr, since);
  if (prior === null) return escalate("no_prior_run");
  if (!isSha(since) || (await resolveCommit(mirror, since, env)) === null || !(await isAncestor(mirror, since, head, env))) return escalate("not_ancestor");
  // A procedure change invalidates what the prior run covered (spec 07 §4.8, §5.9).
  if (procedureHash === null || prior.procedureHash !== procedureHash) return escalate("procedure_changed");
  // With several merge bases, which one a prior run reviewed from cannot be compared: review it all.
  if (scope.historyAmbiguous) return escalate("history_ambiguous");
  // The prior run must have reviewed from the same branch and from a merge base this one still
  // contains; otherwise what lies between the two bases was never reviewed with the head.
  if (prior.defaultBranch !== scope.defaultBranch || prior.mergeBase === null || (await resolveCommit(mirror, prior.mergeBase, env)) === null) return escalate("base_changed");
  if (prior.mergeBase !== scope.mergeBase && !(await isAncestor(mirror, prior.mergeBase, scope.mergeBase, env))) return escalate("base_changed");
  if ((await changedLines(mirror, since, head, env)) > COMMIT_MAX_LINES) return escalate("delta_lines");
  const delta = await diffTwoDot(mirror, since, head, env);
  const links = await treeLinks(mirror, [since, head, scope.defaultTip], env);
  const { changed, tier } = tieredChange(delta, layout, config.ciMap, links, false);
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
  // A changed path no lens could review, or a lens that was not done, is no finding a delta can
  // show fixed: only a full review of the change can find it gone (spec 07 §2.11 rules 3 and 6).
  if (prior.openGaps > 0) return escalate("prior_gap");
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
  /** The engine copy's rules files, as the engine-copy check read and verified them. */
  readonly rulesFiles: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  /** The text of each deleted path as it was before the change. */
  readonly deleted: ReadonlyMap<string, string>;
  readonly priorBlockers: readonly OpenBlocker[];
  /** By prior blocker: each file it names (at its head path) and the lines of it changed since it was found. */
  readonly fixScopesByBlocker: ReadonlyMap<string, FixScope>;
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
  const where = (path: ChangedPath): string => (path.side === "old" ? "old path" : path.side === "link" ? `reached through the link ${path.link ?? ""}` : "at head");
  const paths = input.changed.map((path) => `- ${path.path} (${path.status}, ${where(path)}, tier ${path.tier})`);
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
  const rulesFiles = input.rulesFiles;
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
      extra: [...opts.extraBlocks, ...(priors.size > 0 ? [priorBlockData(priors, input.fixScopesByBlocker)] : [])],
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
      fixScopes: new Map([...priors].map(([promptId, blocker]): [string, FixScope] => [promptId, input.fixScopesByBlocker.get(blocker.id) ?? { files: new Map(), quotedElsewhere: [] }])),
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
