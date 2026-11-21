// The whole `pr` and `commit` modes against a fixture repository with fake sessions (no network):
// planning, the floor and environment refusals, every session's checks and retries, finding
// validation, the sceptics, the outputs in the run directory and the exit codes.

import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadCommittedModels } from "../src/options.ts";
import { FakeRunner } from "../src/runner/fake.ts";
import type { FakeReply, FakeScript } from "../src/runner/fake.ts";
import type { SessionSpec } from "../src/runner/types.ts";
import type { ReviewServices } from "../src/review/commands.ts";
import {
  cleanOutput,
  countingRandom,
  cryptoFinding,
  fakeClock,
  readJson,
  reviewFixture,
  runDirs,
  runFixtureCli,
} from "./helpers/review-fixture.ts";
import type { FakeClock, ReviewFixture } from "./helpers/review-fixture.ts";

const MODELS = loadCommittedModels();
const CONFIRMED = { verdict: "CONFIRMED", guardQuotes: [], reason: "The comparison is plain ===." };

type Handler = (spec: SessionSpec, attempt: number) => FakeReply | undefined;

/** A script: the first handler that answers wins; otherwise a clean output or a confirming sceptic. */
function script(...handlers: Handler[]): FakeScript {
  return (spec, attempt) => {
    for (const handler of handlers) {
      const reply = handler(spec, attempt);
      if (reply !== undefined) return reply;
    }
    if (spec.role.startsWith("sceptic")) return { kind: "result", output: CONFIRMED };
    if (spec.role === "second-look") return { kind: "result", output: { verdict: "STANDS", quotes: [], reason: "Every path passes the guard." } };
    return { kind: "result", output: cleanOutput(spec) };
  };
}

interface Harness {
  readonly services: ReviewServices;
  readonly runners: FakeRunner[];
  readonly clock: FakeClock;
}

function harness(fx: ReviewFixture, fake: FakeScript, random = countingRandom()): Harness {
  const clock = fakeClock();
  const runners: FakeRunner[] = [];
  return {
    clock,
    runners,
    services: {
      clock,
      random,
      facts: (n) => fx.facts(n),
      clientVersion: async () => "2.1.328",
      makeRunner: (options) => {
        assert.equal(options.models.opus, MODELS.opus);
        const runner = new FakeRunner(fake, clock);
        runners.push(runner);
        return runner;
      },
    },
  };
}

function calls(h: Harness): Array<{ spec: SessionSpec; attempt: number }> {
  return h.runners.flatMap((runner) => runner.calls);
}

function lastRun(fx: ReviewFixture): string {
  const dirs = runDirs(fx.home);
  const last = dirs[dirs.length - 1];
  assert.ok(last !== undefined, "a run directory");
  return last;
}

function findingsOf(runDir: string): Array<Record<string, unknown>> {
  return (readJson(join(runDir, "findings.json"))["findings"] as Array<Record<string, unknown>>) ?? [];
}

describe("pr over the fixture repository with fake sessions", () => {
  let fx: ReviewFixture;
  const random = countingRandom();
  before(() => {
    fx = reviewFixture();
  });
  after(() => fx.cleanup());

  it("a docs-only change runs correctness and rules, passes, prints counts only and writes the run", async () => {
    fx.pr(1, { "docs/plan/README.md": "# plan\n\nThe plan, revised.\n" });
    const h = harness(fx, script(), random);
    const run = await runFixtureCli(fx, ["pr", "--pr", "1"], h.services);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /^fin-review pr #1 at [0-9a-f]{12}: pass\n/);
    assert.match(run.stdout, /tier D; 1 units; 2 lenses; 0 attack profiles; 2 sessions/);
    assert.deepEqual(calls(h).map((call) => call.spec.lens).sort(), ["correctness", "rules"]);
    const dir = lastRun(fx);
    for (const file of ["state.json", "plan.json", "findings.json", "result.json", "summary.md", "lines.jsonl"]) assert.ok(existsSync(join(dir, file)), file);
    const result = readJson(join(dir, "result.json"));
    assert.equal(result["result"], "pass");
    assert.equal(result["tier"], "D");
    assert.equal(readJson(join(dir, "state.json"))["state"], "done");
    // The scratch tree is gone after the run, and never inside the repository.
    assert.ok(!existsSync(join(fx.home, "trees", dir.split("/").pop() ?? "")));
    // Every session ran in the scratch tree, on the overall model at the overall effort.
    for (const call of calls(h)) {
      assert.ok(call.spec.treeDir.startsWith(join(realpathSync(fx.home), "trees")), call.spec.treeDir);
      assert.ok(!call.spec.treeDir.startsWith(realpathSync(fx.local.dir)));
      assert.equal(call.spec.modelId, MODELS.opus);
      assert.equal(call.spec.effort, "xhigh");
    }
  });

  it("a tier S change runs the S lenses, joins and the attack pass on the attack model", async () => {
    const head = fx.pr(2, { "packages/crypto/src/index.ts": "export function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n" });
    const h = harness(fx, script(), random);
    const run = await runFixtureCli(fx, ["pr", "--pr", "2"], h.services);
    assert.equal(run.code, 0, run.stderr);
    const specs = calls(h).map((call) => call.spec);
    const lenses = specs.filter((spec) => spec.role !== "attack").map((spec) => spec.lens).sort();
    assert.deepEqual(lenses, ["correctness", "joins", "performance", "quality", "rules", "security", "test-truth"]);
    const attacks = specs.filter((spec) => spec.role === "attack");
    assert.deepEqual(attacks.map((spec) => spec.profile), ["generic"]);
    for (const spec of attacks) {
      assert.equal(spec.modelId, MODELS.fable);
      assert.equal(spec.effort, "high");
      assert.equal(spec.maxBudgetUsd, 20);
    }
    const lens = specs.find((spec) => spec.lens === "security");
    assert.ok(lens !== undefined);
    assert.equal(lens.maxBudgetUsd, 12);
    assert.equal(lens.timeoutMs, 30 * 60_000);
    // The prompt holds the unit inside DATA markers and the instruction after them.
    assert.match(lens.prompt, /^Everything between DATA markers is evidence/);
    assert.match(lens.prompt, /===== DATA [0-9a-f]{16} =====\n# Scope\nUnits under review:\n- packages\/crypto\/src\/index.ts lines 1-3 of 3/);
    assert.ok(lens.prompt.indexOf("===== END DATA") < lens.prompt.indexOf("# Your task"));
    assert.ok(!lens.prompt.includes(head), "no SHA in a prompt");
    assert.ok(!lens.prompt.includes(lastRun(fx).split("/").pop() ?? "run"), "no run ID in a prompt");
    // The one-hop importer is in scope and its test is read with the unit.
    assert.match(lens.prompt, /- packages\/core\/src\/use.ts/);
    assert.match(lens.prompt, /# Test packages\/crypto\/src\/index.test.ts/);
    const plan = readJson(join(lastRun(fx), "plan.json"));
    assert.equal(plan["tier"], "S");
    assert.deepEqual(plan["profiles"], { generic: ["packages/crypto/src/index.ts"] });
  });

  it("a confirmed medium finding blocks (exit 1); the run keeps its text, stdout only counts", async () => {
    fx.pr(3, { "packages/crypto/src/index.ts": "export function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n" });
    const h = harness(
      fx,
      script((spec) => (spec.lens === "security" ? { kind: "result", output: cleanOutput(spec, [cryptoFinding(spec)]) } : undefined)),
      random,
    );
    const run = await runFixtureCli(fx, ["pr", "--pr", "3"], h.services);
    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stdout, /: blocked\n/);
    assert.match(run.stdout, /findings: 1 confirmed, 0 plausible/);
    assert.ok(!run.stdout.includes("Secrets compared"), "no finding text on stdout");
    assert.ok(!run.stdout.includes("packages/crypto"), "no finding path on stdout");
    const sceptics = calls(h).filter((call) => call.spec.role.startsWith("sceptic"));
    assert.deepEqual(sceptics.map((call) => call.spec.role), ["sceptic1"]);
    assert.equal(sceptics[0]?.spec.modelId, MODELS.opus);
    // The sceptic sees the finding's fields inside DATA markers, and no other finding.
    assert.match(sceptics[0]?.spec.prompt ?? "", /===== DATA [0-9a-f]{16} =====\n# The candidate finding\n/);
    const dir = lastRun(fx);
    const [record] = findingsOf(dir);
    assert.equal(record?.["state"], "confirmed");
    assert.equal(record?.["blocking"], true);
    assert.match(String(record?.["id"]), /^F-[0-9]{8}T[0-9]{6}Z-pr3-[0-9a-f]{8}-001$/);
    assert.match(readFileSync(join(dir, "summary.md"), "utf8"), /Secrets compared with ===/);
  });

  it("a high finding gets a second sceptic on the attack model and effort ([RV-08])", async () => {
    fx.pr(4, { "packages/crypto/src/index.ts": "export function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n" });
    const h = harness(
      fx,
      script((spec) => (spec.lens === "correctness" ? { kind: "result", output: cleanOutput(spec, [cryptoFinding(spec, { severity: "high" })]) } : undefined)),
      random,
    );
    const run = await runFixtureCli(fx, ["pr", "--pr", "4", "--attack-effort", "max"], h.services);
    assert.equal(run.code, 1, run.stderr);
    const sceptics = calls(h).filter((call) => call.spec.role.startsWith("sceptic")).map((call) => call.spec);
    assert.deepEqual(sceptics.map((spec) => spec.role), ["sceptic1", "sceptic2"]);
    assert.equal(sceptics[0]?.modelId, MODELS.opus);
    assert.equal(sceptics[0]?.effort, "xhigh");
    assert.equal(sceptics[1]?.modelId, MODELS.fable);
    assert.equal(sceptics[1]?.effort, "max");
  });

  it("a refuted finding with quoted guards gets a second look and does not block", async () => {
    fx.pr(5, { "packages/crypto/src/index.ts": "export function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n" });
    const refuted = { verdict: "REFUTED", guardQuotes: [{ path: "packages/crypto/src/index.ts", text: "a === b" }], reason: "Not secret material." };
    const h = harness(
      fx,
      script(
        (spec) => (spec.lens === "quality" ? { kind: "result", output: cleanOutput(spec, [cryptoFinding(spec)]) } : undefined),
        (spec) => (spec.role === "sceptic1" ? { kind: "result", output: refuted } : undefined),
      ),
      random,
    );
    const run = await runFixtureCli(fx, ["pr", "--pr", "5"], h.services);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.deepEqual(
      calls(h)
        .filter((call) => call.spec.role.startsWith("sceptic") || call.spec.role === "second-look")
        .map((call) => call.spec.role),
      ["sceptic1", "second-look"],
    );
    assert.equal(findingsOf(lastRun(fx))[0]?.["state"], "refuted");
  });

  it("a refutation whose guard quotes are not in the tree counts as UNSURE: a second sceptic decides", async () => {
    fx.pr(15, { "packages/crypto/src/index.ts": "export function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n" });
    const invented = { verdict: "REFUTED", guardQuotes: [{ path: "packages/crypto/src/index.ts", text: "timingSafeEqual(a, b)" }], reason: "It is constant-time." };
    const h = harness(
      fx,
      script(
        (spec) => (spec.lens === "quality" ? { kind: "result", output: cleanOutput(spec, [cryptoFinding(spec)]) } : undefined),
        (spec) => (spec.role === "sceptic1" ? { kind: "result", output: invented } : undefined),
      ),
      random,
    );
    const run = await runFixtureCli(fx, ["pr", "--pr", "15"], h.services);
    assert.equal(run.code, 1, run.stdout + run.stderr);
    const roles = calls(h).filter((call) => call.spec.role !== "lens" && call.spec.role !== "joins" && call.spec.role !== "test-truth" && call.spec.role !== "attack");
    assert.deepEqual(roles.map((call) => `${call.spec.role}:${call.attempt}`), ["sceptic1:1", "sceptic1:2", "sceptic3:1"]);
    const [record] = findingsOf(lastRun(fx));
    assert.equal(record?.["state"], "confirmed");
    assert.deepEqual((record?.["verdicts"] as Array<Record<string, unknown>>).map((v) => [v["verdict"], v["guarded"]]), [["REFUTED", false], ["CONFIRMED", false]]);
  });

  it("a finding quoting text that is not in the file is dropped; the lens is retried once", async () => {
    fx.pr(6, { "packages/crypto/src/index.ts": "export function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n" });
    const bad = (spec: SessionSpec) => cryptoFinding(spec, { title: "Invented quote", quotes: [{ path: "packages/crypto/src/index.ts", text: "return a == b; // invented" }] });
    const h = harness(
      fx,
      script((spec, attempt) => (spec.lens === "security" ? { kind: "result", output: cleanOutput(spec, attempt === 1 ? [bad(spec)] : []) } : undefined)),
      random,
    );
    const run = await runFixtureCli(fx, ["pr", "--pr", "6"], h.services);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const security = calls(h).filter((call) => call.spec.lens === "security");
    assert.deepEqual(security.map((call) => call.attempt), [1, 2]);
    assert.equal(findingsOf(lastRun(fx)).length, 0, "the retried session's clean output replaces the first");
    assert.equal(calls(h).filter((call) => call.spec.role.startsWith("sceptic")).length, 0, "no sceptic sees an invalid finding");
  });

  it("an invalid quote on both attempts: the finding is dropped as invalid, the valid one kept, the lens incomplete (exit 2)", async () => {
    fx.pr(7, { "packages/crypto/src/index.ts": "export function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n" });
    const bad = (spec: SessionSpec) => cryptoFinding(spec, { title: "Invented quote", quotes: [{ path: "packages/crypto/src/index.ts", text: "this text is nowhere" }] });
    const h = harness(
      fx,
      script((spec) => (spec.lens === "security" ? { kind: "result", output: cleanOutput(spec, [bad(spec), cryptoFinding(spec)]) } : undefined)),
      random,
    );
    const run = await runFixtureCli(fx, ["pr", "--pr", "7"], h.services);
    assert.equal(run.code, 2, run.stdout + run.stderr);
    assert.match(run.stdout, /: could_not_check\n/);
    assert.match(run.stdout, /1 incomplete/);
    const records = findingsOf(lastRun(fx));
    const invalid = records.find((record) => record["state"] === "invalid");
    assert.ok(invalid !== undefined);
    assert.match(String((invalid["problems"] as string[])[0]), /not an exact substring/);
    assert.equal(records.filter((record) => record["state"] === "confirmed").length, 1);
    const summary = readFileSync(join(lastRun(fx), "summary.md"), "utf8");
    assert.ok(!summary.includes("Invented quote"), "an invalid finding is never shown");
    assert.ok(summary.includes("Secrets compared with ==="));
    const sceptics = calls(h).filter((call) => call.spec.role.startsWith("sceptic"));
    assert.equal(sceptics.length, 1, "only the valid finding reaches a sceptic");
    assert.ok(!(sceptics[0]?.spec.prompt ?? "").includes("this text is nowhere"));
  });

  it("model_mismatch: no retry, the lens is refused, the run cannot check (exit 2), a review.model_mismatch line", async () => {
    fx.pr(8, { "packages/crypto/src/index.ts": "export function sameSecret(a: string, b: string): boolean {\n  return a === b;\n}\n" });
    const h = harness(
      fx,
      script((spec) =>
        spec.lens === "security" ? { kind: "result", output: cleanOutput(spec, [cryptoFinding(spec)]), models: [spec.modelId, "claude-haiku-9-9"] } : undefined,
      ),
      random,
    );
    const run = await runFixtureCli(fx, ["pr", "--pr", "8"], h.services);
    assert.equal(run.code, 2, run.stdout + run.stderr);
    assert.deepEqual(calls(h).filter((call) => call.spec.lens === "security").map((call) => call.attempt), [1]);
    const dir = lastRun(fx);
    const result = readJson(join(dir, "result.json"));
    assert.equal((result["lenses"] as Record<string, string>)["security"], "refused");
    assert.equal(findingsOf(dir).length, 0, "a mismatched session's output is discarded");
    const lines = readFileSync(join(dir, "lines.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const mismatch = lines.find((line) => line["event"] === "review.model_mismatch");
    assert.ok(mismatch !== undefined);
    assert.deepEqual(mismatch["observed"], ["claude-haiku-9-9", MODELS.opus]);
  });

  it("a refusal is retried once; refused twice, the lens is refused and blocks (exit 2)", async () => {
    fx.pr(9, { "docs/plan/README.md": "# plan\n\nRefusal case.\n" });
    const h = harness(fx, script((spec) => (spec.lens === "rules" ? { kind: "result", stopReason: "refusal", output: cleanOutput(spec) } : undefined)), random);
    const run = await runFixtureCli(fx, ["pr", "--pr", "9"], h.services);
    assert.equal(run.code, 2, run.stdout + run.stderr);
    assert.deepEqual(calls(h).filter((call) => call.spec.lens === "rules").map((call) => call.attempt), [1, 2]);
    const lines = readFileSync(join(lastRun(fx), "lines.jsonl"), "utf8");
    assert.match(lines, /"event":"review.refused"/);
  });

  it("a refusal then a clean answer passes", async () => {
    fx.pr(10, { "docs/plan/README.md": "# plan\n\nRefusal then answer.\n" });
    const h = harness(
      fx,
      script((spec, attempt) => (spec.lens === "rules" && attempt === 1 ? { kind: "result", output: undefined, resultText: "I can't help with that." } : undefined)),
      random,
    );
    const run = await runFixtureCli(fx, ["pr", "--pr", "10"], h.services);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.deepEqual(calls(h).filter((call) => call.spec.lens === "rules").map((call) => call.attempt), [1, 2]);
  });

  it("throttling is retried with waits of 15 and 60 seconds on the injected clock", async () => {
    fx.pr(11, { "docs/plan/README.md": "# plan\n\nThrottled.\n" });
    const h = harness(
      fx,
      script((spec, attempt) =>
        spec.lens === "correctness" && attempt <= 2 ? { kind: "result", isError: true, apiErrorStatus: attempt === 1 ? 429 : 529, resultText: "API Error" } : undefined,
      ),
      random,
    );
    const run = await runFixtureCli(fx, ["pr", "--pr", "11"], h.services);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.deepEqual(h.clock.sleeps, [15_000, 60_000]);
  });

  it("--effort high on a tier S change is refused (64, floor_tier_s) before any session; --advisory runs", async () => {
    fx.pr(12, { "packages/crypto/src/index.ts": "export const VERSION = 2;\n" });
    const h = harness(fx, script(), random);
    const run = await runFixtureCli(fx, ["pr", "--pr", "12", "--effort", "high"], h.services);
    assert.equal(run.code, 64);
    assert.match(run.stderr, /^fin-review: refused: floor_tier_s: /m);
    assert.equal(calls(h).length, 0);
    assert.equal(readJson(join(lastRun(fx), "state.json"))["state"], "refused");
    const advisory = harness(fx, script(), random);
    const second = await runFixtureCli(fx, ["pr", "--pr", "12", "--effort", "high", "--advisory"], advisory.services);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stderr, /advisory: not a gate receipt/);
    assert.match(second.stdout, /\(advisory: not a gate receipt\)/);
    assert.ok(calls(advisory).every((call) => call.spec.role === "attack" || call.spec.effort === "high"));
  });

  it("a refused environment variable stops the run with 78 before any session", async () => {
    fx.pr(13, { "docs/plan/README.md": "# plan\n\nEnv.\n" });
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_SUBAGENT_MODEL", "NODE_OPTIONS", "https_proxy"]) {
      const h = harness(fx, script(), random);
      const run = await runFixtureCli(fx, ["pr", "--pr", "13"], h.services, { ...fx.env, [name]: "x" });
      assert.equal(run.code, 78, name);
      assert.ok(run.stderr.includes(`environment_refused: ${name} is set (`), run.stderr);
      assert.ok(!run.stderr.includes("=x"), "values are never printed");
      assert.equal(calls(h).length, 0);
    }
  });

  it("refuses bad options with 64 before anything else", async () => {
    const h = harness(fx, script(), random);
    for (const argv of [
      ["pr"],
      ["pr", "--pr", "0"],
      ["pr", "--pr", "1", "--model", "sonnet"],
      ["pr", "--pr", "1", "--model", "fable", "--attack-model", "opus"],
      ["pr", "--pr", "1", "--since", "a".repeat(40)],
      ["commit", "--pr", "1"],
      ["commit", "--pr", "1", "--since", "HEAD"],
      ["pr", "--pr", "1", "--effort", "medium"],
    ]) {
      const run = await runFixtureCli(fx, argv, h.services);
      assert.equal(run.code, 64, argv.join(" "));
      assert.match(run.stderr, /^fin-review: refused: /);
    }
    assert.equal(calls(h).length, 0);
  });

  it("refuses a FIN_REVIEW_HOME inside the repository (78)", async () => {
    const h = harness(fx, script(), random);
    const run = await runFixtureCli(fx, ["pr", "--pr", "1"], h.services, { ...fx.env, FIN_REVIEW_HOME: join(fx.local.dir, ".fin-review") });
    assert.equal(run.code, 78);
    assert.match(run.stderr, /must not lie inside the repository/);
    assert.ok(!existsSync(join(fx.local.dir, ".fin-review")), "a refused home is never created");
  });

  it("refuses a Claude Code other than the pin (78)", async () => {
    const h = harness(fx, script(), random);
    const run = await runFixtureCli(fx, ["pr", "--pr", "1"], { ...h.services, clientVersion: async () => "2.1.300" }, fx.env);
    assert.equal(run.code, 78);
    assert.match(run.stderr, /not the pinned 2\.1\.328/);
    assert.equal(calls(h).length, 0);
  });

  it("a session over the run budget is never started: budget_reached, could not check (exit 2)", async () => {
    fx.pr(14, { "docs/plan/README.md": "# plan\n\nBudget.\n" });
    const h = harness(fx, script((spec) => ({ kind: "result", output: cleanOutput(spec), costUsd: 15 })), random);
    // One session at a time, so the first session's cost is counted before the second would start.
    writeFileSync(join(fx.home, "config.json"), JSON.stringify({ maxSessions: 1 }));
    let run;
    try {
      run = await runFixtureCli(fx, ["pr", "--pr", "14"], { ...h.services }, fx.env);
    } finally {
      rmSync(join(fx.home, "config.json"), { force: true });
    }
    // Tier D's cap is 15 USD: the first session spends it, the second never starts.
    assert.equal(run.code, 2, run.stdout + run.stderr);
    assert.match(run.stdout, /1 budget_reached/);
    assert.equal(calls(h).length, 1);
  });
});

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
});
