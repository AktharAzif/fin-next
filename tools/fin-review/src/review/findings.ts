// Finding validation, in code, before any other session or any builder sees a finding (spec 07
// §2.8; [RV-21]): rule 1 the output matches its schema; rule 2 every `where.path` is a file of the
// reviewed head (at the base for a deletion) inside what the session was given, its lines within
// the file; rule 3 every quote is an exact substring of the named file after CRLF becomes LF; rule 4
// the length caps (in the schema); rule 6 `checked` names every checklist item, and an item marked
// `finding` comes with at least one finding. Rule 5, the filter of free text addressed to a reviewer,
// is src/review/injection.ts, applied by the run before anyone else sees a finding.
//
// A prior blocker's `fixed` claim is accepted only with a quote of the fix (spec 07 §2.3.2) from the
// file its `fixWhere` names, within those lines, touching a line changed since the blocker was found,
// in a file tied to the blocker: one it names (or the path git pairs it with as renamed), a test of
// such a file, a file one hop from it in the import graph, a file changed since in which the code the
// blocker quotes now occurs more often than it did (where the defect may have moved or been copied),
// or, where a file it names was deleted since, any file changed since (FixScope, computed by the
// run). What was already there cannot be a fix. A claim the engine cannot accept leaves the blocker
// open and is recorded with its reasons; it does not fail the output (a fabricated quote or a path
// outside the tree still does, as rules 2 and 3 say). An accepted claim is only a claim: the run
// sends it to a sceptic, told every other file of the head the quoted code occurs in (changed since
// or not) and the path git pairs each renamed file it names with, and the blocker closes only when
// every sceptic finds the defect gone, there too (src/review/run.ts). A moved defect is not a fixed
// one, and that is the fix check's to judge: no text match can tell a move from a fix (a comment
// holding the old line defeats it, and an unrelated line that matches it would refuse a real fix).
//
// An output that breaks any rule is retried once in a fresh session (§4.6). Findings are judged one
// by one: an invalid finding is recorded as `invalid` and never shown, and the valid findings of the
// last attempt are kept even when the lens ends `incomplete`.

import { isJsonObject } from "../json.ts";
import { compileSchema } from "./schema.ts";
import type { SchemaError } from "./schema.ts";

export type Severity = "critical" | "high" | "medium" | "low";
export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];

export interface Where {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface Quote {
  readonly path: string;
  readonly text: string;
}

/** A finding as a session reports it (the engine assigns its ID). */
export interface Finding {
  readonly lens: string;
  readonly profile?: string;
  readonly class: string;
  readonly severity: Severity;
  readonly title: string;
  readonly where: readonly Where[];
  readonly quotes: readonly Quote[];
  readonly claim: string;
  readonly scenario: string;
  readonly ruleId?: string;
  readonly testShouldFail: string;
  readonly preExisting: boolean;
  /** Set by the engine (rule 5): a free-text field addressed a reviewer and was withheld. */
  readonly injectionSuspect?: boolean;
}

/** The reviewed files, as text with CRLF already turned to LF. */
export interface FileSource {
  /** The file at the head (or at the base for a deleted path); null when the tree has no such file. */
  text(path: string): string | null;
}

export interface ValidationContext {
  /** The session's schema, narrowed to its lens, profile and checklist. */
  readonly schema: object;
  readonly checklist: readonly string[];
  /** The paths a finding may name; null for the whole tree (joins, attack, sibling). */
  readonly allowed: ReadonlySet<string> | null;
  readonly files: FileSource;
  /** For each prior blocker shown to the session, by its prompt ID: where a fix of it may be quoted. */
  readonly fixScopes?: ReadonlyMap<string, FixScope>;
}

/** Where a fix of one prior blocker may be quoted at the head, and where its quoted code went. */
export interface FixScope {
  /**
   * Each file at the head tied to the blocker (a file it names or the path git pairs it with as
   * renamed, a file in `quotedElsewhere`, a test of a named file, a file one hop from one; any file
   * changed since when one it names was deleted), with the lines of it that changed since the blocker
   * was found. A fix is quoted only from such lines.
   */
  readonly files: ReadonlyMap<string, ReadonlySet<number>>;
  /**
   * The files changed since the blocker was found, other than a quote's own file, in which code the
   * blocker quotes (white space taken out) now occurs more often than it did then: where the defect
   * may have moved or been copied. Such a file is tied to the blocker (a fix may be quoted from it).
   * Its fix check is shown every one of them and takes two sceptics. Sorted.
   */
  readonly quotedElsewhere: readonly string[];
  /**
   * Every other file of the head, other than a quote's own file and those in `quotedElsewhere`, in
   * which code the blocker quotes occurs: files that already held it when the blocker was found
   * (unchanged since, or changed with no more of it), where the defect may now be reached through
   * code changed around it. Not tied to the blocker. Its fix check is shown every one of them and
   * takes two sceptics. Sorted.
   */
  readonly quotedStillIn: readonly string[];
  /**
   * Each path the blocker names (in `where` or a quote) that git reads as renamed since it was found,
   * with the path git pairs it with at the head (by how alike the two files are, so the code it names
   * may be there, or may have gone elsewhere). Its fix check is shown them and takes two sceptics.
   * Sorted by `from`.
   */
  readonly renamed: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

/**
 * Most files a fix check is shown as holding a blocker's quoted code, `quotedElsewhere` and
 * `quotedStillIn` together. A check is never shown part of either list: past it, a fix claim for the
 * blocker is not accepted, and it stays open.
 */
export const MAX_FIX_CHECK_PATHS = 64;

export interface FindingCheck {
  readonly index: number;
  readonly finding: unknown;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface PriorCheck {
  readonly id: string;
  /** "fixed" when the session claims a fix the engine accepts (for a sceptic to check); else "open". */
  readonly status: "fixed" | "open";
  /** Rule 1 to 3 problems: the output is rejected and retried. */
  readonly problems: readonly string[];
  /** Why a well-formed `fixed` claim cannot be accepted: the blocker stays open, the output stands. */
  readonly notAccepted: readonly string[];
  readonly fixWhere?: Where;
  readonly fixQuote?: Quote;
}

export interface ValidatedOutput {
  readonly structureProblems: readonly string[];
  readonly done: boolean;
  readonly missingItems: readonly string[];
  /** Checklist items the session marked `finding`. */
  readonly flaggedItems: readonly string[];
  readonly findings: readonly FindingCheck[];
  readonly procedureGaps: readonly string[];
  readonly prior: readonly PriorCheck[];
}

/** LF line endings and the line count of a text. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function whereProblems(where: Where, ctx: ValidationContext, allowed: ReadonlySet<string> | null): string[] {
  const text = ctx.files.text(where.path);
  if (text === null) return [`${JSON.stringify(where.path)} is not a file of the reviewed tree`];
  if (allowed !== null && !allowed.has(where.path)) return [`${JSON.stringify(where.path)} is outside what the session was given`];
  const lines = lineCount(text);
  if (where.startLine > where.endLine) return [`${where.path}: startLine ${where.startLine} is after endLine ${where.endLine}`];
  if (where.endLine > Math.max(1, lines)) return [`${where.path}: line ${where.endLine} is past the end (${lines} lines)`];
  return [];
}

function quoteProblems(quote: Quote, ctx: ValidationContext): string[] {
  const text = ctx.files.text(quote.path);
  if (text === null) return [`quote names ${JSON.stringify(quote.path)}, which is not a file of the reviewed tree`];
  const wanted = lf(quote.text);
  if (wanted.trim() === "") return [`quote of ${quote.path} is blank`];
  if (!text.includes(wanted)) return [`quote is not an exact substring of ${quote.path}`];
  return [];
}

/**
 * Why a quoted fix of prior blocker `id` cannot be accepted: the quote must come from the file
 * `where` names, a file tied to the blocker (FixScope.files), lie within its lines, and touch a line
 * that changed since the blocker was found. Nothing that was already there when the blocker was
 * found can be its fix, nor a line changed in a file unrelated to it. Whether the defect moved is the
 * fix check's to judge (src/review/run.ts), so no claim is taken when the check could not be shown
 * every other file the blocker's quoted code occurs in.
 */
function fixProblems(id: string, where: Where, quote: Quote, ctx: ValidationContext): string[] {
  const scope = ctx.fixScopes?.get(id);
  if (scope === undefined) return [`${id} is not a prior blocker shown to this session`];
  const holding = scope.quotedElsewhere.length + scope.quotedStillIn.length;
  if (holding > MAX_FIX_CHECK_PATHS) {
    return [
      `${id}: the code the blocker quotes occurs in ${holding} other files, more than a fix check is shown (${MAX_FIX_CHECK_PATHS}), so no fix of it is taken (${scope.quotedElsewhere.length} changed since with more of it, ${scope.quotedStillIn.length} that already held it)`,
    ];
  }
  if (quote.path !== where.path) return [`${id}: the fix is quoted from ${JSON.stringify(quote.path)}, not from ${JSON.stringify(where.path)}`];
  const changed = scope.files.get(where.path);
  if (changed === undefined) {
    return [`${id}: the fix is quoted from ${JSON.stringify(where.path)}, which is not tied to the blocker (a file it names or the path git pairs it with as renamed, a changed file its quoted code now occurs in more often than it did, a test of one, or a file one hop from one)`];
  }
  const text = ctx.files.text(where.path) ?? "";
  const slice = text.split("\n").slice(where.startLine - 1, where.endLine).join("\n");
  const wanted = lf(quote.text);
  let found = false;
  for (let at = slice.indexOf(wanted); at >= 0; at = slice.indexOf(wanted, at + 1)) {
    found = true;
    const first = where.startLine + (slice.slice(0, at).match(/\n/g)?.length ?? 0);
    const last = first + (wanted.match(/\n/g)?.length ?? 0);
    for (let line = first; line <= last; line++) if (changed.has(line)) return [];
  }
  if (!found) return [`${id}: the fix's quote is not within ${where.path}:${where.startLine}-${where.endLine}`];
  return [`${id}: the quoted fix touches no line of ${where.path} that changed since the blocker was found`];
}

function errorsUnder(errors: readonly SchemaError[], prefix: string): SchemaError[] {
  return errors.filter((error) => error.path === prefix || error.path.startsWith(`${prefix}/`));
}

function describe(error: SchemaError): string {
  return `${error.path === "" ? "(root)" : error.path} ${error.message}`;
}

/** Validates one session's structured output against the rules of spec 07 §2.8. Pure. */
export function validateOutput(output: unknown, ctx: ValidationContext): ValidatedOutput {
  const errors = compileSchema(ctx.schema)(output);
  const findingErrors = new Map<number, SchemaError[]>();
  const priorErrors = new Map<number, SchemaError[]>();
  const structure: string[] = [];
  for (const error of errors) {
    const finding = /^\/findings\/([0-9]+)(?:\/|$)/.exec(error.path);
    const prior = /^\/priorBlockers\/([0-9]+)(?:\/|$)/.exec(error.path);
    if (finding !== null) {
      const index = Number(finding[1]);
      findingErrors.set(index, [...(findingErrors.get(index) ?? []), error]);
    } else if (prior !== null) {
      const index = Number(prior[1]);
      priorErrors.set(index, [...(priorErrors.get(index) ?? []), error]);
    } else structure.push(describe(error));
  }
  if (!isJsonObject(output)) {
    return {
      structureProblems: structure.length > 0 ? structure : ["the output is not an object"],
      done: false,
      missingItems: [...ctx.checklist],
      flaggedItems: [],
      findings: [],
      procedureGaps: [],
      prior: [],
    };
  }
  const done = output["done"] === true;
  const checked = Array.isArray(output["checked"]) ? output["checked"] : [];
  const named = new Set<string>();
  const flagged = new Set<string>();
  for (const entry of checked) {
    if (!isJsonObject(entry) || typeof entry["item"] !== "string") continue;
    named.add(entry["item"]);
    if (entry["verdict"] === "finding") flagged.add(entry["item"]);
  }
  const missingItems = ctx.checklist.filter((id) => !named.has(id));
  const flaggedItems = ctx.checklist.filter((id) => flagged.has(id));

  const findings: FindingCheck[] = [];
  const rawFindings = Array.isArray(output["findings"]) ? output["findings"] : [];
  rawFindings.forEach((raw, index) => {
    const schemaProblems = (findingErrors.get(index) ?? []).map(describe);
    if (schemaProblems.length > 0) {
      findings.push({ index, finding: raw, ok: false, problems: schemaProblems });
      return;
    }
    const finding = raw as unknown as Finding;
    const problems: string[] = [];
    for (const where of finding.where) problems.push(...whereProblems(where, ctx, ctx.allowed));
    for (const quote of finding.quotes) problems.push(...quoteProblems(quote, ctx));
    findings.push({ index, finding: raw, ok: problems.length === 0, problems });
  });

  const prior: PriorCheck[] = [];
  const rawPrior = Array.isArray(output["priorBlockers"]) ? output["priorBlockers"] : [];
  rawPrior.forEach((raw, index) => {
    if (!isJsonObject(raw) || typeof raw["id"] !== "string") return;
    const id = raw["id"];
    const schemaProblems = (priorErrors.get(index) ?? []).map(describe);
    if (schemaProblems.length > 0) {
      prior.push({ id, status: "open", problems: schemaProblems, notAccepted: [] });
      return;
    }
    if (raw["status"] !== "fixed") {
      prior.push({ id, status: "open", problems: [], notAccepted: [] });
      return;
    }
    const fixWhere = raw["fixWhere"] as unknown as Where | undefined;
    const fixQuote = raw["fixQuote"] as unknown as Quote | undefined;
    if (fixWhere === undefined || fixQuote === undefined) {
      prior.push({ id, status: "open", problems: [], notAccepted: [`${id} is marked fixed without a quoted fix at a path:line`] });
      return;
    }
    // Rules 2 and 3: a place outside the tree or a quote that is not in its file is a wrong answer.
    const problems = [...whereProblems(fixWhere, ctx, null), ...quoteProblems(fixQuote, ctx)];
    if (problems.length > 0) {
      prior.push({ id, status: "open", problems, notAccepted: [] });
      return;
    }
    // A true quote the engine cannot take as a fix leaves the blocker open; the output stands.
    const notAccepted = fixProblems(id, fixWhere, fixQuote, ctx);
    prior.push(notAccepted.length === 0 ? { id, status: "fixed", problems: [], notAccepted, fixWhere, fixQuote } : { id, status: "open", problems: [], notAccepted, fixWhere, fixQuote });
  });

  const gaps = Array.isArray(output["procedureGaps"]) ? output["procedureGaps"].filter((gap): gap is string => typeof gap === "string") : [];
  return { structureProblems: structure, done, missingItems, flaggedItems, findings, procedureGaps: gaps, prior };
}

/** The first reason an output breaks the rules, or null when it keeps them all. */
export function outputProblem(result: ValidatedOutput): string | null {
  if (result.structureProblems.length > 0) return `schema: ${result.structureProblems[0]}`;
  if (!result.done) return "the session reported done: false";
  if (result.missingItems.length > 0) return `checked omits ${result.missingItems.join(", ")}`;
  // An item marked as a finding with no finding reported is an answer the gate cannot see.
  if (result.flaggedItems.length > 0 && result.findings.length === 0) return `checked marks ${result.flaggedItems.join(", ")} as a finding but reports no finding`;
  const finding = result.findings.find((check) => !check.ok);
  if (finding !== undefined) return `finding ${finding.index}: ${finding.problems[0] ?? "invalid"}`;
  const prior = result.prior.find((check) => check.problems.length > 0);
  if (prior !== undefined) return `prior blocker ${prior.id}: ${prior.problems[0] ?? "invalid"}`;
  return null;
}
