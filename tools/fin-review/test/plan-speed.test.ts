// T-RV-20 (spec 07 §2.3.1, §12.1): plan on a 2,000-file tree finishes in under 3 seconds on a
// build machine (6 on a CI runner), measured end to end as a real process, Node's start included:
// with no links, and with a few hundred links (a fifth aimed at a folder the change touches), on
// main or added by the change, for the usual spread of changes and for a change of more than a
// thousand files inside the folder the links reach.

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { after, before, describe, it } from "node:test";
import { fixtureLinks, generatePlanSpeedFixture } from "../fixtures/plan-speed/generate.ts";
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

  function timedPlan(from: string, to: string): { document: PlanDocument; elapsed: number } {
    const started = performance.now();
    const run = spawnCli(["plan", "--base", from, "--head", to, "--tree", tmp.dir], {
      env: fixtureEnv(tmp.dir),
    });
    const elapsed = performance.now() - started;
    assert.equal(run.code, 0, run.stderr);
    return { document: JSON.parse(run.stdout) as PlanDocument, elapsed };
  }

  it("the fixture is a 2,000-file tree", () => {
    const tracked = repo
      .git(["ls-tree", "-r", "--name-only", base])
      .split("\n")
      .filter((line) => line !== "");
    assert.equal(tracked.length, 2000);
  });

  it(`plans a wide change in under ${LIMIT_MS} ms`, () => {
    const { document, elapsed } = timedPlan(base, head);
    assert.ok(document.changed > 250, `changed ${document.changed}`);
    assert.equal(document.tier, "S");
    assert.ok(elapsed < LIMIT_MS, `plan took ${Math.round(elapsed)} ms`);
  });

  describe("with symbolic links", () => {
    let linkedBase: string;
    let linkedHead: string;
    let manyBase: string;
    let manyHead: string;

    before(() => {
      // 300 links, 20 of them to packages/core/src: the change reaches every link path it has.
      const linked = generatePlanSpeedFixture(fixtureLayout(), 2000, { links: 300, coreLinks: 20 });
      assert.equal(Object.keys(linked.base).length, 2000);
      linkedBase = repo.commit(null, linked.base);
      linkedHead = repo.commit(linkedBase, linked.head);
      // 463 links, 63 of them (one fewer than a path may have) to packages/core/src, and a head
      // that adds a thousand files there.
      const many = generatePlanSpeedFixture(fixtureLayout(), 2000, {
        links: 463,
        coreLinks: 63,
        addedToCore: 1000,
      });
      assert.equal(Object.keys(many.base).length, 2000);
      manyBase = repo.commit(null, many.base);
      manyHead = repo.commit(manyBase, many.head);
    });

    it(`plans the wide change through 300 links on main in under ${LIMIT_MS} ms`, () => {
      const { document, elapsed } = timedPlan(linkedBase, linkedHead);
      assert.ok(elapsed < LIMIT_MS, `plan took ${Math.round(elapsed)} ms`);
      assert.deepEqual(
        [document.tier, document.everything, document.reason],
        ["S", false, "classes"],
        "every link path is followed, within the caps",
      );
    });

    it(`plans a thousand files added where 63 links reach in under ${LIMIT_MS} ms`, () => {
      const { document, elapsed } = timedPlan(manyBase, manyHead);
      assert.ok(elapsed < LIMIT_MS, `plan took ${Math.round(elapsed)} ms`);
      assert.ok(document.changed > 1200, `changed ${document.changed}`);
      assert.deepEqual(
        [document.everything, document.reason, document.tier],
        [true, "link", "S"],
        "more link paths than the cap run everything",
      );
    });

    it(`plans a change that adds 300 links in under ${LIMIT_MS} ms`, () => {
      const added = repo.commit(head, fixtureLinks(300, 20));
      const { document, elapsed } = timedPlan(base, added);
      assert.ok(elapsed < LIMIT_MS, `plan took ${Math.round(elapsed)} ms`);
      assert.deepEqual([document.everything, document.reason], [true, "link"]);
    });
  });
});
