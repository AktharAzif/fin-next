// The plan before main holds the engine: everything runs, in the engine's document shape.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isRequired } from "../gate.mjs";
import { everythingPlan } from "../plan-fallback.mjs";

const SCRIPT = fileURLToPath(new URL("../plan-fallback.mjs", import.meta.url));
const HEAD = "a".repeat(40);

describe("plan-fallback", () => {
  it("turns on every job ci.yml has, and the review job off", () => {
    const plan = everythingPlan({
      EVENT_NAME: "pull_request",
      BASE_SHA: "b".repeat(40),
      HEAD_SHA: HEAD,
    });
    assert.equal(plan.v, 1);
    assert.equal(plan.everything, true);
    assert.equal(plan.reason, "no_engine");
    for (const job of ["check", "db", "build", "seams", "e2e", "static", "bun", "containers"]) {
      assert.equal(plan.jobs[/** @type {keyof typeof plan.jobs} */ (job)], true, job);
      assert.equal(isRequired(job, plan), true, job);
    }
    assert.equal(plan.jobs.review, false);
  });

  it("keeps only well-formed SHAs and event names", () => {
    const plan = everythingPlan({
      EVENT_NAME: "Bad Event",
      BASE_SHA: "0".repeat(40),
      HEAD_SHA: "HEAD",
    });
    assert.equal(plan.event, "local");
    assert.equal(plan.base, null);
    assert.equal(plan.head, null);
  });

  it("prints one plan= line of JSON for $GITHUB_OUTPUT", () => {
    const run = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, EVENT_NAME: "push", BASE_SHA: "", HEAD_SHA: HEAD },
    });
    assert.equal(run.status, 0);
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.startsWith("plan="));
    const doc = JSON.parse((lines[0] ?? "").slice("plan=".length));
    assert.equal(doc.event, "push");
    assert.equal(doc.head, HEAD);
  });
});
