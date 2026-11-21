// The verdict table (spec 07 §2.9, T-RV-16), as one pure function: given a finding's severity and
// the sceptics' verdicts so far, the next session to run or the outcome.
//
// | Severity       | Verdicts so far                                   | Next                              |
// |----------------|---------------------------------------------------|-----------------------------------|
// | low, medium    | none                                              | sceptic1                          |
// | low, medium    | CONFIRMED                                         | confirmed                         |
// | low, medium    | REFUTED with quoted guards                        | second look                       |
// | low, medium    | UNSURE                                            | a second sceptic (sceptic3)       |
// | low, medium    | UNSURE, then CONFIRMED / UNSURE / REFUTED+guards  | confirmed / plausible / second look |
// | high, critical | none / one                                        | sceptic1 / sceptic2 (attack model)|
// | high, critical | both CONFIRMED, or CONFIRMED and UNSURE           | confirmed                         |
// | high, critical | both UNSURE                                       | plausible                         |
// | high, critical | one REFUTED+guards, other CONFIRMED or UNSURE     | sceptic3: CONFIRMED confirmed, UNSURE plausible, REFUTED+guards refuted with a second look |
// | high, critical | both REFUTED with guards                          | second look                       |
//
// A REFUTED verdict without quoted guards counts as UNSURE. A confirmed finding takes the highest
// severity any confirming sceptic gave (a confirming sceptic that gave none keeps the finding's).

import type { Severity } from "./findings.ts";

export type VerdictName = "CONFIRMED" | "REFUTED" | "UNSURE";

export interface Verdict {
  readonly verdict: VerdictName;
  readonly severity?: Severity;
  /** True when every guard quote validated and there is at least one. */
  readonly guarded: boolean;
}

export type Outcome = "confirmed" | "plausible" | "refuted";

export type Step =
  | { readonly kind: "sceptic"; readonly role: "sceptic1" | "sceptic2" | "sceptic3" }
  | { readonly kind: "second-look" }
  | { readonly kind: "outcome"; readonly outcome: Outcome; readonly severity: Severity };

const RANK: Readonly<Record<Severity, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

export function severityRank(severity: Severity): number {
  return RANK[severity];
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return RANK[a] >= RANK[b] ? a : b;
}

type Effective = "C" | "R" | "U";

function effective(verdict: Verdict): Effective {
  if (verdict.verdict === "CONFIRMED") return "C";
  if (verdict.verdict === "REFUTED" && verdict.guarded) return "R";
  return "U";
}

function confirmed(severity: Severity, verdicts: readonly Verdict[]): Step {
  let out: Severity | null = null;
  for (const verdict of verdicts) {
    if (verdict.verdict !== "CONFIRMED") continue;
    const given = verdict.severity ?? severity;
    out = out === null ? given : maxSeverity(out, given);
  }
  return { kind: "outcome", outcome: "confirmed", severity: out ?? severity };
}

/** The next step for a finding of `severity` after `verdicts` (in the order they were given). */
export function combine(severity: Severity, verdicts: readonly Verdict[]): Step {
  const v = verdicts.map(effective);
  const plausible: Step = { kind: "outcome", outcome: "plausible", severity };
  if (severity === "low" || severity === "medium") {
    if (v.length === 0) return { kind: "sceptic", role: "sceptic1" };
    const [first, second] = v;
    if (first === "C") return confirmed(severity, verdicts);
    if (first === "R") return { kind: "second-look" };
    if (second === undefined) return { kind: "sceptic", role: "sceptic3" };
    if (second === "C") return confirmed(severity, verdicts);
    if (second === "R") return { kind: "second-look" };
    return plausible;
  }
  if (v.length === 0) return { kind: "sceptic", role: "sceptic1" };
  if (v.length === 1) return { kind: "sceptic", role: "sceptic2" };
  const pair = v.slice(0, 2);
  const refuted = pair.filter((item) => item === "R").length;
  if (refuted === 2) return { kind: "second-look" };
  if (refuted === 0) return pair.includes("C") ? confirmed(severity, verdicts) : plausible;
  const third = v[2];
  if (third === undefined) return { kind: "sceptic", role: "sceptic3" };
  if (third === "C") return confirmed(severity, verdicts);
  if (third === "R") return { kind: "second-look" };
  return plausible;
}
