// T-RV-20 (spec 07 §2.3.1, §12.1): plan on a 2,000-file tree finishes in under 3 seconds on a
// build machine (6 on a CI runner): with no links, and with a few hundred links (a fifth aimed at
// a folder the change touches), on main or added by the change, for the usual spread of changes
// and for a change of more than a thousand files inside the folder the links reach.
//
// Each case plans its change twice. Once end to end as a real process, Node's start included, for
// the case's own checks of the plan; its time is not judged, but for a hang: it is killed after
// HANG_MS, far beyond anything load can cause. Once in this process, for its speed, judged on the
// thread's CPU time, not the clock on the wall: the planner's own work (reading git's output, the
// layout and the links, and building the plan), not git's, which runs in processes of its own.
// What load adds is time spent waiting for a core, and it adds it unevenly: the short runs land in
// quiet moments and a run of seconds cannot, so a linear part that took the wall time to the limit
// measured a growth anywhere from 6.9 to 22.2 under load, either side of the threshold.
//
// A plan is judged slow only when two things agree: its CPU time on the 2,000-file tree is over
// the limit, and that time grew far more than linearly from the same shape of change on a tree
// eight times smaller (250 files). The growth is taken net of the plan's start (reading the
// configuration and starting git, the same at every size), measured as the plan of a minimal tree
// (the fixture's skeleton alone, with one file changed) and taken off both sizes. Each time is the
// fastest of three runs, the three trees taking turns: a run on one of the machine's slower cores
// takes more CPU time for the same work. A first run under the limit already decides the case, so
// each case runs the plan in this process once unless it is slow.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  fixtureLinks,
  generatePlanSpeedFixture,
  type PlanSpeedOptions,
} from "../fixtures/plan-speed/generate.ts";
import type { PlanDocument } from "../src/plan/plan.ts";
import { cli, spawnCli } from "./helpers/cli.ts";
import { FixtureRepo, fixtureEnv, tempDir } from "./helpers/git-fixture.ts";
import { fixtureLayout } from "./helpers/monorepo.ts";

/** The CPU time of the plan in this process at 2,000 files over which its growth is judged. */
const LIMIT_MS = process.env["CI"] === "true" ? 6000 : 3000;
/**
 * The end-to-end run's bound, which only a hang reaches: the plan takes about 250 ms alone and
 * took over 4 seconds inside a loaded `pnpm check`, and a part that takes it to the limit alone
 * was seen to take ten times its CPU time on one run under load, and over 40 seconds of wall time.
 */
const HANG_MS = 300_000;
/** The tree the limit is for, and the tree eight times smaller its growth is measured from. */
const LARGE_TREE = 2000;
const SMALL_TREE = 250;
/**
 * Net growth from 250 files to 2,000 above which a plan over the limit fails. Net of the start, a
 * part linear in the tree grows at most about 9.4 times (the minimal tree's own 41 entries are
 * taken off both sizes: 1,959 against 209), and 9.1 to 9.8 was measured inside loaded uncached
 * `pnpm check` runs for one that takes each case over the limit; a quadratic part grows about 66
 * times alone, and 43 to 66 was measured for one that takes each case over the limit behind the
 * plan's own work. 20 leaves linear twice its growth and fails quadratic by twice.
 */
const MAX_GROWTH = 20;
/**
 * The least the 250-file tree's time over the start counts as: an eighth of the start, so a
 * difference lost in the noise of two readings cannot inflate the growth.
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

/** The CPU time this thread has used, in milliseconds. */
function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/** A base and a head to plan between. */
interface Change {
  readonly base: string;
  readonly head: string;
}

describe("T-RV-20's speed rule", () => {
  it("fails a plan over the limit that grew as a quadratic part does, and passes one that grew linearly", () => {
    // [CPU ms for the start, at 250 files, at 2,000, limit, fails]: the plan as it is, linear and
    // quadratic parts planted to take each case over the limit (measured inside loaded uncached
    // `pnpm check` runs), the same parts modelled at their slowest growth, then the rule's edges.
    const cases: [number, number, number, number, boolean][] = [
      [6, 9, 14, 3000, false], // the plan as it is, the wide change (measured)
      [13, 13, 62, 3000, false], // the plan as it is, 300 links added (measured)
      [2754, 2826, 3060, 3000, false], // every size slowed alike: 0.9
      [82, 459, 3565, 3000, false], // a linear part, the wide change (measured): 9.2
      [82, 426, 3465, 3000, false], // a linear part, 300 links on main (measured): 9.8
      [218, 515, 3000, 3000, false], // a linear part at the limit (modelled): 9.4
      [12, 67, 3360, 3000, true], // a quadratic part, the wide change (measured): 60.9
      [21, 166, 6293, 3000, true], // a quadratic part, 1,000 files added (measured): 43.3
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

  function planArgs(change: Change): string[] {
    return ["plan", "--base", change.base, "--head", change.head, "--tree", tmp.dir];
  }

  /** The plan of `change`, end to end as a real process, killed only by a hang. */
  function processPlan(change: Change): PlanDocument {
    const run = spawnCli(planArgs(change), { env: fixtureEnv(tmp.dir), timeoutMs: HANG_MS });
    assert.equal(run.code, 0, run.stderr);
    return JSON.parse(run.stdout) as PlanDocument;
  }

  /** The CPU time this thread spends on the plan of `change`, run in this process. */
  async function cpuPlan(change: Change): Promise<number> {
    const started = threadCpuMs();
    const run = await cli(planArgs(change), { env: fixtureEnv(tmp.dir) });
    const used = threadCpuMs() - started;
    assert.equal(run.code, 0, run.stderr);
    return used;
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
   * Plans `large` end to end, for the plan it returns, and judges its speed in this process: over
   * the limit, the fastest CPU times of three runs of it, of `small` (made only then) and of the
   * minimal change must pass tooSlow.
   */
  async function judgedPlan(large: Change, small: () => Change): Promise<PlanDocument> {
    const document = processPlan(large);
    let largeMs = await cpuPlan(large);
    if (largeMs < LIMIT_MS) return document;
    const [smallChange, minimal] = [small(), minimalChange()];
    let smallMs = Number.POSITIVE_INFINITY;
    let startMs = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      startMs = Math.min(startMs, await cpuPlan(minimal));
      smallMs = Math.min(smallMs, await cpuPlan(smallChange));
      if (run > 0) largeMs = Math.min(largeMs, await cpuPlan(large));
    }
    const growth = netGrowth(startMs, smallMs, largeMs);
    const ms = (value: number): string => `${Math.round(value)} ms of CPU`;
    const seen = `${ms(startMs)} for the start, ${ms(smallMs)} at ${SMALL_TREE} files, ${ms(largeMs)} at ${LARGE_TREE}, net growth ${growth.toFixed(1)}`;
    assert.ok(!tooSlow(startMs, smallMs, largeMs, LIMIT_MS), `plan took ${seen}`);
    return document;
  }

  it("the fixture is a 2,000-file tree", () => {
    const tracked = repo
      .git(["ls-tree", "-r", "--name-only", base])
      .split("\n")
      .filter((line) => line !== "");
    assert.equal(tracked.length, LARGE_TREE);
  });

  it(`plans a wide change in under ${LIMIT_MS} ms of CPU, or in linear time`, async () => {
    const document = await judgedPlan({ base, head }, () =>
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

    it(`plans the wide change through 300 links on main in under ${LIMIT_MS} ms of CPU, or in linear time`, async () => {
      const document = await judgedPlan(linked, () =>
        commitFixture(SMALL_TREE, { links: 38, coreLinks: 3, addedToCore: 3 }),
      );
      assert.deepEqual(
        [document.tier, document.everything, document.reason],
        ["S", false, "classes"],
        "every link path is followed, within the caps",
      );
    });

    it(`plans a thousand files added where 63 links reach in under ${LIMIT_MS} ms of CPU, or in linear time`, async () => {
      // The smaller tree keeps the shape: 63 links reach each of 125 added files, more link paths
      // than the plan follows in a change.
      const document = await judgedPlan(many, () =>
        commitFixture(SMALL_TREE, { links: 63, coreLinks: 63, addedToCore: 125 }),
      );
      assert.ok(document.changed > 1200, `changed ${document.changed}`);
      assert.deepEqual(
        [document.everything, document.reason, document.tier],
        [true, "link", "S"],
        "more link paths than the cap run everything",
      );
    });

    it(`plans a change that adds 300 links in under ${LIMIT_MS} ms of CPU, or in linear time`, async () => {
      const added = repo.commit(head, fixtureLinks(300, 20));
      const document = await judgedPlan({ base, head: added }, () => {
        const small = commitFixture(SMALL_TREE, { addedToCore: 3 });
        return { base: small.base, head: repo.commit(small.head, fixtureLinks(38, 3)) };
      });
      assert.deepEqual([document.everything, document.reason], [true, "link"]);
    });
  });
});
