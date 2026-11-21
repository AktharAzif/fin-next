// Finding validation, in code, before any other session or any builder sees a finding (spec 07
// §2.8; [RV-21]): rule 1 the output matches its schema; rule 2 every `where.path` is a file of the
// reviewed head (at the base for a deletion) inside what the session was given, its lines within
// the file; rule 3 every quote is an exact substring of the named file after CRLF becomes LF; rule 4
// the length caps (in the schema); rule 6 `checked` names every checklist item. Rule 5 (the
// injection filter) lands with the procedure's pattern list (open item).
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
}

export interface FindingCheck {
  readonly index: number;
  readonly finding: unknown;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface PriorCheck {
  readonly id: string;
  /** "fixed" only with a valid quote of the fix. */
  readonly status: "fixed" | "open";
  readonly problems: readonly string[];
  readonly fixWhere?: Where;
  readonly fixQuote?: Quote;
}

export interface ValidatedOutput {
  readonly structureProblems: readonly string[];
  readonly done: boolean;
  readonly missingItems: readonly string[];
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
    return { structureProblems: structure.length > 0 ? structure : ["the output is not an object"], done: false, missingItems: [...ctx.checklist], findings: [], procedureGaps: [], prior: [] };
  }
  const done = output["done"] === true;
  const checked = Array.isArray(output["checked"]) ? output["checked"] : [];
  const named = new Set<string>();
  for (const entry of checked) if (isJsonObject(entry) && typeof entry["item"] === "string") named.add(entry["item"]);
  const missingItems = ctx.checklist.filter((id) => !named.has(id));

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
      prior.push({ id, status: "open", problems: schemaProblems });
      return;
    }
    if (raw["status"] !== "fixed") {
      prior.push({ id, status: "open", problems: [] });
      return;
    }
    const fixWhere = raw["fixWhere"] as unknown as Where | undefined;
    const fixQuote = raw["fixQuote"] as unknown as Quote | undefined;
    if (fixWhere === undefined || fixQuote === undefined) {
      prior.push({ id, status: "open", problems: [`${id} is marked fixed without a quoted fix at a path:line`] });
      return;
    }
    const problems = [...whereProblems(fixWhere, ctx, null), ...quoteProblems(fixQuote, ctx)];
    prior.push(problems.length === 0 ? { id, status: "fixed", problems, fixWhere, fixQuote } : { id, status: "open", problems });
  });

  const gaps = Array.isArray(output["procedureGaps"]) ? output["procedureGaps"].filter((gap): gap is string => typeof gap === "string") : [];
  return { structureProblems: structure, done, missingItems, findings, procedureGaps: gaps, prior };
}

/** The first reason an output breaks the rules, or null when it keeps them all. */
export function outputProblem(result: ValidatedOutput): string | null {
  if (result.structureProblems.length > 0) return `schema: ${result.structureProblems[0]}`;
  if (!result.done) return "the session reported done: false";
  if (result.missingItems.length > 0) return `checked omits ${result.missingItems.join(", ")}`;
  const finding = result.findings.find((check) => !check.ok);
  if (finding !== undefined) return `finding ${finding.index}: ${finding.problems[0] ?? "invalid"}`;
  const prior = result.prior.find((check) => check.problems.length > 0);
  if (prior !== undefined) return `prior blocker ${prior.id}: ${prior.problems[0] ?? "invalid"}`;
  return null;
}
