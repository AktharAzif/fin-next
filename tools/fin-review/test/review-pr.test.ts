// The `pr` mode against a fixture repository with fake sessions (no network): planning, the floor,
// the environment, settings-file and engine-copy refusals, every session's checks and retries, finding
// validation, the sceptics, the outputs in the run directory and the exit codes.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FakeRunner } from "../src/runner/fake.ts";
import type { SessionSpec } from "../src/runner/types.ts";
import type { EngineCopy } from "../src/review/engine-copy.ts";
import { cleanOutput, countingRandom, cryptoFinding, readJson, reviewFixture, runFixtureCli } from "./helpers/review-fixture.ts";
import type { ReviewFixture } from "./helpers/review-fixture.ts";
import { CONFIRMED, MODELS, calls, findingsOf, harness, lastRun, script } from "./helpers/review-harness.ts";

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

  it("--effort high on a tier S change is refused (64, floor_tier_s) before any session; --advisory runs and is never a pass", async () => {
    fx.pr(12, { "packages/crypto/src/index.ts": "export const VERSION = 2;\n" });
    const h = harness(fx, script(), random);
    const run = await runFixtureCli(fx, ["pr", "--pr", "12", "--effort", "high"], h.services);
    assert.equal(run.code, 64);
    assert.match(run.stderr, /^fin-review: refused: floor_tier_s: /m);
    assert.equal(calls(h).length, 0);
    assert.equal(readJson(join(lastRun(fx), "state.json"))["state"], "refused");
    const advisory = harness(fx, script(), random);
    const second = await runFixtureCli(fx, ["pr", "--pr", "12", "--effort", "high", "--advisory"], advisory.services);
    assert.equal(second.code, 3, second.stderr);
    assert.match(second.stderr, /advisory: not a gate result \(exit 3\)/);
    assert.match(second.stdout, /^fin-review pr #12 at [0-9a-f]{12}: advisory \(pass; not a gate result\)$/m);
    const result = readJson(join(lastRun(fx), "result.json"));
    assert.equal(result["result"], "advisory");
    assert.equal(result["outcome"], "pass");
    assert.equal(result["exitCode"], 3);
    assert.ok(calls(advisory).every((call) => call.spec.role === "attack" || call.spec.effort === "high"));
    // An advisory run with blockers is no "blocked" result either.
    const blocked = harness(fx, script((spec) => (spec.lens === "security" ? { kind: "result", output: cleanOutput(spec, [cryptoFinding(spec, { quotes: [{ path: "packages/crypto/src/index.ts", text: "VERSION = 2" }], where: [{ path: "packages/crypto/src/index.ts", startLine: 1, endLine: 1 }] })]) } : undefined)), random);
    const third = await runFixtureCli(fx, ["pr", "--pr", "12", "--effort", "high", "--advisory"], blocked.services);
    assert.equal(third.code, 3, third.stdout + third.stderr);
    assert.match(third.stdout, /: advisory \(blocked; not a gate result\)$/m);
    // And a later commit never takes an advisory run as its last reviewed head.
    const next = fx.pr(12, { "packages/crypto/src/index.ts": "export const VERSION = 3;\n" }, readJson(join(lastRun(fx), "result.json"))["head"] as string);
    assert.ok(next.length === 40);
    const commit = await runFixtureCli(fx, ["commit", "--pr", "12", "--since", readJson(join(lastRun(fx), "result.json"))["head"] as string], harness(fx, script(), random).services);
    assert.match(commit.stdout, /escalated from commit: no_prior_run/);
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

  it("a gating run needs the default branch's engine copy (78); --advisory runs and records which engine ran", async () => {
    fx.pr(16, { "docs/plan/README.md": "# plan\n\nEngine copy.\n" });
    const other: EngineCopy = { commit: "f".repeat(40), procedureHash: "b".repeat(64), problems: ["docs/review at the engine's commit differs from main's"] };
    const h = harness(fx, script(), random);
    const refused = await runFixtureCli(fx, ["pr", "--pr", "16"], { ...h.services, engineCopy: async () => other });
    assert.equal(refused.code, 78, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /^fin-review: refused: engine_not_default: docs\/review at the engine's commit differs from main's$/m);
    assert.equal(calls(h).length, 0);
    assert.equal(readJson(join(lastRun(fx), "state.json"))["reason"], "engine_copy");
    const advisory = harness(fx, script(), random);
    const run = await runFixtureCli(fx, ["pr", "--pr", "16", "--advisory"], { ...advisory.services, engineCopy: async () => other });
    assert.match(run.stderr, /advisory: the engine is not main's engine copy/);
    const result = readJson(join(lastRun(fx), "result.json"));
    assert.equal(result["advisory"], true);
    assert.deepEqual(result["engine"], { commit: "f".repeat(40), procedureHash: "b".repeat(64), defaultCopy: false });
    // The real check: the fixture's main holds no engine at all.
    const real = harness(fx, script(), random);
    const { engineCopy: _injected, ...services } = real.services;
    const unchecked = await runFixtureCli(fx, ["pr", "--pr", "16"], services);
    assert.equal(unchecked.code, 78, unchecked.stdout + unchecked.stderr);
    assert.match(unchecked.stderr, /engine_not_default: main has no tools\/fin-review, so there is no engine copy to run/);
    assert.equal(calls(real).length, 0);
  });

  it("refuses (78) a settings file a session could read that sets a refused key, cannot be parsed, or is a drop-in that does", async () => {
    fx.pr(17, { "docs/plan/README.md": "# plan\n\nSettings.\n" });
    const userSettings = join(fx.userHome, ".claude", "settings.json");
    const dropIn = join(fx.managedDir, "managed-settings.d", "10-org.json");
    const managed = join(fx.managedDir, "managed-settings.json");
    mkdirSync(join(fx.userHome, ".claude"), { recursive: true });
    mkdirSync(join(fx.managedDir, "managed-settings.d"), { recursive: true });
    try {
      writeFileSync(userSettings, JSON.stringify({ theme: "dark", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_AUTH_TOKEN: "secret-value" }, model: "x" }));
      const h = harness(fx, script(), random);
      const run = await runFixtureCli(fx, ["pr", "--pr", "17"], h.services);
      assert.equal(run.code, 78, run.stdout + run.stderr);
      assert.match(run.stderr, /^fin-review: refused: settings_refused: .*\/\.claude\/settings\.json: sets refused keys: env\.ANTHROPIC_BASE_URL, env\.ANTHROPIC_AUTH_TOKEN, model$/m);
      assert.ok(!run.stderr.includes("secret-value") && !run.stderr.includes("127.0.0.1"), "values are never printed");
      assert.equal(calls(h).length, 0);
      writeFileSync(userSettings, JSON.stringify({ theme: "dark", verbose: true }));
      writeFileSync(dropIn, JSON.stringify({ apiKeyHelper: "/bin/true" }));
      const managedRun = await runFixtureCli(fx, ["pr", "--pr", "17"], harness(fx, script(), random).services);
      assert.equal(managedRun.code, 78);
      assert.match(managedRun.stderr, /settings_refused: .*managed-settings\.d\/10-org\.json: sets refused keys: apiKeyHelper/);
      rmSync(dropIn);
      writeFileSync(managed, "{ not json");
      const broken = await runFixtureCli(fx, ["pr", "--pr", "17"], harness(fx, script(), random).services);
      assert.equal(broken.code, 78);
      assert.match(broken.stderr, /settings_refused: .*managed-settings\.json: not valid JSON/);
      rmSync(managed);
      const allowed = await runFixtureCli(fx, ["pr", "--pr", "17"], harness(fx, script(), random).services);
      assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);
    } finally {
      rmSync(join(fx.userHome, ".claude"), { recursive: true, force: true });
      rmSync(fx.managedDir, { recursive: true, force: true });
    }
  });

  it("refuses (78) an env block in the global configuration, $HOME/.claude.json, which a session would otherwise take", async () => {
    fx.pr(31, { "docs/plan/README.md": "# plan\n\nGlobal config.\n" });
    const global = join(fx.userHome, ".claude.json");
    writeFileSync(global, JSON.stringify({ numStartups: 2, env: { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BEDROCK_BASE_URL: "https://example.com/secret-path" } }));
    try {
      const h = harness(fx, script(), random);
      const run = await runFixtureCli(fx, ["pr", "--pr", "31"], h.services);
      assert.equal(run.code, 78, run.stdout + run.stderr);
      assert.match(run.stderr, /^fin-review: refused: settings_refused: .*\/\.claude\.json: sets refused keys: env\.CLAUDE_CODE_USE_BEDROCK, env\.ANTHROPIC_BEDROCK_BASE_URL$/m);
      assert.ok(!run.stderr.includes("secret-path"));
      assert.equal(calls(h).length, 0);
    } finally {
      rmSync(global, { force: true });
    }
  });

  it("runs through the pool transport when asked: records it, hands it to every session, and still refuses other variables", async () => {
    fx.pr(32, { "docs/plan/README.md": "# plan\n\nPool.\n" });
    const configDir = join(fx.userHome, "pool-config");
    mkdirSync(configDir, { recursive: true });
    const pool = { ...fx.env, FIN_REVIEW_TRANSPORT: "pool", ANTHROPIC_BASE_URL: "http://127.0.0.1:41234/", ANTHROPIC_AUTH_TOKEN: "pool-token-value", CLAUDE_CONFIG_DIR: configDir };
    try {
      // Without FIN_REVIEW_TRANSPORT the same variables are refused, as before.
      const direct = await runFixtureCli(fx, ["pr", "--pr", "32"], harness(fx, script(), random).services, { ...pool, FIN_REVIEW_TRANSPORT: "direct" });
      assert.equal(direct.code, 78);
      assert.match(direct.stderr, /environment_refused: ANTHROPIC_AUTH_TOKEN is set/);
      const h = harness(fx, script(), random);
      const transports: string[] = [];
      const makeRunner = h.services.makeRunner;
      assert.ok(makeRunner !== undefined);
      const run = await runFixtureCli(
        fx,
        ["pr", "--pr", "32"],
        {
          ...h.services,
          makeRunner: (options) => {
            transports.push(options.transport?.kind ?? "none");
            assert.ok(options.extraDenied.includes(realpathSync(configDir)), "the forwarder's folder is denied to sessions");
            return makeRunner(options);
          },
        },
        pool,
      );
      assert.equal(run.code, 0, run.stdout + run.stderr);
      assert.deepEqual(transports, ["pool"]);
      assert.equal(readJson(join(lastRun(fx), "result.json"))["transport"], "pool");
      assert.equal(readJson(join(lastRun(fx), "plan.json"))["transport"], "pool");
      assert.ok(!readFileSync(join(lastRun(fx), "result.json"), "utf8").includes("pool-token-value"));
      // A forwarder that is not on this machine, or a path on it, is refused before anything runs.
      for (const url of ["https://gateway.example.com:443/", "http://127.0.0.1:41234/v1/other"]) {
        const far = harness(fx, script(), random);
        const refused = await runFixtureCli(fx, ["pr", "--pr", "32"], far.services, { ...pool, ANTHROPIC_BASE_URL: url });
        assert.equal(refused.code, 78, url);
        assert.match(refused.stderr, /^fin-review: refused: transport_refused: ANTHROPIC_BASE_URL must be http/m);
        assert.ok(!refused.stderr.includes("gateway.example.com"));
        assert.equal(calls(far).length, 0);
      }
      // Every other model, effort or credential variable is still refused under pool.
      for (const [name, value] of [["CLAUDE_EFFORT", "low"], ["ANTHROPIC_MODEL", "x"], ["ANTHROPIC_API_KEY", "k"], ["CLAUDE_CODE_USE_VERTEX", "1"]] as const) {
        const refused = await runFixtureCli(fx, ["pr", "--pr", "32"], harness(fx, script(), random).services, { ...pool, [name]: value });
        assert.equal(refused.code, 78, name);
        assert.match(refused.stderr, new RegExp(`environment_refused: ${name} is set`));
      }
      // A configuration folder that does not exist is refused.
      const missing = await runFixtureCli(fx, ["pr", "--pr", "32"], harness(fx, script(), random).services, { ...pool, CLAUDE_CONFIG_DIR: join(fx.userHome, "no-such-folder") });
      assert.equal(missing.code, 78);
      assert.match(missing.stderr, /CLAUDE_CONFIG_DIR: must name a folder that exists/);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("refuses a FIN_REVIEW_HOME inside the repository however it is spelled, before reading anything under it", async () => {
    const h = harness(fx, script(), random);
    // A link to the repository, and (on a disk that ignores case) another spelling of it.
    const alias = join(fx.dir, "alias");
    symlinkSync(fx.local.dir, alias);
    const spellings = [join(alias, ".fr")];
    const upper = join(fx.local.dir.slice(0, fx.local.dir.lastIndexOf("/")), "LOCAL");
    if (existsSync(upper) && !readdirSync(fx.dir).includes("LOCAL")) spellings.push(join(upper, ".fr"));
    for (const home of spellings) {
      const run = await runFixtureCli(fx, ["pr", "--pr", "1"], h.services, { ...fx.env, FIN_REVIEW_HOME: home });
      assert.equal(run.code, 78, home);
      assert.match(run.stderr, /must not lie inside the repository/);
    }
    assert.ok(!existsSync(join(fx.local.dir, ".fr")), "a refused home is never created");
    // The machine's configuration under a refused home is never read: the place is refused first.
    mkdirSync(join(fx.local.dir, ".fr2"));
    writeFileSync(join(fx.local.dir, ".fr2", "config.json"), "{ not json");
    const unread = await runFixtureCli(fx, ["pr", "--pr", "1"], h.services, { ...fx.env, FIN_REVIEW_HOME: join(fx.local.dir, ".fr2") });
    assert.equal(unread.code, 78);
    assert.match(unread.stderr, /must not lie inside the repository/);
    assert.ok(!unread.stderr.includes("not valid JSON"));
    rmSync(join(fx.local.dir, ".fr2"), { recursive: true, force: true });
    assert.equal(calls(h).length, 0);
  });

  it("never runs a git planted in the repository under review, whatever PATH holds", async () => {
    fx.pr(18, { "docs/plan/README.md": "# plan\n\nPlanted.\n" });
    const marker = join(fx.dir, "planted-git-ran");
    writeFileSync(join(fx.local.dir, "git"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
    try {
      const path = process.env["PATH"] ?? "/usr/bin:/bin";
      for (const prefix of [":", ".:", `${fx.local.dir}:`]) {
        const run = await runFixtureCli(fx, ["pr", "--pr", "18"], harness(fx, script(), random).services, { ...fx.env, PATH: `${prefix}${path}` });
        assert.equal(run.code, 0, `${prefix} ${run.stdout}${run.stderr}`);
        assert.ok(!existsSync(marker), `the planted git ran with PATH=${prefix}...`);
      }
    } finally {
      rmSync(join(fx.local.dir, "git"), { force: true });
    }
  });

  it("starts every session from the file claudePath names when its version is checked", async () => {
    fx.pr(19, { "docs/plan/README.md": "# plan\n\nPinned.\n" });
    const seen: string[] = [];
    const h = harness(fx, script(), random);
    const versions: string[] = [];
    const run = await runFixtureCli(fx, ["pr", "--pr", "19"], {
      ...h.services,
      clientVersion: async (path) => {
        versions.push(path);
        return "2.1.328";
      },
      makeRunner: (options) => {
        seen.push(`${options.claudePath} ${options.claudeFingerprint === "" ? "unpinned" : "pinned"}`);
        return h.services.makeRunner?.(options) ?? new FakeRunner(script(), h.clock);
      },
    });
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.deepEqual(versions, [fx.claudeFile], "the version is read from the resolved file, not the link");
    assert.deepEqual(seen, [`${fx.claudeFile} pinned`]);
  });

  it("refuses a Claude Code other than the pin (78)", async () => {
    const h = harness(fx, script(), random);
    const run = await runFixtureCli(fx, ["pr", "--pr", "1"], { ...h.services, clientVersion: async () => "2.1.300" }, fx.env);
    assert.equal(run.code, 78);
    assert.match(run.stderr, /not the pinned 2\.1\.328/);
    assert.equal(calls(h).length, 0);
  });

  it("a session whose prompt is over the runner's cap is never started: the lens is incomplete, the run records could not check (exit 2)", async () => {
    // Markdown with no `## ` heading is never cut into chunks, so a large one is one unit (tier D:
    // documentation), and its prompt passes the 4 MB cap.
    const row = `${"x".repeat(40)} ${"y".repeat(60)}\n`;
    fx.pr(29, { "docs/plan/big.md": `# Big\n\n${row.repeat(Math.ceil((4.2 * 1024 * 1024) / row.length))}` });
    const h = harness(fx, script(), random);
    const run = await runFixtureCli(fx, ["pr", "--pr", "29"], h.services);
    assert.equal(run.code, 2, run.stdout + run.stderr);
    assert.match(run.stderr, /session correctness-s0 not started: its prompt is [0-9]+ bytes, over the 4194304-byte cap/);
    assert.equal(calls(h).length, 0, "no session started");
    const result = readJson(join(lastRun(fx), "result.json"));
    assert.equal(result["result"], "could_not_check");
    assert.deepEqual(result["lenses"], { correctness: "incomplete", rules: "incomplete" });
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
