// T-RV-20 (spec 07 §2.3.1, §12.1): plan on a 2,000-file tree finishes in under 3 seconds on a
// build machine (6 on a CI runner), measured end to end as a real process, Node's start included.

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { after, before, describe, it } from "node:test";
import { generatePlanSpeedFixture } from "../fixtures/plan-speed/generate.ts";
import type { PlanDocument } from "../src/plan/plan.ts";
import { spawnCli } from "./helpers/cli.ts";
import { FixtureRepo, fixtureEnv, tempDir } from "./helpers/git-fixture.ts";
import { fixtureLayout } from "./helpers/monorepo.ts";

const LIMIT_MS = process.env["CI"] === "true" ? 6000 : 3000;

describe("T-RV-20: plan speed", () => {
  let tmp: ReturnType<typeof tempDir>;
  let repo: FixtureRepo;
  let base: string;
  let head: string;

  before(() => {
    tmp = tempDir("plan-speed");
    repo = new FixtureRepo(tmp.dir);
    const fixture = generatePlanSpeedFixture(fixtureLayout());
    assert.equal(Object.keys(fixture.base).length, 2000);
    base = repo.commit(null, fixture.base);
    head = repo.commit(base, fixture.head);
  });
  after(() => tmp.cleanup());

  it("the fixture is a 2,000-file tree", () => {
    const tracked = repo.git(["ls-tree", "-r", "--name-only", base]).split("\n").filter((line) => line !== "");
    assert.equal(tracked.length, 2000);
  });

  it(`plans a wide change in under ${LIMIT_MS} ms`, () => {
    const started = performance.now();
    const run = spawnCli(["plan", "--base", base, "--head", head, "--tree", tmp.dir], { env: fixtureEnv(tmp.dir) });
    const elapsed = performance.now() - started;
    assert.equal(run.code, 0, run.stderr);
    const document = JSON.parse(run.stdout) as PlanDocument;
    assert.ok(document.changed > 250, `changed ${document.changed}`);
    assert.equal(document.tier, "S");
    assert.ok(elapsed < LIMIT_MS, `plan took ${Math.round(elapsed)} ms`);
  });
});
