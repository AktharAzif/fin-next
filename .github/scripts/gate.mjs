#!/usr/bin/env node
// The merge gate: ci.yml's `gate` job, the one check the ruleset requires (spec 01 §5.4; spec 07
// §11.2; EXECUTION EX-20). A control path. ci.yml runs main's copy of this file from the engine
// checkout (engine/.github/scripts/gate.mjs), never the pull request's, so a pull request cannot
// weaken its own gate; only the CI pull request that adds this file runs its own copy.
//
// Phase 0 is trimmed (orchestrator decision BD-02): the gate enforces
//   plan-is-mains   when main holds the engine (tools/fin-review/src/main.ts), main's engine
//                   recomputes the plan for the same event, base and head, and it must equal the
//                   plan job's output (spec 07 §11.2 rule 0); before that, every job counts as needed
//   jobs            every job in `needs` succeeded, or was skipped because the (verified) plan said
//                   it was not needed; a job the plan required that was skipped, cancelled or failed
//                   fails the gate (spec 01 §5.4 rule 1)
//   needs-complete  the jobs this gate knows ci.yml has are all in `needs`, so dropping one from
//                   gate's needs fails rather than silently passes
// and prints one `deferred` line for each rule left to hardening: the owner's approval of a
// control-path pull request (rule 2), the review receipt (rule 3) and the merge commit's tree on
// `main` (rule 4). Every rule prints `gate.rule name=<rule> result=<pass|fail|skip|deferred>
// code=<code>`, every job `gate.job ...`, and the job ends with `gate.result result=<pass|fail>`.
//
// Inputs (environment): NEEDS (`toJSON(needs)`), PLAN (the plan job's output), EVENT_NAME,
// BASE_SHA, HEAD_SHA, and optionally ENGINE_DIR (default `engine`) and TREE_DIR (default `.`).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { addSummary, canonicalJson, clean, gitEnv, isMain, isRecord, say } from "./lib/ci.mjs";

/** The jobs ci.yml's gate needs today; each must appear in NEEDS. */
export const GATED_JOBS = ["plan", "check", "db", "build", "static", "commit-dates-utc"];

/** Jobs that are needed whatever the plan says. */
export const ALWAYS_REQUIRED = new Set(["plan", "commit-dates-utc"]);

/** A job whose plan flag has another name. */
export const PLAN_KEYS = /** @type {Record<string, string>} */ ({ "e2e-report": "e2e" });

/** The rules deferred to hardening, each printed once (orchestrator decision BD-02). */
export const DEFERRED_RULES = [
  { name: "control-paths", why: "the owner's approval of a control-path pull request (CI-14)" },
  { name: "receipts", why: "the signed review receipt for the head (spec 07 §6.4)" },
  {
    name: "merge-tree",
    why: "on push to main, the merge commit's tree equals the reviewed head's",
  },
];

export const ENGINE_MAIN = "tools/fin-review/src/main.ts";
const RESULTS = new Set(["success", "failure", "cancelled", "skipped"]);
const JOB_NAME = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Reads NEEDS: `{ "<job>": { "result": "<result>", "outputs": {...} } }`.
 * @param {string | undefined} text
 * @returns {{ ok: true, needs: Map<string, string> } | { ok: false, error: string }}
 */
export function parseNeeds(text) {
  if (text === undefined || text.trim() === "") return { ok: false, error: "NEEDS is empty" };
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "NEEDS is not JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, error: "NEEDS is not an object" };
  /** @type {Map<string, string>} */
  const needs = new Map();
  for (const [job, value] of Object.entries(parsed)) {
    if (!JOB_NAME.test(job)) return { ok: false, error: "NEEDS names a job with a bad name" };
    const result = isRecord(value) ? value.result : undefined;
    needs.set(job, typeof result === "string" ? result : "unknown");
  }
  if (needs.size === 0) return { ok: false, error: "NEEDS names no job" };
  return { ok: true, needs };
}

/**
 * Reads a plan document (spec 07 §10.1): an object with `v: 1` and a `jobs` object.
 * @param {string | undefined} text
 * @returns {Record<string, unknown> | null}
 */
export function parsePlan(text) {
  if (text === undefined || text.trim() === "") return null;
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed) && parsed.v === 1 && isRecord(parsed.jobs)) return parsed;
  } catch {
    // An unreadable plan is the same as no plan: every job is needed.
  }
  return null;
}

/**
 * Whether a job is needed. Without a verified plan every job is; with one, a job is not needed
 * only when its plan flag is exactly `false` (a missing or malformed flag means needed).
 * @param {string} job
 * @param {Record<string, unknown> | null} plan the verified plan, or null
 * @returns {boolean}
 */
export function isRequired(job, plan) {
  if (ALWAYS_REQUIRED.has(job) || plan === null) return true;
  const jobs = plan.jobs;
  if (!isRecord(jobs)) return true;
  const flag = jobs[PLAN_KEYS[job] ?? job];
  return flag !== false;
}

/**
 * Rule `jobs`: one verdict per job in NEEDS.
 * @param {Map<string, string>} needs
 * @param {Record<string, unknown> | null} plan the verified plan, or null
 */
export function evaluateJobs(needs, plan) {
  const verdicts = [...needs].map(([job, result]) => {
    const required = isRequired(job, plan);
    /** @type {string} */
    let code;
    let ok = false;
    if (result === "success") {
      ok = true;
      code = "success";
    } else if (result === "skipped" && !required) {
      ok = true;
      code = "skipped_by_plan";
    } else if (result === "skipped") {
      code = "skipped_but_required";
    } else if (RESULTS.has(result)) {
      code = result;
    } else {
      code = "unknown_result";
    }
    return { job, result, required, ok, code };
  });
  const failed = verdicts.filter((v) => !v.ok);
  return {
    ok: failed.length === 0,
    code: failed.length === 0 ? "ok" : failed.map((v) => `${v.job}_${v.code}`).join(","),
    verdicts,
  };
}

/**
 * Rule `needs-complete`: every job in GATED_JOBS is in NEEDS.
 * @param {Map<string, string>} needs
 */
export function checkNeedsComplete(needs) {
  const missing = GATED_JOBS.filter((job) => !needs.has(job));
  return {
    ok: missing.length === 0,
    code: missing.length === 0 ? "ok" : missing.map((job) => `missing_${job}`).join(","),
  };
}

/**
 * Runs main's engine to recompute the plan. Exported for tests, which pass a fake engine.
 * @param {{ engineDir: string, treeDir: string, env: NodeJS.ProcessEnv }} options
 * @returns {{ ok: true, plan: Record<string, unknown> } | { ok: false, code: string }}
 */
export function recomputePlan({ engineDir, treeDir, env }) {
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = {
    ...gitEnv(env),
    EVENT_NAME: env.EVENT_NAME ?? "",
    BASE_SHA: env.BASE_SHA ?? "",
    HEAD_SHA: env.HEAD_SHA ?? "",
  };
  const run = spawnSync(
    process.execPath,
    [join(engineDir, ENGINE_MAIN), "plan", "--ci", "--tree", treeDir],
    { env: childEnv, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 180_000 },
  );
  if (run.error !== undefined || run.status !== 0) return { ok: false, code: "engine_failed" };
  const last = run.stdout.trim().split("\n").at(-1) ?? "";
  const plan = parsePlan(last);
  return plan === null ? { ok: false, code: "engine_output_unreadable" } : { ok: true, plan };
}

/**
 * @typedef {{
 *   env: NodeJS.ProcessEnv,
 *   cwd: string,
 *   print: (line: string) => void,
 *   engineExists?: (file: string) => boolean,
 *   recompute?: typeof recomputePlan,
 * }} GateContext
 */

/**
 * Runs every rule and returns the exit code (0 pass, 1 fail).
 * @param {GateContext} ctx
 * @returns {number}
 */
export function runGate(ctx) {
  const { env, print } = ctx;
  const engineDir = resolve(ctx.cwd, env.ENGINE_DIR || "engine");
  const treeDir = resolve(ctx.cwd, env.TREE_DIR || ".");
  const engineExists = ctx.engineExists ?? existsSync;
  const recompute = ctx.recompute ?? recomputePlan;
  /** @type {{ name: string, result: string, code: string }[]} */
  const rules = [];
  const rule = (/** @type {string} */ name, /** @type {string} */ result, code = "ok") => {
    rules.push({ name, result, code });
    print(`gate.rule name=${name} result=${result} code=${clean(code, 500)}`);
  };

  // Rule 0: the plan is main's. Only a plan main's engine reproduces can excuse a skipped job.
  /** @type {Record<string, unknown> | null} */
  let verifiedPlan = null;
  const given = parsePlan(env.PLAN);
  if (!engineExists(join(engineDir, ENGINE_MAIN))) {
    rule("plan-is-mains", "skip", "no_engine_on_main_every_job_needed");
  } else if (given === null) {
    rule("plan-is-mains", "fail", "plan_unreadable");
  } else {
    const again = recompute({ engineDir, treeDir, env });
    if (!again.ok) rule("plan-is-mains", "fail", again.code);
    else if (canonicalJson(again.plan) !== canonicalJson(given)) {
      rule("plan-is-mains", "fail", "plan_mismatch");
    } else {
      verifiedPlan = given;
      rule("plan-is-mains", "pass", "match");
    }
  }

  // Rule 1: every job passed, or was skipped because the verified plan said so.
  const needs = parseNeeds(env.NEEDS);
  if (!needs.ok) {
    rule("jobs", "fail", "needs_unreadable");
    rule("needs-complete", "fail", "needs_unreadable");
  } else {
    const jobs = evaluateJobs(needs.needs, verifiedPlan);
    for (const v of jobs.verdicts) {
      print(
        `gate.job name=${v.job} result=${clean(v.result, 40)} required=${v.required} verdict=${v.ok ? "pass" : "fail"} code=${v.code}`,
      );
    }
    rule("jobs", jobs.ok ? "pass" : "fail", jobs.code);
    const complete = checkNeedsComplete(needs.needs);
    rule("needs-complete", complete.ok ? "pass" : "fail", complete.code);
    addSummary(
      [
        "| Job | Result | Needed | Verdict |",
        "|---|---|---|---|",
        ...jobs.verdicts.map(
          (v) =>
            `| ${v.job} | ${clean(v.result, 40)} | ${v.required} | ${v.ok ? "pass" : "fail"} |`,
        ),
      ].join("\n"),
      env,
    );
  }

  // Rules 2 to 4: deferred to hardening (BD-02, Phase 0 trimmed).
  for (const deferred of DEFERRED_RULES) rule(deferred.name, "deferred", "phase0_trimmed");

  const failed = rules.filter((r) => r.result === "fail");
  print(`gate.result result=${failed.length === 0 ? "pass" : "fail"} failed=${failed.length}`);
  addSummary(
    `\n**gate: ${failed.length === 0 ? "pass" : "fail"}**. Deferred to hardening: ${DEFERRED_RULES.map((d) => d.why).join("; ")}.`,
    env,
  );
  return failed.length === 0 ? 0 : 1;
}

if (isMain(import.meta)) {
  process.exitCode = runGate({ env: process.env, cwd: process.cwd(), print: say });
}
