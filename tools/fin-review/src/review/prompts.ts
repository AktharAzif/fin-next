// Session prompts (spec 07 §2.5, §4.8). The user message holds the evidence first, inside DATA
// markers headed by the DATA rule, and the role's instruction last, so the sessions of one shard
// share a cached prefix. Repository text (file contents, paths, findings that quote them) only
// ever appears inside a DATA block; the instruction part holds only the procedure's own text. No
// timestamp, run ID, session ID or machine name appears in a prompt.

import { createHash } from "node:crypto";
import type { Unit } from "../units/inventory.ts";
import type { Finding } from "./findings.ts";
import type { AttackProfile, ChecklistItem } from "./procedure.ts";
import { DATA_RULE } from "./procedure.ts";

/** The context pack's budget: 60,000 estimated tokens, at 3.5 bytes a token (spec 07 §2.5). */
export const PACK_TOKENS = 60_000;
/** One-hop heads add at most this many estimated tokens (spec 07 §5.5). */
export const HEADS_TOKENS = 10_000;
const BYTES_PER_TOKEN = 3.5;

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptError";
  }
}

/** `text`'s lines prefixed with their numbers, starting at `first`, as the Read tool shows them. */
export function numbered(text: string, first: number): string {
  return text
    .split("\n")
    .map((line, index) => `${first + index}\t${line}`)
    .join("\n");
}

/** A whole file's text, numbered from 1, and its line count (a final newline starts no line). */
export function numberedFile(text: string): { text: string; lines: number } {
  const lines = text.split("\n");
  const count = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  return { text: numbered(lines.slice(0, count).join("\n"), 1), lines: count };
}

/** Where a unit lies in its file; a symbolic link says so, because its one line is the path it points to. */
function unitPlace(unit: Unit): string {
  const lines = `lines ${unit.startLine}-${unit.endLine} of ${unit.totalLines}`;
  return unit.kind === "link" ? `${lines}; a symbolic link, whose text is the path it points to` : lines;
}

/** A block of repository text, headed by the DATA rule, between markers no content can forge. */
export function dataBlock(content: string): string {
  const id = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
  const end = `===== END DATA ${id} =====`;
  if (content.includes(end)) throw new PromptError("repository text holds its own DATA end marker");
  return `${DATA_RULE}\n\n===== DATA ${id} =====\n${content}\n${end}\n`;
}

export interface PackInput {
  readonly units: readonly Unit[];
  readonly tests: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  readonly heads: ReadonlyArray<{ readonly path: string; readonly lines: readonly string[] }>;
  readonly oneHop: readonly string[];
  readonly digest: string | null;
  /** In a delta mode, each changed unit's diff since the last reviewed head. */
  readonly diffs?: ReadonlyArray<{ readonly path: string; readonly text: string }>;
}

export interface ContextPack {
  readonly content: string;
  readonly tokens: number;
  readonly cutHeads: number;
  readonly cutTests: number;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The context pack of one shard: the scope, each unit's numbered text, its read tests, the one-hop
 * files' export heads and the rules digest. Over budget, heads are cut first, then tests; a unit
 * never.
 */
export function buildContextPack(input: PackInput, budgetTokens: number = PACK_TOKENS): ContextPack {
  const budget = Math.floor(budgetTokens * BYTES_PER_TOKEN);
  const unitParts = input.units.map((unit) => `# Unit ${unit.path} (${unitPlace(unit)})\n${numbered(unit.text, unit.startLine)}\n`);
  const diffParts = (input.diffs ?? []).map((diff) => `# Diff ${diff.path} (since the last reviewed head)\n${diff.text}\n`);
  let tests = input.tests.map((test) => {
    const file = numberedFile(test.text);
    return `# Test ${test.path} (lines 1-${file.lines} of ${file.lines})\n${file.text}\n`;
  });
  let heads = input.heads
    .filter((head) => head.lines.length > 0)
    .map((head) => `# One-hop export heads: ${head.path}\n${head.lines.join("\n")}\n`);
  const headsBudget = Math.floor(HEADS_TOKENS * BYTES_PER_TOKEN);
  let cutHeads = 0;
  while (heads.length > 0 && bytes(heads.join("")) > headsBudget) {
    heads = heads.slice(0, -1);
    cutHeads++;
  }
  const digest = input.digest === null ? "" : `# Rules digest\n${input.digest}\n`;
  const scope = (): string =>
    [
      "# Scope",
      "Units under review:",
      ...input.units.map((unit) => `- ${unit.path} ${unitPlace(unit)}`),
      "Read tests:",
      ...(tests.length === 0 ? ["- none"] : input.tests.slice(0, tests.length).map((test) => `- ${test.path}`)),
      "Files one hop away (imports and importers), which findings may also name:",
      ...(input.oneHop.length === 0 ? ["- none"] : input.oneHop.map((path) => `- ${path}`)),
      "",
    ].join("\n");
  const assemble = (): string => [scope(), ...unitParts, ...diffParts, ...tests, ...heads, digest].join("\n");
  let content = assemble();
  let cutTests = 0;
  while (bytes(content) > budget && heads.length > 0) {
    heads = heads.slice(0, -1);
    cutHeads++;
    content = assemble();
  }
  while (bytes(content) > budget && tests.length > 0) {
    tests = tests.slice(0, -1);
    cutTests++;
    content = assemble();
  }
  return { content, tokens: Math.ceil(bytes(content) / BYTES_PER_TOKEN), cutHeads, cutTests };
}

function checklistText(items: readonly ChecklistItem[]): string {
  return items.map((item) => `- **${item.id}** ${item.text}`).join("\n");
}

export interface LensPromptInput {
  /** The shared DATA block of the shard (or of the patch, for joins). */
  readonly evidence: string;
  /** More DATA blocks for this session only (the rules files, the prior blockers). */
  readonly extra: readonly string[];
  /** The lens's instruction (prompts/lens-<lens>.md, or attack.md). */
  readonly instruction: string;
  readonly lens: string;
  readonly checklist: readonly ChecklistItem[];
  readonly profile?: AttackProfile;
  readonly priorIds: readonly string[];
}

/** The whole user message of a lens, joins, test-truth or attack session. */
export function lensPrompt(input: LensPromptInput): string {
  const parts = [input.evidence, ...input.extra, "# Your task", "", input.instruction.trim(), ""];
  if (input.profile !== undefined) {
    parts.push("## Your profile", "", `Profile \`${input.profile.id}\` (${input.profile.day}). Actor and question: ${input.profile.actor}.`, "");
  }
  parts.push("## Checklist", "", checklistText(input.checklist), "");
  parts.push(
    "## What to return",
    "",
    `Return the structured output. \`checked\` holds one entry for every checklist item above. Every finding has \`lens\` set to \`${input.lens}\`${
      input.profile === undefined ? "" : ` and \`profile\` set to \`${input.profile.id}\``
    }. Set \`done\` to true only when you have worked through every item.`,
    "",
  );
  if (input.priorIds.length > 0) {
    parts.push(
      "## Prior blockers",
      "",
      `The blocking findings open at the last reviewed head are in the DATA block headed "Prior blockers" (${input.priorIds.join(", ")}). For each, return an entry in \`priorBlockers\` with its \`id\`: \`fixed\` only with \`fixWhere\` and \`fixQuote\` quoting the fix exactly as it is in the tree, otherwise \`open\`. Saying nothing keeps a blocker open.`,
      "",
    );
  }
  return parts.join("\n");
}

/** The fields of a finding a sceptic or second look may see: never the finder's other findings or confidence. */
export function findingEvidence(finding: Finding): Record<string, unknown> {
  return {
    lens: finding.lens,
    ...(finding.profile === undefined ? {} : { profile: finding.profile }),
    class: finding.class,
    severity: finding.severity,
    where: finding.where,
    quotes: finding.quotes,
    title: finding.title,
    claim: finding.claim,
    scenario: finding.scenario,
    testShouldFail: finding.testShouldFail,
    preExisting: finding.preExisting,
  };
}

/** The user message of a sceptic session. */
export function scepticPrompt(finding: Finding, instruction: string): string {
  const evidence = dataBlock(`# The candidate finding\n${JSON.stringify(findingEvidence(finding), null, 2)}\n`);
  return [evidence, "# Your task", "", instruction.trim(), ""].join("\n");
}

export interface Refutation {
  readonly verdict: string;
  readonly guardQuotes: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  readonly reason: string;
}

/** The user message of a second-look session. */
export function secondLookPrompt(finding: Finding, refutations: readonly Refutation[], instruction: string): string {
  const evidence = dataBlock(
    `# The candidate finding\n${JSON.stringify(findingEvidence(finding), null, 2)}\n\n# The refutation\n${JSON.stringify(refutations, null, 2)}\n`,
  );
  return [evidence, "# Your task", "", instruction.trim(), ""].join("\n");
}
