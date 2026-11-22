// T-RV-20 (spec 07 §2.3.1, §12.1): plan on a 2,000-file tree finishes in under 3 seconds on a
// build machine (6 on a CI runner), measured end to end as a real process, Node's start included:
// with no links, and with a few hundred links (a fifth aimed at a folder the change touches), on
// main or added by the change, for the usual spread of changes and for a change of more than a
// thousand files inside the folder the links reach.
//
// A plan is judged slow only when two things agree: its time on the 2,000-file tree is over the
// limit, and that time grew far more than linearly from the same shape of change on a tree eight
// times smaller (250 files). The growth is taken net of the plan's start: Node's and git's own,
// the same at every size, measured as the plan of a minimal tree (the fixture's skeleton alone,
// with one file changed) and taken off both sizes. Each time is then the fastest of three runs,
// the three trees taking turns. Wall time alone also measures the machine: inside a loaded
// `pnpm check` a plan that takes about 250 ms alone took over 4 seconds, waiting for a core. A
// plan that got quadratic, or one that hangs (the run's own 30-second timeout), still fails. A
// first run under the limit already decides the case, so on a quiet machine each case runs the
// plan once.

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { after, before, describe, it } from "node:test";
import {
  fixtureLinks,
  generatePlanSpeedFixture,
  type PlanSpeedOptions,
} from "../fixtures/plan-speed/generate.ts";
import type { PlanDocument } from "../src/plan/plan.ts";
import { spawnCli } from "./helpers/cli.ts";
import { FixtureRepo, fixtureEnv, tempDir } from "./helpers/git-fixture.ts";
import { fixtureLayout } from "./helpers/monorepo.ts";

const LIMIT_MS = process.env["CI"] === "true" ? 6000 : 3000;
/** The tree the limit is for, and the tree eight times smaller its growth is measured from. */
const LARGE_TREE = 2000;
const SMALL_TREE = 250;
/**
 * Net growth from 250 files to 2,000 above which a plan over the limit fails. Net of the start, a
 * part linear in the tree grows at most about 9.4 times (the minimal tree's own 41 entries are
 * taken off both sizes: 1,959 against 209), 6.9 to 9.6 measured for one that takes each case to
 * the limit; a quadratic part grows about 66 times alone, and 45 to 65 measured or modelled for one
 * that takes a plan to the limit behind the plan's own linear part. 20 leaves linear more than
 * twice its growth and fails quadratic by more than twice.
 */
const MAX_GROWTH = 20;
/**
 * The least the 250-file tree's time over the start counts as: an eighth of the start, so a
 * difference lost in the noise of two slowed times cannot inflate the growth.
 */
const FLOOR_SHARE = 1 / 8;

/** The growth of the fastest times from the 250-file tree to the 2,000, net of the start. */
function netGrowth(startMs: number, smallMs: number, largeMs: number): number {
  return (largeMs - startMs) / Math.max(smallMs - startMs, startMs * FLOOR_SHARE);
}

/** Whether the fastest times (the start, 250 files, 2,000) show a plan that got quadratic. */
function tooSlow(startMs: number, smallMs: number, largeMs: number, limitMs: number): boolean {
  return largeMs >= limitMs && netGrowth(startMs, smallMs, largeMs) > MAX_GROWTH;
}

/** A base and a head to plan between. */
interface Change {
  readonly base: string;
  readonly head: string;
}

describe("T-RV-20's speed rule", () => {
  it("fails a plan over the limit that grew as a quadratic part does, and passes one that grew linearly", () => {
    // [ms for the start, at 250 files, at 2,000, limit, fails]: the plan as it is, linear and
    // quadratic parts planted to take a case to the limit (measured under load), the same parts
    // modelled at the slowest growth, then the rule's edges.
    const cases: [number, number, number, number, boolean][] = [
      [153, 157, 166, 3000, false], // the plan as it is (measured)
      [2754, 2826, 3060, 3000, false], // the plan as it is, every size slowed alike by load: 0.9
      [326, 1199, 6314, 3000, false], // a linear part, the wide change (measured): 6.9
      [244, 584, 3520, 3000, false], // a linear part, 300 links added (measured): 9.6
      [218, 515, 3000, 3000, false], // a linear part at the limit (modelled): 9.4
      [161, 294, 6783, 3000, true], // a quadratic part, 1,000 files added (measured): 50
      [161, 234, 3912, 3000, true], // a quadratic part, 300 links added (measured): 51
      [160, 223, 3000, 3000, true], // a quadratic part at the limit, behind 20 ms of the plan's: 45
      [300, 406, 6000, 6000, true], // the same at CI's limit, behind a 300 ms start: 54
      [300, 300, 3000, 3000, true], // no difference at 250 files counts as the floor: 72
      [160, 300, 2999, 3000, false], // under the limit, whatever the growth
      [200, 340, 3000, 3000, false], // at the limit, net growth 20
      [200, 339, 3000, 3000, true], // at the limit, net growth 20.1
    ];
    for (const [startMs, smallMs, largeMs, limitMs, fails] of cases) {
      assert.equal(
        tooSlow(startMs, smallMs, largeMs, limitMs),
        fails,
        `${startMs} ms, ${smallMs} ms, ${largeMs} ms`,
      );
    }
  });
});

describe("T-RV-20: plan speed", () => {
  let tmp: ReturnType<typeof tempDir>;
  let repo: FixtureRepo;
  let base: string;
  let head: string;

  before(() => {
    tmp = tempDir("plan-speed");
    repo = new FixtureRepo(tmp.dir);
    const fixture = generatePlanSpeedFixture(fixtureLayout());
    assert.equal(Object.keys(fixture.base).length, LARGE_TREE);
    base = repo.commit(null, fixture.base);
    head = repo.commit(base, fixture.head);
  });
  after(() => tmp.cleanup());

  function timedPlan(change: Change): { document: PlanDocument; elapsed: number } {
    const started = performance.now();
    const run = spawnCli(
      ["plan", "--base", change.base, "--head", change.head, "--tree", tmp.dir],
      {
        env: fixtureEnv(tmp.dir),
      },
    );
    const elapsed = performance.now() - started;
    assert.equal(run.code, 0, run.stderr);
    return { document: JSON.parse(run.stdout) as PlanDocument, elapsed };
  }

  /** The base and head of a fixture of `fileCount` files, committed. */
  function commitFixture(fileCount: number, options: PlanSpeedOptions = {}): Change {
    const fixture = generatePlanSpeedFixture(fixtureLayout(), fileCount, options);
    assert.equal(Object.keys(fixture.base).length, fileCount);
    const fixtureBase = repo.commit(null, fixture.base);
    return { base: fixtureBase, head: repo.commit(fixtureBase, fixture.head) };
  }

  /** The minimal change: the fixture's skeleton alone, with one file changed. */
  function minimalChange(): Change {
    const fixture = generatePlanSpeedFixture(fixtureLayout(), 0, { addedToCore: 0 });
    const fixtureBase = repo.commit(null, fixture.base);
    return { base: fixtureBase, head: repo.commit(fixtureBase, fixture.head) };
  }

  /**
   * Plans `large` and judges its speed: over the limit, the fastest of three runs of it, of
   * `small` (made only then) and of the minimal change must pass tooSlow. Returns the first run's
   * plan, for the case's own checks.
   */
  function judgedPlan(large: Change, small: () => Change): PlanDocument {
    const first = timedPlan(large);
    if (first.elapsed < LIMIT_MS) return first.document;
    const [smallChange, minimal] = [small(), minimalChange()];
    let largeMs = first.elapsed;
    let smallMs = Number.POSITIVE_INFINITY;
    let startMs = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      startMs = Math.min(startMs, timedPlan(minimal).elapsed);
      smallMs = Math.min(smallMs, timedPlan(smallChange).elapsed);
      if (run > 0) largeMs = Math.min(largeMs, timedPlan(large).elapsed);
    }
    const growth = netGrowth(startMs, smallMs, largeMs);
    const seen = `${Math.round(startMs)} ms for the start, ${Math.round(smallMs)} ms at ${SMALL_TREE} files, ${Math.round(largeMs)} ms at ${LARGE_TREE}, net growth ${growth.toFixed(1)}`;
    assert.ok(!tooSlow(startMs, smallMs, largeMs, LIMIT_MS), `plan took ${seen}`);
    return first.document;
  }

  it("the fixture is a 2,000-file tree", () => {
    const tracked = repo
      .git(["ls-tree", "-r", "--name-only", base])
      .split("\n")
      .filter((line) => line !== "");
    assert.equal(tracked.length, LARGE_TREE);
  });

  it(`plans a wide change in under ${LIMIT_MS} ms`, () => {
    const document = judgedPlan({ base, head }, () =>
      commitFixture(SMALL_TREE, { addedToCore: 3 }),
    );
    assert.ok(document.changed > 250, `changed ${document.changed}`);
    assert.equal(document.tier, "S");
  });

  describe("with symbolic links", () => {
    let linked: Change;
    let many: Change;

    before(() => {
      // 300 links, 20 of them to packages/core/src: the change reaches every link path it has.
      linked = commitFixture(LARGE_TREE, { links: 300, coreLinks: 20 });
      // 463 links, 63 of them (one fewer than a path may have) to packages/core/src, and a head
      // that adds a thousand files there.
      many = commitFixture(LARGE_TREE, { links: 463, coreLinks: 63, addedToCore: 1000 });
    });

    it(`plans the wide change through 300 links on main in under ${LIMIT_MS} ms`, () => {
      const document = judgedPlan(linked, () =>
        commitFixture(SMALL_TREE, { links: 38, coreLinks: 3, addedToCore: 3 }),
      );
      assert.deepEqual(
        [document.tier, document.everything, document.reason],
        ["S", false, "classes"],
        "every link path is followed, within the caps",
      );
    });

    it(`plans a thousand files added where 63 links reach in under ${LIMIT_MS} ms`, () => {
      // The smaller tree keeps the shape: 63 links reach each of 125 added files, more link paths
      // than the plan follows in a change.
      const document = judgedPlan(many, () =>
        commitFixture(SMALL_TREE, { links: 63, coreLinks: 63, addedToCore: 125 }),
      );
      assert.ok(document.changed > 1200, `changed ${document.changed}`);
      assert.deepEqual(
        [document.everything, document.reason, document.tier],
        [true, "link", "S"],
        "more link paths than the cap run everything",
      );
    });

    it(`plans a change that adds 300 links in under ${LIMIT_MS} ms`, () => {
      const added = repo.commit(head, fixtureLinks(300, 20));
      const document = judgedPlan({ base, head: added }, () => {
        const small = commitFixture(SMALL_TREE, { addedToCore: 3 });
        return { base: small.base, head: repo.commit(small.head, fixtureLinks(38, 3)) };
      });
      assert.deepEqual([document.everything, document.reason], [true, "link"]);
    });
  });
});
