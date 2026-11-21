// The verdict table (spec 07 §2.9), row by row (T-RV-16), and the confirmed severity (T-RV-17).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { combine, maxSeverity } from "../src/review/verdicts.ts";
import type { Step, Verdict } from "../src/review/verdicts.ts";

const C: Verdict = { verdict: "CONFIRMED", guarded: false };
const U: Verdict = { verdict: "UNSURE", guarded: false };
const R: Verdict = { verdict: "REFUTED", guarded: true };
const Rbare: Verdict = { verdict: "REFUTED", guarded: false };

function outcome(step: Step): string {
  if (step.kind === "outcome") return `${step.outcome}:${step.severity}`;
  if (step.kind === "sceptic") return step.role;
  return "second-look";
}

describe("combine (T-RV-16)", () => {
  for (const severity of ["low", "medium"] as const) {
    it(`${severity}: one sceptic on the overall model, then the table`, () => {
      assert.equal(outcome(combine(severity, [])), "sceptic1");
      assert.equal(outcome(combine(severity, [C])), `confirmed:${severity}`);
      assert.equal(outcome(combine(severity, [R])), "second-look");
      assert.equal(outcome(combine(severity, [U])), "sceptic3");
      assert.equal(outcome(combine(severity, [Rbare])), "sceptic3", "a refutation without quoted guards counts as UNSURE");
      assert.equal(outcome(combine(severity, [U, U])), `plausible:${severity}`, "UNSURE again is plausible, never dropped");
      assert.equal(outcome(combine(severity, [U, C])), `confirmed:${severity}`);
      assert.equal(outcome(combine(severity, [U, R])), "second-look");
    });
  }

  for (const severity of ["high", "critical"] as const) {
    it(`${severity}: two sceptics apart, the second on the attack model, then the table`, () => {
      assert.equal(outcome(combine(severity, [])), "sceptic1");
      assert.equal(outcome(combine(severity, [C])), "sceptic2");
      assert.equal(outcome(combine(severity, [R])), "sceptic2");
      assert.equal(outcome(combine(severity, [C, C])), `confirmed:${severity}`);
      assert.equal(outcome(combine(severity, [C, U])), `confirmed:${severity}`);
      assert.equal(outcome(combine(severity, [U, C])), `confirmed:${severity}`);
      assert.equal(outcome(combine(severity, [U, U])), `plausible:${severity}`);
      assert.equal(outcome(combine(severity, [Rbare, U])), `plausible:${severity}`, "an unguarded refutation is UNSURE");
      for (const pair of [[R, C], [C, R], [R, U], [U, R]]) assert.equal(outcome(combine(severity, pair)), "sceptic3");
      assert.equal(outcome(combine(severity, [R, C, C])), `confirmed:${severity}`);
      assert.equal(outcome(combine(severity, [R, U, U])), `plausible:${severity}`);
      assert.equal(outcome(combine(severity, [R, C, R])), "second-look", "REFUTED with guards gives refuted and a second look (S7-18)");
      assert.equal(outcome(combine(severity, [R, R])), "second-look");
    });
  }
});

describe("the confirmed severity (T-RV-17)", () => {
  it("is the highest any confirming sceptic gave; a confirming sceptic that gave none keeps the finding's", () => {
    assert.equal(outcome(combine("high", [{ ...C, severity: "critical" }, { ...C, severity: "medium" }])), "confirmed:critical");
    assert.equal(outcome(combine("high", [{ ...C, severity: "medium" }, U])), "confirmed:medium");
    assert.equal(outcome(combine("high", [C, { ...C, severity: "medium" }])), "confirmed:high");
    assert.equal(outcome(combine("medium", [{ ...C, severity: "low" }])), "confirmed:low");
    assert.equal(outcome(combine("low", [U, { ...C, severity: "high" }])), "confirmed:high");
    assert.equal(outcome(combine("high", [{ ...U, severity: "low" }, U])), "plausible:high", "an UNSURE sceptic's severity does not count");
    assert.equal(maxSeverity("low", "critical"), "critical");
  });
});
