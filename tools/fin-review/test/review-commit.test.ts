// The `commit` mode: a delta, or escalation to `pr` (spec 07 §2.3.2), and the blockers it carries.

import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanOutput, countingRandom, cryptoFinding, readJson, reviewFixture, runDirs, runFixtureCli } from "./helpers/review-fixture.ts";
import type { ReviewFixture } from "./helpers/review-fixture.ts";
import { ENGINE_COPY, MODELS, calls, findingsOf, harness, isFixCheck, lastRun, script } from "./helpers/review-harness.ts";
import type { Handler, Harness } from "./helpers/review-harness.ts";

describe("commit: a delta, or escalation to pr (§2.3.2)", () => {
  let fx: ReviewFixture;
  const random = countingRandom();
  before(() => {
    fx = reviewFixture();
  });
  after(() => fx.cleanup());

  it("with no local run at the last reviewed head, escalates to pr (no_prior_run)", async () => {
    const h0 = fx.pr(1, { "packages/crypto/src/index.ts": "export const VERSION = 2;\n" });
    const h1 = fx.pr(1, { "packages/crypto/src/index.ts": "export const VERSION = 3;\n" }, h0);
    assert.notEqual(h0, h1);
    const h = harness(fx, script(), random);
    const run = await runFixtureCli(fx, ["commit", "--pr", "1", "--since", h0], h.services);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /^fin-review pr \(escalated from commit: no_prior_run\) #1/);
    assert.equal(readJson(join(lastRun(fx), "result.json"))["escalated"], "no_prior_run");
  });

  it("after a pr run at H0, a small delta stays commit; its prior blocker is shown and closes only with a quoted fix", async () => {
    // A pr run at H0 that leaves a confirmed medium blocker.
    const h0 = fx.pr(2, { "packages/crypto/src/index.ts": "export function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n" });
    const first = harness(fx, script((spec) => (spec.lens === "security" ? { kind: "result", output: cleanOutput(spec, [cryptoFinding(spec)]) } : undefined)), random);
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "2"], first.services)).code, 1);
    const priorId = String(findingsOf(lastRun(fx))[0]?.["id"]);

    // The fix, pushed as H1.
    const fixed = "import { timingSafeEqual } from \"node:crypto\";\n\nexport function sameSecret(a: string, b: string): boolean {\n  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));\n}\n";
    const h1 = fx.pr(2, { "packages/crypto/src/index.ts": fixed }, h0);

    // A security session that stays silent about the prior blocker keeps it open.
    const silent = harness(fx, script(), random);
    const open = await runFixtureCli(fx, ["commit", "--pr", "2", "--since", h0], silent.services);
    assert.equal(open.code, 1, open.stdout + open.stderr);
    assert.match(open.stdout, /^fin-review commit #2/);
    const security = calls(silent).find((call) => call.spec.lens === "security");
    assert.ok(security !== undefined);
    assert.match(security.spec.prompt, /# Prior blockers\n/);
    assert.match(security.spec.prompt, /"id": "P1"/);
    assert.ok(!security.spec.prompt.includes(priorId), "the prompt never holds a run ID");
    assert.match(security.spec.prompt, /# Diff packages\/crypto\/src\/index.ts \(since the last reviewed head\)/);
    const blockers = readJson(join(lastRun(fx), "result.json"))["blockers"] as Array<Record<string, unknown>>;
    assert.deepEqual(blockers.map((blocker) => blocker["rule"]), ["prior"]);

    // A fixed claim with an invented quote keeps it open too.
    const invented = harness(
      fx,
      script((spec) =>
        spec.lens === "security"
          ? { kind: "result", output: { ...cleanOutput(spec), priorBlockers: [{ id: "P1", status: "fixed", fixWhere: { path: "packages/crypto/src/index.ts", startLine: 4, endLine: 4 }, fixQuote: { path: "packages/crypto/src/index.ts", text: "constantTimeEquals(a, b)" } }] } }
          : undefined,
      ),
      random,
    );
    assert.equal((await runFixtureCli(fx, ["commit", "--pr", "2", "--since", h0], invented.services)).code, 2);

    // Quoting the fix closes it.
    const closing = harness(
      fx,
      script((spec) =>
        spec.lens === "security"
          ? { kind: "result", output: { ...cleanOutput(spec), priorBlockers: [{ id: "P1", status: "fixed", fixWhere: { path: "packages/crypto/src/index.ts", startLine: 4, endLine: 4 }, fixQuote: { path: "packages/crypto/src/index.ts", text: "timingSafeEqual(Buffer.from(a), Buffer.from(b))" } }] } }
          : undefined,
      ),
      random,
    );
    const closed = await runFixtureCli(fx, ["commit", "--pr", "2", "--since", h0], closing.services);
    assert.equal(closed.code, 0, closed.stdout + closed.stderr);
    assert.equal(readJson(join(lastRun(fx), "result.json"))["head"], h1);
  });

  it("escalates when the delta raises the tier (tier_raised)", async () => {
    const h0 = fx.pr(3, { "docs/plan/README.md": "# plan\n\nA.\n" });
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "3"], harness(fx, script(), random).services)).code, 0);
    fx.pr(3, { "packages/ui/src/button.ts": "export const button = 2;\n" }, h0);
    const run = await runFixtureCli(fx, ["commit", "--pr", "3", "--since", h0], harness(fx, script(), random).services);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /escalated from commit: tier_raised/);
  });

  it("escalates a delta over 400 lines (delta_lines) and a since that is not an ancestor (not_ancestor)", async () => {
    const h0 = fx.pr(4, { "docs/plan/README.md": "# plan\n\nB.\n" });
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "4"], harness(fx, script(), random).services)).code, 0);
    fx.pr(4, { "docs/plan/README.md": `# plan\n\n${"line\n".repeat(401)}` }, h0);
    const big = await runFixtureCli(fx, ["commit", "--pr", "4", "--since", h0], harness(fx, script(), random).services);
    assert.match(big.stdout, /escalated from commit: delta_lines/);
    // H0 at another branch: a run exists at it, but it is not an ancestor of the new head.
    const other = fx.pr(5, { "docs/plan/README.md": "# plan\n\nC.\n" });
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "5"], harness(fx, script(), random).services)).code, 0);
    fx.pr(5, { "docs/plan/README.md": "# plan\n\nD.\n" });
    const notAncestor = await runFixtureCli(fx, ["commit", "--pr", "5", "--since", other], harness(fx, script(), random).services);
    assert.match(notAncestor.stdout, /escalated from commit: not_ancestor/);
  });

  it("a changed path that starts with a dash is reviewed in a delta like any other", async () => {
    // A tier S chain, so the new root file (unmapped, so tier S) stays a delta.
    const h0 = fx.pr(11, { "packages/crypto/src/index.ts": "export const VERSION = 7;\n" });
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "11"], harness(fx, script(), random).services)).code, 0);
    fx.pr(11, { "-root-dash.md": "# dash\n" }, h0);
    const h = harness(fx, script(), random);
    const run = await runFixtureCli(fx, ["commit", "--pr", "11", "--since", h0], h.services);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^fin-review commit #11 /);
    assert.match(calls(h).find((call) => call.spec.lens === "correctness")?.spec.prompt ?? "", /# Diff -root-dash\.md \(since the last reviewed head\)\ndiff --git/);
  });

  it("escalates when the procedure changed since the prior run (procedure_changed)", async () => {
    const h0 = fx.pr(10, { "docs/plan/README.md": "# plan\n\nG.\n" });
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "10"], harness(fx, script(), random).services)).code, 0);
    assert.equal((readJson(join(lastRun(fx), "result.json"))["engine"] as Record<string, unknown>)["procedureHash"], ENGINE_COPY.procedureHash);
    fx.pr(10, { "docs/plan/README.md": "# plan\n\nH.\n" }, h0);
    const changedProcedure = harness(fx, script(), random);
    const run = await runFixtureCli(fx, ["commit", "--pr", "10", "--since", h0], { ...changedProcedure.services, engineCopy: async () => ({ ...ENGINE_COPY, procedureHash: "c".repeat(64) }) });
    assert.match(run.stdout, /escalated from commit: procedure_changed/);
  });

  it("a prior blocker is not closed by a quote of text that did not change since it was found", async () => {
    const h0 = fx.pr(8, { "packages/crypto/src/index.ts": "export function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n" });
    const first = harness(fx, script((spec) => (spec.lens === "security" ? { kind: "result", output: cleanOutput(spec, [cryptoFinding(spec)]) } : undefined)), random);
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "8"], first.services)).code, 1);
    fx.pr(8, { "docs/plan/README.md": "# plan\n\nNothing about the blocker.\n" }, h0);
    for (const claim of [
      { fixWhere: { path: "packages/crypto/src/index.ts", startLine: 2, endLine: 2 }, fixQuote: { path: "packages/crypto/src/index.ts", text: "return a === b;" } },
      { fixWhere: { path: "README.md", startLine: 1, endLine: 1 }, fixQuote: { path: "packages/crypto/src/index.ts", text: "return a === b;" } },
      { fixWhere: { path: "README.md", startLine: 1, endLine: 1 }, fixQuote: { path: "README.md", text: "# fin-next" } },
    ]) {
      const h = harness(fx, script((spec) => (spec.lens === "security" ? { kind: "result", output: { ...cleanOutput(spec), priorBlockers: [{ id: "P1", status: "fixed", ...claim }] } } : undefined)), random);
      const run = await runFixtureCli(fx, ["commit", "--pr", "8", "--since", h0], h.services);
      assert.notEqual(run.code, 0, JSON.stringify(claim));
      const result = readJson(join(lastRun(fx), "result.json"));
      assert.equal((result["openBlockers"] as unknown[]).length, 1, "the blocker stays open");
    }
  });

  it("blockers open at the last reviewed head survive an escalation to pr and a second pr, and close only with a real fix", async () => {
    const h0 = fx.pr(9, { "packages/crypto/src/index.ts": "export function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n" });
    const finder = harness(fx, script((spec) => (spec.lens === "security" ? { kind: "result", output: cleanOutput(spec, [cryptoFinding(spec, { severity: "critical" })]) } : undefined)), random);
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "9"], finder.services)).code, 1);
    // 450 lines of notes and the defect left alone: the commit escalates, and the fresh pass finds nothing.
    const h1 = fx.pr(9, { "docs/plan/notes.md": "note\n".repeat(450) }, h0);
    const escalated = harness(fx, script(), random);
    const run = await runFixtureCli(fx, ["commit", "--pr", "9", "--since", h0], escalated.services);
    assert.match(run.stdout, /escalated from commit: delta_lines/);
    assert.equal(run.code, 1, run.stdout + run.stderr);
    assert.match(calls(escalated).find((call) => call.spec.lens === "security")?.spec.prompt ?? "", /# Prior blockers\n/);
    const blockers = (readJson(join(lastRun(fx), "result.json"))["blockers"] as Array<Record<string, unknown>>).map((blocker) => blocker["rule"]);
    assert.deepEqual(blockers, ["prior"]);
    // A second pr on the same head carries it too.
    const again = await runFixtureCli(fx, ["pr", "--pr", "9"], harness(fx, script(), random).services);
    assert.equal(again.code, 1, again.stdout + again.stderr);
    // The fix, quoted from the lines it changed, closes it.
    const fixed = "import { timingSafeEqual } from \"node:crypto\";\n\nexport function sameSecret(a: string, b: string): boolean {\n  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));\n}\n";
    fx.pr(9, { "packages/crypto/src/index.ts": fixed }, h1);
    const closing = harness(
      fx,
      script((spec) =>
        spec.lens === "security"
          ? { kind: "result", output: { ...cleanOutput(spec), priorBlockers: [{ id: "P1", status: "fixed", fixWhere: { path: "packages/crypto/src/index.ts", startLine: 4, endLine: 4 }, fixQuote: { path: "packages/crypto/src/index.ts", text: "timingSafeEqual(Buffer.from(a), Buffer.from(b))" } }] } }
          : undefined,
      ),
      random,
    );
    const closed = await runFixtureCli(fx, ["pr", "--pr", "9"], closing.services);
    assert.equal(closed.code, 0, closed.stdout + closed.stderr);
  });

  it("a file no lens could review stays a blocker: a later commit, or the same head again, escalates to pr (prior_gap)", async () => {
    // Tier S, a NUL in its bytes and no media magic: binary, so no lens reads it, and it blocks.
    const h0 = fx.pr(15, { "scripts/release.sh": Buffer.from("#!/bin/sh\n# \0\necho marker\n", "latin1") });
    const first = await runFixtureCli(fx, ["pr", "--pr", "15"], harness(fx, script(), random).services);
    assert.equal(first.code, 1, first.stdout + first.stderr);
    const blocked = readJson(join(lastRun(fx), "result.json"));
    assert.deepEqual((blocked["blockers"] as Array<Record<string, unknown>>).map((blocker) => [blocker["rule"], blocker["path"]]), [["coverage", "scripts/release.sh"]]);
    assert.deepEqual(blocked["openBlockers"], [], "a coverage gap is no finding");
    // The same head again, as a commit: an empty delta cannot show the file reviewed.
    const same = await runFixtureCli(fx, ["commit", "--pr", "15", "--since", h0], harness(fx, script(), random).services);
    assert.match(same.stdout, /escalated from commit: prior_gap/);
    assert.equal(same.code, 1, same.stdout + same.stderr);
    // One more trivial commit: the delta does not touch the file, and the run still blocks on it.
    const h1 = fx.pr(15, { "scripts/note.sh": "#!/bin/sh\necho note\n" }, h0);
    const later = await runFixtureCli(fx, ["commit", "--pr", "15", "--since", h0], harness(fx, script(), random).services);
    assert.match(later.stdout, /escalated from commit: prior_gap/);
    assert.equal(later.code, 1, later.stdout + later.stderr);
    const result = readJson(join(lastRun(fx), "result.json"));
    assert.equal(result["head"], h1);
    assert.ok((result["blockers"] as Array<Record<string, unknown>>).some((blocker) => blocker["rule"] === "coverage" && blocker["path"] === "scripts/release.sh"));
  });

  it("a prior blocker closes only with a fix in a file tied to it: not a changed line of an unrelated file, nor the defect moved to a new file, nor the line the move left behind", async () => {
    // Long enough that a one-line fix keeps a renamed file over git's 50% similarity.
    const defect = "// Comparing secrets.\n// They come from the caller.\n// Keep this small.\nexport function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n\nexport const VERSION = 1;\n";
    const h0 = fx.pr(16, { "packages/crypto/src/index.ts": defect });
    const finder = harness(fx, script((spec) => (spec.lens === "security" ? { kind: "result", output: cleanOutput(spec, [cryptoFinding(spec)]) } : undefined)), random);
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "16"], finder.services)).code, 1);
    const claiming = (fixWhere: Record<string, unknown>, fixQuote: Record<string, unknown>) =>
      harness(fx, script((spec) => (spec.lens === "security" ? { kind: "result", output: { ...cleanOutput(spec), priorBlockers: [{ id: "P1", status: "fixed", fixWhere, fixQuote }] } } : undefined)), random);
    // An unrelated file, newly added: every line of it changed, and none fixes the blocker.
    const h1 = fx.pr(16, { "docs/plan/notes.md": "# notes\n\nunrelated line\n" }, h0);
    const unrelated = await runFixtureCli(fx, ["pr", "--pr", "16"], claiming({ path: "docs/plan/notes.md", startLine: 3, endLine: 3 }, { path: "docs/plan/notes.md", text: "unrelated line" }).services);
    assert.notEqual(unrelated.code, 0, unrelated.stdout + unrelated.stderr);
    assert.equal((readJson(join(lastRun(fx), "result.json"))["openBlockers"] as unknown[]).length, 1, "the blocker stays open");
    // The defect moved, word for word, into a new file the old one re-exports.
    fx.pr(16, { "packages/crypto/src/index.ts": 'export { sameSecret } from "./compare.ts";\n', "packages/crypto/src/compare.ts": defect }, h1);
    const moved = await runFixtureCli(fx, ["pr", "--pr", "16"], claiming({ path: "packages/crypto/src/compare.ts", startLine: 5, endLine: 5 }, { path: "packages/crypto/src/compare.ts", text: "return a === b;" }).services);
    assert.notEqual(moved.code, 0, moved.stdout + moved.stderr);
    assert.equal((readJson(join(lastRun(fx), "result.json"))["openBlockers"] as unknown[]).length, 1, "the blocker stays open");
    // Nor the line the move left behind in the file the blocker names: the quoted defect now lies in
    // another changed file, so no claim is taken, in a pr run or a commit since the blocker's head.
    const stubClaim = (): ReturnType<typeof claiming> =>
      claiming({ path: "packages/crypto/src/index.ts", startLine: 1, endLine: 1 }, { path: "packages/crypto/src/index.ts", text: 'export { sameSecret } from "./compare.ts";' });
    const stub = await runFixtureCli(fx, ["pr", "--pr", "16"], stubClaim().services);
    assert.equal(stub.code, 1, stub.stdout + stub.stderr);
    assert.equal((readJson(join(lastRun(fx), "result.json"))["openBlockers"] as unknown[]).length, 1, "the blocker stays open");
    const claim = ((readJson(join(lastRun(fx), "findings.json"))["priorBlockers"] as Array<Record<string, unknown>>)[0]?.["claim"] ?? {}) as Record<string, unknown>;
    assert.equal(claim["outcome"], "not_accepted");
    assert.match(String((claim["notAccepted"] as unknown[])[0]), /no longer in packages\/crypto\/src\/index\.ts but now lies in packages\/crypto\/src\/compare\.ts/);
    const stubCommit = await runFixtureCli(fx, ["commit", "--pr", "16", "--since", h0], stubClaim().services);
    assert.equal(stubCommit.code, 1, stubCommit.stdout + stubCommit.stderr);
    assert.equal((readJson(join(lastRun(fx), "result.json"))["openBlockers"] as unknown[]).length, 1, "the blocker stays open in a commit too");
    // The file renamed as it was: the renamed file may hold a fix, but nothing in it changed.
    const h3 = fx.pr(16, { "packages/crypto/src/index.ts": null, "packages/crypto/src/secret.ts": defect }, h0);
    const renamed = await runFixtureCli(fx, ["pr", "--pr", "16"], claiming({ path: "packages/crypto/src/secret.ts", startLine: 5, endLine: 5 }, { path: "packages/crypto/src/secret.ts", text: "return a === b;" }).services);
    assert.notEqual(renamed.code, 0, renamed.stdout + renamed.stderr);
    // A real fix in the renamed file closes it.
    const fixed = defect.replace("return a === b;", "return timingSafeEqual(Buffer.from(a), Buffer.from(b));");
    fx.pr(16, { "packages/crypto/src/secret.ts": fixed }, h3);
    const closed = await runFixtureCli(fx, ["pr", "--pr", "16"], claiming({ path: "packages/crypto/src/secret.ts", startLine: 5, endLine: 5 }, { path: "packages/crypto/src/secret.ts", text: "timingSafeEqual(Buffer.from(a), Buffer.from(b))" }).services);
    assert.equal(closed.code, 0, closed.stdout + closed.stderr);
  });

  it("a fix may lie in a file tied to the blocker (a new test of the file it names), and closes only when its fix check finds the defect gone", async () => {
    // A high test-truth blocker on packages/crypto/src/index.ts: no test fails when sameSecret is wrong.
    const h0 = fx.pr(20, { "packages/crypto/src/index.ts": "export function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n" });
    const finder = harness(fx, script((spec) => (spec.lens === "test-truth" ? { kind: "result", output: cleanOutput(spec, [cryptoFinding(spec, { severity: "high", title: "No test fails when sameSecret is wrong" })]) } : undefined)), random);
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "20"], finder.services)).code, 1);
    // The fix is a new test; the code itself needs no change.
    const test = 'import assert from "node:assert/strict";\nimport { sameSecret } from "./index.ts";\n\nassert.equal(sameSecret("a", "b"), false);\n';
    fx.pr(20, { "packages/crypto/src/same-secret.test.ts": test }, h0);
    const claim = {
      id: "P1",
      status: "fixed",
      fixWhere: { path: "packages/crypto/src/same-secret.test.ts", startLine: 4, endLine: 4 },
      fixQuote: { path: "packages/crypto/src/same-secret.test.ts", text: 'assert.equal(sameSecret("a", "b"), false);' },
    };
    const claiming = (...first: Handler[]) =>
      harness(fx, script(...first, (spec) => (spec.lens === "test-truth" ? { kind: "result", output: { ...cleanOutput(spec), priorBlockers: [claim] } } : undefined)), random);
    const priorClaim = (): Record<string, unknown> => ((readJson(join(lastRun(fx), "findings.json"))["priorBlockers"] as Array<Record<string, unknown>>)[0]?.["claim"] ?? {}) as Record<string, unknown>;
    const fixChecks = (h: Harness): string[] => calls(h).filter((call) => isFixCheck(call.spec)).map((call) => call.spec.role);

    // The fix check finds the defect still there: the blocker stays open, and the lens's answer stands.
    const stillThere = claiming((spec) => (isFixCheck(spec) ? { kind: "result", output: { verdict: "CONFIRMED", guardQuotes: [], reason: "The test never runs." } } : undefined));
    const open = await runFixtureCli(fx, ["pr", "--pr", "20"], stillThere.services);
    assert.equal(open.code, 1, open.stdout + open.stderr);
    assert.equal(priorClaim()["outcome"], "still_there");
    assert.match(JSON.stringify(readJson(join(lastRun(fx), "result.json"))["blockers"]), /its fix check found the defect still there/);
    assert.deepEqual(fixChecks(stillThere), ["sceptic1"], "the first check confirming the defect ends the check");
    const truth = calls(stillThere).find((call) => call.spec.lens === "test-truth");
    assert.match(truth?.spec.prompt ?? "", /"fixMayBeIn": \[[^\]]*"packages\/crypto\/src\/same-secret\.test\.ts"/);
    const check = calls(stillThere).find((call) => isFixCheck(call.spec));
    assert.match(check?.spec.prompt ?? "", /# The blocking finding \(reported on an earlier head of this pull request\)/);
    assert.ok(!(check?.spec.prompt ?? "").includes(String(readJson(join(lastRun(fx), "findings.json"))["runId"])), "the prompt never holds a run ID");

    // A high blocker takes two checks, the second on the attack model; an UNSURE second keeps it open.
    const unsure = claiming((spec) => (isFixCheck(spec) && spec.role === "sceptic2" ? { kind: "result", output: { verdict: "UNSURE", guardQuotes: [], reason: "Cannot tell." } } : undefined));
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "20"], unsure.services)).code, 1);
    assert.deepEqual(fixChecks(unsure), ["sceptic1", "sceptic2"]);
    assert.equal(priorClaim()["outcome"], "unsure");
    // A refutation whose guard is not in the tree is no refutation.
    const unguarded = claiming((spec) => (isFixCheck(spec) ? { kind: "result", output: { verdict: "REFUTED", guardQuotes: [{ path: "packages/crypto/src/same-secret.test.ts", text: "assert.ok(nothing)" }], reason: "Guarded." } } : undefined));
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "20"], unguarded.services)).code, 1);
    // A fix check served by another model: the run could not check.
    const mismatch = claiming((spec) => (isFixCheck(spec) ? { kind: "result", output: { verdict: "REFUTED", guardQuotes: [claim.fixQuote], reason: "Guarded." }, served: [MODELS.fable] } : undefined));
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "20"], mismatch.services)).code, 2);
    assert.equal(priorClaim()["outcome"], "unchecked");

    // Both checks find the defect gone, each quoting the guard at this head: the blocker closes.
    const holds = claiming();
    const closed = await runFixtureCli(fx, ["pr", "--pr", "20"], holds.services);
    assert.equal(closed.code, 0, closed.stdout + closed.stderr);
    assert.deepEqual(fixChecks(holds), ["sceptic1", "sceptic2"]);
    assert.equal(priorClaim()["outcome"], "fixed");
    assert.deepEqual(readJson(join(lastRun(fx), "result.json"))["openBlockers"], []);
  });

  it("a claim the engine cannot take leaves the blocker open without failing the lens, and a fix after a file the blocker names was deleted may lie in any changed file", async () => {
    // The defect lives in legacy.ts, which index.ts re-exports; sameSecret in index.ts has the same text.
    const base = "// Comparing secrets.\nexport function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n\nexport const VERSION = 1;\n";
    const legacy = "export function legacyCompare(a: string, b: string): boolean {\n  return a === b;\n}\n";
    const h0 = fx.pr(21, { "packages/crypto/src/legacy.ts": legacy, "packages/crypto/src/index.ts": `${base}export { legacyCompare } from "./legacy.ts";\n` });
    const atLegacy = { where: [{ path: "packages/crypto/src/legacy.ts", startLine: 1, endLine: 3 }], quotes: [{ path: "packages/crypto/src/legacy.ts", text: "return a === b;" }] };
    const finder = harness(fx, script((spec) => (spec.lens === "security" ? { kind: "result", output: cleanOutput(spec, [cryptoFinding(spec, atLegacy)]) } : undefined)), random);
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "21"], finder.services)).code, 1);
    const claiming = (fixWhere: Record<string, unknown>, fixQuote: Record<string, unknown>, ...first: Handler[]) =>
      harness(fx, script(...first, (spec) => (spec.lens === "security" ? { kind: "result", output: { ...cleanOutput(spec), priorBlockers: [{ id: "P1", status: "fixed", fixWhere, fixQuote }] } } : undefined)), random);

    // Unchanged code quoted as the fix: the engine cannot take it, so the blocker stays open (exit 1),
    // and the lens is not failed for a true answer it gave.
    fx.pr(21, { "docs/plan/notes.md": "# notes\n" }, h0);
    const unchanged = claiming({ path: "packages/crypto/src/legacy.ts", startLine: 2, endLine: 2 }, { path: "packages/crypto/src/legacy.ts", text: "return a === b;" });
    const kept = await runFixtureCli(fx, ["pr", "--pr", "21"], unchanged.services);
    assert.equal(kept.code, 1, kept.stdout + kept.stderr);
    assert.deepEqual(calls(unchanged).filter((call) => call.spec.lens === "security").map((call) => call.attempt), [1], "not retried");
    assert.equal((readJson(join(lastRun(fx), "result.json"))["lenses"] as Record<string, unknown>)["security"], "done");

    // legacy.ts deleted and its re-export removed: the change to index.ts may be quoted as the fix
    // (the lines either side of the removed one), and sameSecret's own text, there before, is no move.
    fx.pr(21, { "packages/crypto/src/legacy.ts": null, "packages/crypto/src/index.ts": base }, h0);
    const removal = { path: "packages/crypto/src/index.ts", startLine: 6, endLine: 6 };
    const removalQuote = { path: "packages/crypto/src/index.ts", text: "export const VERSION = 1;" };
    const doubted = claiming(removal, removalQuote, (spec) => (isFixCheck(spec) ? { kind: "result", output: { verdict: "CONFIRMED", guardQuotes: [], reason: "Still reachable." } } : undefined));
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "21"], doubted.services)).code, 1, "the fix check decides");
    assert.ok(calls(doubted).some((call) => isFixCheck(call.spec)), "the engine took the claim and checked it");
    assert.equal(((readJson(join(lastRun(fx), "findings.json"))["priorBlockers"] as Array<Record<string, unknown>>)[0]?.["claim"] as Record<string, unknown>)["outcome"], "still_there");
    const closed = await runFixtureCli(fx, ["pr", "--pr", "21"], claiming(removal, removalQuote).services);
    assert.equal(closed.code, 0, closed.stdout + closed.stderr);
  });

  it("a lens whose output was rejected closes no prior blocker, in its run or any later one", async () => {
    const h0 = fx.pr(17, { "packages/crypto/src/index.ts": "export function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n" });
    const finder = harness(fx, script((spec) => (spec.lens === "security" ? { kind: "result", output: cleanOutput(spec, [cryptoFinding(spec)]) } : undefined)), random);
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "17"], finder.services)).code, 1);
    const fixed = "import { timingSafeEqual } from \"node:crypto\";\n\nexport function sameSecret(a: string, b: string): boolean {\n  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));\n}\n";
    fx.pr(17, { "packages/crypto/src/index.ts": fixed }, h0);
    // A well-quoted fix claim in an output the engine rejects (done: false) on both attempts.
    const incomplete = harness(
      fx,
      script((spec) =>
        spec.lens === "security"
          ? {
              kind: "result",
              output: {
                ...cleanOutput(spec),
                done: false,
                priorBlockers: [{ id: "P1", status: "fixed", fixWhere: { path: "packages/crypto/src/index.ts", startLine: 4, endLine: 4 }, fixQuote: { path: "packages/crypto/src/index.ts", text: "timingSafeEqual(Buffer.from(a), Buffer.from(b))" } }],
              },
            }
          : undefined,
      ),
      random,
    );
    const rejected = await runFixtureCli(fx, ["commit", "--pr", "17", "--since", h0], incomplete.services);
    assert.equal(rejected.code, 2, rejected.stdout + rejected.stderr);
    assert.deepEqual(calls(incomplete).filter((call) => call.spec.lens === "security").map((call) => call.attempt), [1, 2]);
    assert.equal((readJson(join(lastRun(fx), "result.json"))["openBlockers"] as unknown[]).length, 1, "the blocker stays open in that run");
    // A later run whose sessions say nothing about it: still blocked.
    const silent = await runFixtureCli(fx, ["pr", "--pr", "17"], harness(fx, script(), random).services);
    assert.equal(silent.code, 1, silent.stdout + silent.stderr);
    assert.deepEqual((readJson(join(lastRun(fx), "result.json"))["blockers"] as Array<Record<string, unknown>>).map((blocker) => blocker["rule"]), ["prior"]);
  });

  it("escalates when the delta needs a lens the last reviewed head did not run (new_lens)", async () => {
    const h0 = fx.pr(12, { "packages/ui/src/button.ts": "export const button = 3;\n" });
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "12"], harness(fx, script(), random).services)).code, 0);
    fx.pr(12, { "packages/ui/package.json": '{\n  "name": "@fin/ui",\n  "private": true,\n  "type": "module",\n  "exports": "./src/button.ts",\n  "dependencies": { "left-pad": "1.3.0" }\n}\n' }, h0);
    const run = await runFixtureCli(fx, ["commit", "--pr", "12", "--since", h0], harness(fx, script(), random).services);
    assert.match(run.stdout, /escalated from commit: new_lens/);
    assert.ok((readJson(join(lastRun(fx), "result.json"))["lensNames"] as string[]).includes("dependency"));
  });

  it("escalates when the delta maps to an attack profile the last reviewed head did not (new_profile)", async () => {
    const h0 = fx.pr(13, { "packages/crypto/src/index.ts": "export const VERSION = 8;\n" });
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "13"], harness(fx, script(), random).services)).code, 0);
    assert.deepEqual(readJson(join(lastRun(fx), "result.json"))["profiles"], ["generic"]);
    fx.pr(13, { "scripts/check.mjs": "export {};\n" }, h0);
    const run = await runFixtureCli(fx, ["commit", "--pr", "13", "--since", h0], harness(fx, script(), random).services);
    assert.match(run.stdout, /escalated from commit: new_profile/);
    assert.ok((readJson(join(lastRun(fx), "result.json"))["profiles"] as string[]).includes("pipeline"));
  });

  it("escalates when the last reviewed head could not be checked (prior_could_not_check)", async () => {
    const h0 = fx.pr(14, { "docs/plan/README.md": "# plan\n\nJ.\n" });
    const refusing = harness(fx, script((spec) => (spec.lens === "rules" ? { kind: "result", stopReason: "refusal", output: cleanOutput(spec) } : undefined)), random);
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "14"], refusing.services)).code, 2);
    fx.pr(14, { "docs/plan/README.md": "# plan\n\nK.\n" }, h0);
    const run = await runFixtureCli(fx, ["commit", "--pr", "14", "--since", h0], harness(fx, script(), random).services);
    assert.match(run.stdout, /escalated from commit: prior_could_not_check/);
    assert.equal(run.code, 0, run.stdout + run.stderr);
  });

  it("a delta never lowers the chain's tier: after a tier S pr, a docs-only commit keeps the tier S floor and records tier S", async () => {
    const h0 = fx.pr(6, { "packages/crypto/src/index.ts": "export const VERSION = 4;\n" });
    assert.equal((await runFixtureCli(fx, ["pr", "--pr", "6"], harness(fx, script(), random).services)).code, 0);
    fx.pr(6, { "docs/plan/README.md": "# plan\n\nDocs only.\n" }, h0);
    const high = harness(fx, script(), random);
    const refused = await runFixtureCli(fx, ["commit", "--pr", "6", "--since", h0, "--effort", "high"], high.services);
    assert.equal(refused.code, 64, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /^fin-review: refused: floor_tier_s: /m);
    assert.equal(calls(high).length, 0);
    const h = harness(fx, script(), random);
    const run = await runFixtureCli(fx, ["commit", "--pr", "6", "--since", h0], h.services);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /^fin-review commit #6 /);
    const result = readJson(join(lastRun(fx), "result.json"));
    assert.equal(result["tier"], "S", "the chain's tier is recorded");
    assert.equal(result["deltaTier"], "D");
    assert.deepEqual(calls(h).map((call) => call.spec.lens).sort(), ["correctness", "rules"], "the delta's tier picks the lenses");
    for (const call of calls(h)) assert.equal(call.spec.effort, "xhigh");
  });

  it("escalates when the default branch no longer holds the prior run's merge base (base_changed), or the record names none", async () => {
    const moved = fx.origin.commit(fx.base, { "docs/plan/notes.md": "B\n" });
    try {
      fx.origin.git(["update-ref", "refs/heads/main", moved]);
      const h0 = fx.pr(7, { "docs/plan/README.md": "# plan\n\nE.\n" }, moved);
      assert.equal((await runFixtureCli(fx, ["pr", "--pr", "7"], harness(fx, script(), random).services)).code, 0);
      const priorDir = lastRun(fx);
      assert.equal(readJson(join(priorDir, "result.json"))["mergeBase"], moved);
      // main is rewritten to a sibling of the commit the pull request was reviewed on.
      const sibling = fx.origin.commit(fx.base, { "docs/plan/other.md": "B2\n" });
      fx.origin.git(["update-ref", "refs/heads/main", sibling]);
      fx.pr(7, { "docs/plan/README.md": "# plan\n\nF.\n" }, h0);
      const rewritten = await runFixtureCli(fx, ["commit", "--pr", "7", "--since", h0], harness(fx, script(), random).services);
      assert.match(rewritten.stdout, /escalated from commit: base_changed/);
      // A record that names no default branch cannot show what it was reviewed against.
      fx.origin.git(["update-ref", "refs/heads/main", moved]);
      const record = readJson(join(priorDir, "result.json"));
      delete record["defaultBranch"];
      writeFileSync(join(priorDir, "result.json"), JSON.stringify(record));
      for (const dir of runDirs(fx.home)) {
        if (dir === priorDir || !existsSync(join(dir, "result.json"))) continue;
        const other = readJson(join(dir, "result.json"));
        if (other["pr"] === 7 && other["head"] === h0) rmSync(dir, { recursive: true, force: true });
      }
      const unnamed = await runFixtureCli(fx, ["commit", "--pr", "7", "--since", h0], harness(fx, script(), random).services);
      assert.match(unnamed.stdout, /escalated from commit: base_changed/);
    } finally {
      fx.origin.git(["update-ref", "refs/heads/main", fx.base]);
    }
  });
});
