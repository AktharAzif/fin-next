// What a review run leaves in $FIN_REVIEW_HOME/runs/<run-id>/ (spec 07 §2.12, §5.5, §7.4) and the
// counts it prints. The run directory holds the findings and their text; stdout holds counts only,
// never a title, path or quote.

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../clock.ts";
import type { Tier } from "../roles.ts";
import type { Finding, Severity } from "./findings.ts";
import { SEVERITIES } from "./findings.ts";

export type LensState = "pending" | "running" | "done" | "incomplete" | "refused" | "budget_reached" | "cancelled";
export type RunResultName = "pass" | "blocked" | "could_not_check";
export type FindingState = "invalid" | "kept" | "confirmed" | "plausible" | "refuted" | "unverified";

export interface VerdictRecord {
  readonly role: string;
  readonly session: string;
  readonly verdict: string;
  readonly severity?: Severity;
  readonly guarded: boolean;
  readonly guardQuotes: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  readonly reason: string;
}

export interface SecondLookRecord {
  readonly session: string;
  readonly verdict: "BROKEN" | "STANDS";
  readonly quotes: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  readonly reason: string;
}

export interface FindingRecord {
  readonly id: string;
  readonly session: string;
  readonly lensKey: string;
  state: FindingState;
  /** Why an invalid finding was refused (rules 1 to 4). */
  readonly problems: readonly string[];
  /** The finding as reported (raw when invalid). */
  readonly finding: unknown;
  readonly reportedSeverity: Severity | null;
  severity: Severity | null;
  readonly tier: Tier | null;
  readonly verdicts: VerdictRecord[];
  readonly secondLooks: SecondLookRecord[];
  verifyIssue: string | null;
  blocking: boolean;
  blockingRule: string | null;
  /** Set for a prior blocker carried from the last reviewed head. */
  readonly carriedFrom?: string;
}

export interface Blocker {
  readonly rule: "confirmed" | "plausible" | "lens" | "test-cannot-fail" | "coverage" | "unverified" | "prior";
  readonly finding?: string;
  readonly lens?: string;
  /** A changed path no lens could review (a coverage gap). */
  readonly path?: string;
  readonly detail: string;
}

/** A changed path that is not a unit: why, its tier, and whether it blocks. */
export interface NotUnitRecord {
  readonly path: string;
  readonly tier: Tier;
  readonly note: string;
  readonly blocking: boolean;
}

export interface OpenBlocker {
  readonly id: string;
  readonly lensKey: string;
  readonly lens: string;
  readonly profile: string | null;
  readonly finding: Finding;
}

export interface RunSummary {
  readonly v: 1;
  readonly runId: string;
  readonly mode: "pr" | "commit";
  readonly requestedMode: "pr" | "commit";
  readonly escalated: string | null;
  readonly since: string | null;
  readonly pr: number;
  readonly head: string;
  /** The base branch the pull request names, and its tip when the run read it. */
  readonly baseRef: string;
  readonly base: string;
  /** The default branch, whose layout gave the tiers and whose merge base with the head the run reviewed from. */
  readonly defaultBranch: string;
  readonly defaultTip: string;
  readonly mergeBase: string;
  /** The gating chain's tier: the change's, and in `commit` never below the last reviewed head's. */
  readonly tier: Tier | null;
  /** The tier of what this run reviewed (in `commit`, the delta's), which chose its lenses. */
  readonly deltaTier: Tier | null;
  readonly result: RunResultName;
  readonly exitCode: number;
  readonly advisory: boolean;
  readonly options: unknown;
  readonly lenses: Readonly<Record<string, LensState>>;
  readonly lensNames: readonly string[];
  readonly profiles: readonly string[];
  readonly counts: Counts;
  /** Every changed path that is not a unit (deleted, excluded by content, binary, a submodule, missing). */
  readonly notUnits: readonly NotUnitRecord[];
  readonly blockers: readonly Blocker[];
  readonly openBlockers: readonly OpenBlocker[];
  readonly sessions: number;
  readonly costMicroUsd: number;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface Counts {
  readonly units: number;
  readonly sessions: number;
  readonly findings: Readonly<Record<FindingState, number>>;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly lenses: Readonly<Record<LensState, number>>;
  readonly blockers: number;
}

const FINDING_STATES: readonly FindingState[] = ["invalid", "kept", "confirmed", "plausible", "refuted", "unverified"];
const LENS_STATES: readonly LensState[] = ["pending", "running", "done", "incomplete", "refused", "budget_reached", "cancelled"];

export function countFindings(records: readonly FindingRecord[], lenses: Readonly<Record<string, LensState>>, units: number, sessions: number, blockers: number): Counts {
  const findings = Object.fromEntries(FINDING_STATES.map((state) => [state, 0])) as Record<FindingState, number>;
  const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<Severity, number>;
  for (const record of records) {
    findings[record.state]++;
    if (record.state !== "invalid" && record.state !== "refuted" && record.severity !== null) bySeverity[record.severity]++;
  }
  const lensCounts = Object.fromEntries(LENS_STATES.map((state) => [state, 0])) as Record<LensState, number>;
  for (const state of Object.values(lenses)) lensCounts[state]++;
  return { units, sessions, findings, bySeverity, lenses: lensCounts, blockers };
}

/** The lines printed on stdout: counts only. */
export function countLines(summary: RunSummary): string {
  const c = summary.counts;
  const f = c.findings;
  const s = c.bySeverity;
  const l = c.lenses;
  const mode = summary.escalated === null ? summary.mode : `${summary.mode} (escalated from commit: ${summary.escalated})`;
  return [
    `fin-review ${mode} #${summary.pr} at ${summary.head.slice(0, 12)}: ${summary.result}${summary.advisory ? " (advisory: not a gate receipt)" : ""}`,
    `  tier ${summary.tier ?? "-"}; ${c.units} units; ${summary.lensNames.length} lenses; ${summary.profiles.length} attack profiles; ${c.sessions} sessions`,
    `  findings: ${f.confirmed} confirmed, ${f.plausible} plausible, ${f.unverified} unverified, ${f.refuted} refuted, ${f.invalid} invalid`,
    `  by severity (not refuted): ${s.critical} critical, ${s.high} high, ${s.medium} medium, ${s.low} low`,
    `  lenses: ${l.done} done, ${l.incomplete} incomplete, ${l.refused} refused, ${l.budget_reached} budget_reached, ${l.cancelled} cancelled`,
    ...(summary.notUnits.length === 0
      ? []
      : [`  not units: ${summary.notUnits.length} changed paths (${summary.notUnits.filter((item) => item.blocking).length} no lens could review)`]),
    `  blockers: ${c.blockers}`,
    `  run: ${summary.runId}`,
    "",
  ].join("\n");
}

function md(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\|/g, "\\|");
}

/** The run's markdown summary (local; it holds finding text). */
export function summaryMarkdown(summary: RunSummary, records: readonly FindingRecord[]): string {
  const out: string[] = [];
  out.push(`# fin-review ${summary.mode} #${summary.pr}`, "");
  out.push(
    `- Head: \`${summary.head}\``,
    `- Base: ${summary.baseRef} at \`${summary.base}\`; reviewed from the merge base \`${summary.mergeBase}\` with ${summary.defaultBranch} (\`${summary.defaultTip}\`)`,
    `- Tier: ${summary.tier ?? "-"}${summary.deltaTier === summary.tier ? "" : ` (this run's change: ${summary.deltaTier ?? "-"})`}`,
  );
  out.push(`- Result: **${summary.result}** (exit ${summary.exitCode})${summary.advisory ? ", advisory: not a gate receipt" : ""}`);
  if (summary.escalated !== null) out.push(`- Escalated from \`commit\` to \`pr\`: ${summary.escalated}`);
  out.push(`- Run: \`${summary.runId}\`; ${summary.counts.sessions} sessions; estimated cost ${(summary.costMicroUsd / 1_000_000).toFixed(2)} USD`, "");
  out.push("## Lenses", "", "| Lens | State |", "|---|---|");
  for (const [key, state] of Object.entries(summary.lenses)) out.push(`| ${md(key)} | ${state} |`);
  out.push("");
  out.push("## Blockers", "");
  if (summary.blockers.length === 0) out.push("None.");
  for (const blocker of summary.blockers) {
    out.push(`- ${blocker.rule}${blocker.finding === undefined ? "" : ` ${blocker.finding}`}${blocker.lens === undefined ? "" : ` (${md(blocker.lens)})`}: ${md(blocker.detail)}`);
  }
  out.push("");
  if (summary.notUnits.length > 0) {
    out.push("## Changed paths with no unit", "", "| Path | Tier | Why | Blocks |", "|---|---|---|---|");
    for (const item of summary.notUnits) out.push(`| \`${md(item.path)}\` | ${item.tier} | ${md(item.note)} | ${item.blocking ? "yes" : "no"} |`);
    out.push("");
  }
  const shown = records.filter((record) => record.state !== "invalid");
  out.push("## Findings", "");
  if (shown.length === 0) out.push("None.");
  for (const record of shown) {
    const finding = record.finding as Finding;
    out.push(`### ${record.id}: ${md(finding.title)}`, "");
    out.push(`- State: **${record.state}**${record.blocking ? " (blocking)" : ""}; severity ${record.severity ?? "-"} (reported ${record.reportedSeverity ?? "-"}); lens ${md(record.lensKey)}; class ${md(finding.class)}`);
    out.push(`- Where: ${finding.where.map((where) => `\`${md(where.path)}:${where.startLine}-${where.endLine}\``).join(", ")}`);
    out.push(`- Claim: ${md(finding.claim)}`, `- Scenario: ${md(finding.scenario)}`, `- Test that should fail: ${md(finding.testShouldFail)}`);
    for (const verdict of record.verdicts) out.push(`- ${verdict.role}: ${verdict.verdict}${verdict.guarded ? " (guards quoted)" : ""}: ${md(verdict.reason)}`);
    for (const look of record.secondLooks) out.push(`- second look: ${look.verdict}: ${md(look.reason)}`);
    if (record.verifyIssue !== null) out.push(`- Not verified: ${md(record.verifyIssue)}`);
    out.push("");
  }
  const invalid = records.length - shown.length;
  if (invalid > 0) out.push(`${invalid} invalid candidate findings were recorded in findings.json and are not shown (spec 07 §2.8).`, "");
  return out.join("\n");
}

/** Appends review.* lines to the run's lines.jsonl (spec 07 §12.2, written locally). */
export class Lines {
  private readonly path: string;
  private readonly clock: Clock;
  private readonly runId: string;

  constructor(runDir: string, runId: string, clock: Clock) {
    this.path = join(runDir, "lines.jsonl");
    this.clock = clock;
    this.runId = runId;
  }

  write(event: string, fields: Record<string, unknown> = {}): void {
    appendFileSync(this.path, `${JSON.stringify({ at: new Date(this.clock.now()).toISOString(), event, runId: this.runId, ...fields })}\n`, { mode: 0o600 });
  }
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
