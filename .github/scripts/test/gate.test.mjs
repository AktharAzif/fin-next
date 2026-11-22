// The gate's rules (spec 01 §5.4; spec 07 §11.2; BD-02, Phase 0 trimmed): one test per rule and
// per way it can fail, then the script run as ci.yml runs it, against a fake engine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkNeedsComplete,
  DEFERRED_RULES,
  evaluateJobs,
  GATED_JOBS,
  isRequired,
  parseNeeds,
  parsePlan,
  runGate,
} from "../gate.mjs";
import { everythingPlan } from "../plan-fallback.mjs";
import { collect, tempDir, writeTree } from "./helpers.mjs";

const GATE = fileURLToPath(new URL("../gate.mjs", import.meta.url));
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

/**
 * A NEEDS document: every gated job with the given result, then the overrides.
 * @param {Record<string, string>} [overrides]
 */
function needs(overrides = {}) {
  /** @type {Record<string, { result: string, outputs: Record<string, string> }>} */
  const out = {};
  for (const job of GATED_JOBS) out[job] = { result: "success", outputs: {} };
  for (const [job, result] of Object.entries(overrides)) out[job] = { result, outputs: {} };
  return JSON.stringify(out);
}

/**
 * A plan document with the given job flags.
 * @param {Record<string, boolean>} [jobs]
 */
function plan(jobs = {}) {
  return {
    v: 1,
    event: "pull_request",
    base: BASE,
    head: HEAD,
    tier: "D",
    changed: 1,
    classes: ["docs"],
    everything: false,
    reason: "classes",
    jobs: { check: true, db: false, build: false, seams: false, e2e: false, static: true, ...jobs },
  };
}

/**
 * Runs the gate in-process with a fake engine.
 * @param {{ needsText?: string, planDoc?: unknown, engine?: boolean, recomputed?: unknown, recomputeFails?: boolean }} input
 */
function gate({
  needsText = needs(),
  planDoc = plan(),
  engine = true,
  recomputed,
  recomputeFails,
}) {
  const { lines, print } = collect();
  const code = runGate({
    env: {
      NEEDS: needsText,
      PLAN: planDoc === undefined ? "" : JSON.stringify(planDoc),
      EVENT_NAME: "pull_request",
      BASE_SHA: BASE,
      HEAD_SHA: HEAD,
    },
    cwd: "/repo",
    print,
    engineExists: () => engine,
    recompute: () =>
      recomputeFails
        ? { ok: false, code: "engine_failed" }
        : { ok: true, plan: /** @type {Record<string, unknown>} */ (recomputed ?? planDoc) },
  });
  return { code, lines };
}

/**
 * The `gate.rule` line for a rule.
 * @param {string[]} lines
 * @param {string} name
 */
function ruleLine(lines, name) {
  return lines.find((l) => l.startsWith(`gate.rule name=${name} `)) ?? "";
}

describe("parseNeeds and parsePlan", () => {
  it("reads each job's result", () => {
    const parsed = parseNeeds(needs({ db: "skipped" }));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.needs.get("db"), "skipped");
    assert.equal(parsed.ok && parsed.needs.get("check"), "success");
  });

  it("refuses empty, malformed and job-less NEEDS", () => {
    for (const text of [
      undefined,
      "",
      "not json",
      "[]",
      "{}",
      '{"bad name!":{"result":"success"}}',
    ]) {
      assert.equal(parseNeeds(text).ok, false, String(text));
    }
  });

  it("gives a job without a result the result unknown", () => {
    const parsed = parseNeeds('{"check": {}}');
    assert.equal(parsed.ok && parsed.needs.get("check"), "unknown");
  });

  it("accepts only a version 1 plan with a jobs object", () => {
    assert.notEqual(parsePlan(JSON.stringify(plan())), null);
    for (const text of [undefined, "", "{", '{"v":2,"jobs":{}}', '{"v":1}', '{"v":1,"jobs":[]}']) {
      assert.equal(parsePlan(text), null, String(text));
    }
  });
});

describe("rule jobs: which jobs are needed", () => {
  it("needs plan and commit-dates-utc whatever the plan says", () => {
    const p = { v: 1, jobs: { plan: false, "commit-dates-utc": false } };
    assert.equal(isRequired("plan", p), true);
    assert.equal(isRequired("commit-dates-utc", p), true);
  });

  it("needs every job when there is no verified plan", () => {
    for (const job of GATED_JOBS) assert.equal(isRequired(job, null), true, job);
  });

  it("excuses a job only when its flag is exactly false", () => {
    const p = { v: 1, jobs: { db: false, build: 0, seams: null, e2e: "false" } };
    assert.equal(isRequired("db", p), false);
    assert.equal(isRequired("build", p), true);
    assert.equal(isRequired("seams", p), true);
    assert.equal(isRequired("e2e", p), true);
    assert.equal(isRequired("containers", p), true, "a job the plan does not name is needed");
  });

  it("reads e2e-report's need from the e2e flag", () => {
    assert.equal(isRequired("e2e-report", { v: 1, jobs: { e2e: false } }), false);
    assert.equal(isRequired("e2e-report", { v: 1, jobs: { e2e: true } }), true);
  });

  it("passes success, and skipped when not needed; fails everything else", () => {
    const map = new Map([
      ["check", "success"],
      ["db", "skipped"],
      ["build", "skipped"],
      ["static", "failure"],
      ["seams", "cancelled"],
      ["e2e", "weird"],
    ]);
    const result = evaluateJobs(map, {
      v: 1,
      jobs: { db: false, build: true, seams: true, e2e: true },
    });
    const byJob = Object.fromEntries(result.verdicts.map((v) => [v.job, v.code]));
    assert.deepEqual(byJob, {
      check: "success",
      db: "skipped_by_plan",
      build: "skipped_but_required",
      static: "failure",
      seams: "cancelled",
      e2e: "unknown_result",
    });
    assert.equal(result.ok, false);
    assert.match(result.code, /build_skipped_but_required/);
  });
});

describe("rule needs-complete", () => {
  it("passes when every gated job is in NEEDS", () => {
    const parsed = parseNeeds(needs());
    assert.equal(parsed.ok && checkNeedsComplete(parsed.needs).ok, true);
  });

  it("fails naming each gated job left out of gate's needs", () => {
    const result = checkNeedsComplete(new Map([["plan", "success"]]));
    assert.equal(result.ok, false);
    assert.match(result.code, /missing_check/);
    assert.match(result.code, /missing_commit-dates-utc/);
  });
});

describe("runGate", () => {
  it("passes when every job succeeded and the plan is main's", () => {
    const { code, lines } = gate({});
    assert.equal(code, 0);
    assert.match(ruleLine(lines, "plan-is-mains"), /result=pass code=match/);
    assert.match(ruleLine(lines, "jobs"), /result=pass/);
    assert.equal(lines.at(-1), "gate.result result=pass failed=0");
  });

  it("passes a job skipped because main's plan said it was not needed", () => {
    const { code, lines } = gate({ needsText: needs({ db: "skipped", build: "skipped" }) });
    assert.equal(code, 0);
    assert.ok(
      lines.includes(
        "gate.job name=db result=skipped required=false verdict=pass code=skipped_by_plan",
      ),
    );
  });

  it("fails a job the plan required that was skipped", () => {
    const { code, lines } = gate({
      needsText: needs({ db: "skipped" }),
      planDoc: plan({ db: true }),
    });
    assert.equal(code, 1);
    assert.match(ruleLine(lines, "jobs"), /result=fail code=db_skipped_but_required/);
  });

  it("fails a failed or cancelled job", () => {
    assert.equal(gate({ needsText: needs({ check: "failure" }) }).code, 1);
    assert.equal(gate({ needsText: needs({ static: "cancelled" }) }).code, 1);
  });

  it("fails when the plan job itself failed or was skipped", () => {
    assert.equal(gate({ needsText: needs({ plan: "failure" }), planDoc: undefined }).code, 1);
    assert.equal(gate({ needsText: needs({ plan: "skipped" }) }).code, 1);
  });

  it("fails when commit-dates-utc was skipped, whatever the plan says", () => {
    const { code } = gate({
      needsText: needs({ "commit-dates-utc": "skipped" }),
      planDoc: plan({ "commit-dates-utc": false }),
    });
    assert.equal(code, 1);
  });

  it("without the engine on main, needs every job: a skip fails even if the plan excuses it", () => {
    const { code, lines } = gate({ needsText: needs({ db: "skipped" }), engine: false });
    assert.equal(code, 1);
    assert.match(ruleLine(lines, "plan-is-mains"), /result=skip code=no_engine/);
    assert.match(ruleLine(lines, "jobs"), /db_skipped_but_required/);
  });

  it("without the engine on main, passes when every job ran and succeeded", () => {
    const { code } = gate({
      engine: false,
      planDoc: everythingPlan({ EVENT_NAME: "pull_request" }),
    });
    assert.equal(code, 0);
  });

  it("fails when main's engine computes another plan (plan_mismatch)", () => {
    const { code, lines } = gate({
      needsText: needs({ db: "skipped" }),
      planDoc: plan({ db: false }),
      recomputed: plan({ db: true }),
    });
    assert.equal(code, 1);
    assert.match(ruleLine(lines, "plan-is-mains"), /result=fail code=plan_mismatch/);
    assert.match(
      ruleLine(lines, "jobs"),
      /db_skipped_but_required/,
      "an unverified plan excuses nothing",
    );
  });

  it("compares plans by content, not by key order", () => {
    const a = plan();
    const b = Object.fromEntries(Object.entries(plan()).reverse());
    assert.equal(gate({ planDoc: a, recomputed: b }).code, 0);
  });

  it("fails when the engine fails, or the plan job's output is unreadable", () => {
    assert.match(
      ruleLine(gate({ recomputeFails: true }).lines, "plan-is-mains"),
      /code=engine_failed/,
    );
    const { code, lines } = gate({ planDoc: "not a plan" });
    assert.equal(code, 1);
    assert.match(ruleLine(lines, "plan-is-mains"), /code=plan_unreadable/);
  });

  it("fails when NEEDS cannot be read", () => {
    const { code, lines } = gate({ needsText: "{" });
    assert.equal(code, 1);
    assert.match(ruleLine(lines, "jobs"), /code=needs_unreadable/);
  });

  it("fails when a gated job is missing from gate's needs", () => {
    const partial = JSON.parse(needs());
    delete partial.db;
    const { code, lines } = gate({ needsText: JSON.stringify(partial) });
    assert.equal(code, 1);
    assert.match(ruleLine(lines, "needs-complete"), /result=fail code=missing_db/);
  });

  it("prints one deferred line for each rule left to hardening, and never fails on them", () => {
    const { code, lines } = gate({});
    assert.equal(code, 0);
    for (const deferred of DEFERRED_RULES) {
      const matching = lines.filter((l) => l.startsWith(`gate.rule name=${deferred.name} `));
      assert.deepEqual(matching, [
        `gate.rule name=${deferred.name} result=deferred code=phase0_trimmed`,
      ]);
    }
    assert.ok(DEFERRED_RULES.some((d) => d.name === "control-paths"));
    assert.ok(DEFERRED_RULES.some((d) => d.name === "receipts"));
  });

  it("never prints a new line or control character from a job result", () => {
    const { lines } = gate({
      needsText: JSON.stringify({ ...JSON.parse(needs()), check: { result: "x\n::error::y" } }),
    });
    for (const line of lines) assert.doesNotMatch(line, /\n/);
    assert.ok(lines.some((l) => l.includes("result=x?::error::y")));
  });
});

describe("gate.mjs as ci.yml runs it", () => {
  /**
   * @param {import("node:test").TestContext} t
   * @param {{ planOut: string, exit?: number, given: string, needsText?: string }} input
   */
  function runScript(t, { planOut, exit = 0, given, needsText = needs() }) {
    const root = tempDir(t);
    writeTree(root, {
      "engine/tools/fin-review/src/main.ts": [
        "// A fake engine: prints the plan the test chose.",
        'if (process.argv[2] !== "plan" || !process.argv.includes("--ci")) process.exit(64);',
        'process.stdout.write(String(process.env.FAKE_PLAN_OUT ?? "") + "\\n");',
        'process.exitCode = Number(process.env.FAKE_EXIT ?? "0");',
        "",
      ].join("\n"),
    });
    return spawnSync(process.execPath, [GATE], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        NEEDS: needsText,
        PLAN: given,
        EVENT_NAME: "pull_request",
        BASE_SHA: BASE,
        HEAD_SHA: HEAD,
        FAKE_PLAN_OUT: planOut,
        FAKE_EXIT: String(exit),
      },
    });
  }

  it("exits 0 when main's engine reproduces the plan", (t) => {
    const doc = JSON.stringify(plan());
    const run = runScript(t, { planOut: doc, given: doc, needsText: needs({ db: "skipped" }) });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /gate\.rule name=plan-is-mains result=pass code=match/);
  });

  it("exits 1 when the engine disagrees", (t) => {
    const run = runScript(t, {
      planOut: JSON.stringify(plan({ db: true })),
      given: JSON.stringify(plan()),
      needsText: needs({ db: "skipped" }),
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /code=plan_mismatch/);
  });

  it("exits 1 when the engine exits non-zero", (t) => {
    const doc = JSON.stringify(plan());
    const run = runScript(t, { planOut: doc, given: doc, exit: 70 });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /code=engine_failed/);
  });

  it("with no engine folder, needs every job and passes when all succeeded", (t) => {
    const root = tempDir(t);
    const run = spawnSync(process.execPath, [GATE], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH, NEEDS: needs(), PLAN: "", ENGINE_DIR: join(root, "none") },
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /plan-is-mains result=skip/);
  });
});
