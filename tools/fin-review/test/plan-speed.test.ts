// T-RV-20 (spec 07 §2.3.1, §12.1): plan on a 2,000-file tree finishes in under 3 seconds on a
// build machine (6 on a CI runner): with no links, and with a few hundred links (a fifth aimed at
// a folder the change touches), on main or added by the change, for the usual spread of changes
// and for a change of more than a thousand files inside the folder the links reach.
//
// Every run of the plan is a process of its own, as every real `fin-review plan` is, so every run
// pays for what a module remembers or warms up as a real run does. (Runs in the test's own process
// would pay for a part remembered at module scope once, and the fastest of them would skip it.)
// The process (helpers/timed-cli.ts) runs runCli as main.ts does and reports its thread's CPU time
// around the call: the planner's own work (reading git's output, the layout and the links, and
// building the plan), not Node's start, and not git's, which runs in processes of its own. The
// first run's plan is the one the case checks. A run is killed only by a hang, after HANG_MS.
//
// The time is CPU time, not the clock on the wall. What load adds is time spent waiting for a core,
// and it adds it unevenly: the short runs land in quiet moments and a run of seconds cannot, so a
// linear part that took the wall time to the limit measured a growth anywhere from 6.9 to 22.2
// under load, either side of the threshold.
//
// A plan is judged slow only when two things agree: its CPU time on the 2,000-file tree is over
// the limit, and its time grew far more than linearly between the same shape of change on a tree
// of 250 files and on one of 4,000, sixteen times larger. The growth is taken net of the plan's
// start (reading the configuration, starting git and compiling the planner's code, the same at
// every size), measured as the plan of a minimal tree (the fixture's skeleton alone, with one file
// changed) and taken off both sizes. Each of those times is the fastest of three runs, the trees
// taking turns: a run on one of the machine's slower cores takes more CPU time for the same work.
// A first run under the limit already decides the case, so each case runs the plan once unless it
// is slow. Sixteen times apart, a linear part grows about 19 times and a quadratic one about 263,
// fourteen times as much; eight times apart (250 to 2,000) it was seven times as much, and under
// an uncached check's load the least quadratic growth measured was only about three times the
// greatest linear one, which leaves no threshold both its margins.
//
// Every timed run starts Node with TIMED_NODE_FLAGS (V8 single-threaded), so that work V8 moves
// to its helper threads when they get a core, and does on the timed thread when they do not, is
// always on the timed thread, however loaded the machine.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  fixtureLinks,
  generatePlanSpeedFixture,
  type PlanSpeedOptions,
} from "../fixtures/plan-speed/generate.ts";
import type { PlanDocument } from "../src/plan/plan.ts";
import { cli, spawnCli, TIMED_CLI, TIMED_NODE_FLAGS } from "./helpers/cli.ts";
import { FixtureRepo, fixtureEnv, tempDir } from "./helpers/git-fixture.ts";
import { fixtureLayout } from "./helpers/monorepo.ts";
import type { TimedCliRun } from "./helpers/timed-cli.ts";

/** The CPU time of the plan's process at 2,000 files over which its growth is judged. */
const LIMIT_MS = process.env["CI"] === "true" ? 6000 : 3000;
/**
 * A run's bound, which only a hang reaches: the plan takes about 250 ms alone and took over 4
 * seconds inside a loaded `pnpm check`, and a part that takes it to the limit alone was seen to
 * take ten times its CPU time on one run under load, and over 40 seconds of wall time; a
 * quadratic part takes the 4,000-file tree to about four times the limit.
 */
const HANG_MS = 300_000;
/** The tree the limit is for. */
const LIMIT_TREE = 2000;
/** The trees the growth is measured between, sixteen times apart. */
const SMALL_TREE = 250;
const BIG_TREE = 4000;
/**
 * Net growth from 250 files to 4,000 above which a plan over the limit fails. Net of the start, a
 * part linear in the tree grows about 19 times (the minimal tree's own 41 entries are taken off
 * both sizes: 3,959 against 209) and a quadratic part about 263 times.
 */
const MAX_GROWTH = 48;
/** How many runs of each tree a slow plan's times are the fastest of. */
const RUNS = 3;
/**
 * The least the 250-file tree's time over the start counts as: an eighth of the start, so a
 * difference lost in the noise of two readings cannot inflate the growth.
 */
const FLOOR_SHARE = 1 / 8;

/** The growth of the fastest times from the 250-file tree to the 4,000, net of the start. */
function netGrowth(startMs: number, smallMs: number, bigMs: number): number {
  return (bigMs - startMs) / Math.max(smallMs - startMs, startMs * FLOOR_SHARE);
}

/**
 * Whether a plan is too slow: its first run at 2,000 files is over the limit and the fastest times
 * (the start, 250 files, 4,000) show it grew as a quadratic part does.
 */
function tooSlow(
  limitTreeMs: number,
  startMs: number,
  smallMs: number,
  bigMs: number,
  limitMs: number,
): boolean {
  return limitTreeMs >= limitMs && netGrowth(startMs, smallMs, bigMs) > MAX_GROWTH;
}

/** A base and a head to plan between. */
interface Change {
  readonly base: string;
  readonly head: string;
}

/** A case's shape of change on the trees its growth is measured between. */
interface Shape {
  readonly small: () => Change;
  readonly big: () => Change;
}

describe("T-RV-20's speed rule", () => {
  it("fails a plan over the limit that grew as a quadratic part does, and passes one that grew linearly", () => {
    // [CPU ms of the first run at 2,000 files, then the fastest for the start, at 250 files and at
    // 4,000, limit, fails]: the plan as it is, linear and quadratic parts modelled at the limit,
    // then the rule's edges.
    const cases: [number, number, number, number, number, boolean][] = [
      [53, 30, 37, 80, 3000, false], // the plan as it is, under the limit at 2,000 files
      [3060, 2754, 2826, 3150, 3000, false], // every size slowed alike: 5.5
      [3000, 218, 515, 5831, 3000, false], // a linear part at the limit (modelled): 18.9
      [3000, 160, 222, 11200, 3000, true], // a quadratic part at the limit, behind 20 ms: 178
      [6000, 300, 422, 22500, 6000, true], // the same at CI's limit, behind a 300 ms start: 182
      [3000, 300, 300, 3000, 3000, true], // no difference at 250 files counts as the floor: 72
      [2999, 160, 300, 30000, 3000, false], // under the limit at 2,000 files, whatever the growth
      [3000, 200, 300, 5000, 3000, false], // at the limit, net growth 48
      [3000, 200, 300, 5001, 3000, true], // at the limit, net growth 48.01
    ];
    for (const [limitTreeMs, startMs, smallMs, bigMs, limitMs, fails] of cases) {
      assert.equal(
        tooSlow(limitTreeMs, startMs, smallMs, bigMs, limitMs),
        fails,
        `${limitTreeMs} ms; ${startMs} ms, ${smallMs} ms, ${bigMs} ms`,
      );
    }
  });
});

describe("T-RV-20's timed run", () => {
  it("reports a run in a process of its own as runCli returns it, with its CPU time", async () => {
    for (const argv of [["help"], ["no-such-command"]]) {
      const run = spawnCli(argv, { main: TIMED_CLI, nodeFlags: TIMED_NODE_FLAGS });
      assert.equal(run.code, 0, run.stderr);
      const timed = JSON.parse(run.stdout) as TimedCliRun;
      const inProcess = await cli(argv);
      assert.deepEqual(
        { code: timed.code, stdout: timed.stdout, stderr: timed.stderr },
        inProcess,
        argv.join(" "),
      );
      assert.ok(Number.isFinite(timed.cpuMs) && timed.cpuMs > 0, `${timed.cpuMs} ms of CPU`);
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
    assert.equal(Object.keys(fixture.base).length, LIMIT_TREE);
    base = repo.commit(null, fixture.base);
    head = repo.commit(base, fixture.head);
  });
  after(() => tmp.cleanup());

  function planArgs(change: Change): string[] {
    return ["plan", "--base", change.base, "--head", change.head, "--tree", tmp.dir];
  }

  /** The plan of `change` in a process of its own, and its CPU time; killed only by a hang. */
  function timedPlan(change: Change): { document: PlanDocument; cpuMs: number } {
    const run = spawnCli(planArgs(change), {
      main: TIMED_CLI,
      nodeFlags: TIMED_NODE_FLAGS,
      env: fixtureEnv(tmp.dir),
      timeoutMs: HANG_MS,
    });
    assert.equal(run.code, 0, run.stderr);
    const timed = JSON.parse(run.stdout) as TimedCliRun;
    assert.equal(timed.code, 0, timed.stderr);
    return { document: JSON.parse(timed.stdout) as PlanDocument, cpuMs: timed.cpuMs };
  }

  /** The base and head of a fixture of `fileCount` files, committed. */
  function commitFixture(fileCount: number, options: PlanSpeedOptions = {}): Change {
    const fixture = generatePlanSpeedFixture(fixtureLayout(), fileCount, options);
    assert.equal(Object.keys(fixture.base).length, fileCount);
    const fixtureBase = repo.commit(null, fixture.base);
    return { base: fixtureBase, head: repo.commit(fixtureBase, fixture.head) };
  }

  /** `change` with `count` links added by its head, `core` of them to packages/core/src. */
  function withLinks(change: Change, count: number, core: number): Change {
    return { base: change.base, head: repo.commit(change.head, fixtureLinks(count, core)) };
  }

  /** The minimal change: the fixture's skeleton alone, with one file changed. */
  function minimalChange(): Change {
    const fixture = generatePlanSpeedFixture(fixtureLayout(), 0, { addedToCore: 0 });
    const fixtureBase = repo.commit(null, fixture.base);
    return { base: fixtureBase, head: repo.commit(fixtureBase, fixture.head) };
  }

  /**
   * Plans `large`, the case's change on the 2,000-file tree, and judges its speed: when that run
   * is over the limit, the fastest CPU times of three runs each of the minimal change and of the
   * case's shape at 250 and at 4,000 files (made only then), each in a process of its own, must
   * pass tooSlow. Returns the first run's plan, for the case's own checks.
   */
  function judgedPlan(large: Change, shape: Shape): PlanDocument {
    const first = timedPlan(large);
    if (first.cpuMs < LIMIT_MS) return first.document;
    const [minimal, small, big] = [minimalChange(), shape.small(), shape.big()];
    let startMs = Number.POSITIVE_INFINITY;
    let smallMs = Number.POSITIVE_INFINITY;
    let bigMs = Number.POSITIVE_INFINITY;
    for (let run = 0; run < RUNS; run++) {
      startMs = Math.min(startMs, timedPlan(minimal).cpuMs);
      smallMs = Math.min(smallMs, timedPlan(small).cpuMs);
      bigMs = Math.min(bigMs, timedPlan(big).cpuMs);
    }
    const growth = netGrowth(startMs, smallMs, bigMs);
    const ms = (value: number): string => `${Math.round(value)} ms of CPU`;
    const seen = `${ms(first.cpuMs)} at ${LIMIT_TREE} files; ${ms(startMs)} for the start, ${ms(smallMs)} at ${SMALL_TREE}, ${ms(bigMs)} at ${BIG_TREE}, net growth ${growth.toFixed(1)}`;
    assert.ok(!tooSlow(first.cpuMs, startMs, smallMs, bigMs, LIMIT_MS), `plan took ${seen}`);
    return first.document;
  }

  it("the fixture is a 2,000-file tree", () => {
    const tracked = repo
      .git(["ls-tree", "-r", "--name-only", base])
      .split("\n")
      .filter((line) => line !== "");
    assert.equal(tracked.length, LIMIT_TREE);
  });

  it(`plans a wide change in under ${LIMIT_MS} ms of CPU, or in linear time`, () => {
    const document = judgedPlan(
      { base, head },
      {
        small: () => commitFixture(SMALL_TREE, { addedToCore: 3 }),
        big: () => commitFixture(BIG_TREE, { addedToCore: 40 }),
      },
    );
    assert.ok(document.changed > 250, `changed ${document.changed}`);
    assert.equal(document.tier, "S");
  });

  describe("with symbolic links", () => {
    let linked: Change;
    let many: Change;

    before(() => {
      // 300 links, 20 of them to packages/core/src: the change reaches every link path it has.
      linked = commitFixture(LIMIT_TREE, { links: 300, coreLinks: 20 });
      // 463 links, 63 of them (one fewer than a path may have) to packages/core/src, and a head
      // that adds a thousand files there.
      many = commitFixture(LIMIT_TREE, { links: 463, coreLinks: 63, addedToCore: 1000 });
    });

    it(`plans the wide change through 300 links on main in under ${LIMIT_MS} ms of CPU, or in linear time`, () => {
      // At 4,000 files the links are as many and fewer of them reach packages/core/src, so the
      // change's link paths stay within the caps there too.
      const document = judgedPlan(linked, {
        small: () => commitFixture(SMALL_TREE, { links: 38, coreLinks: 3, addedToCore: 3 }),
        big: () => commitFixture(BIG_TREE, { links: 300, coreLinks: 10, addedToCore: 40 }),
      });
      assert.deepEqual(
        [document.tier, document.everything, document.reason],
        ["S", false, "classes"],
        "every link path is followed, within the caps",
      );
    });

    it(`plans a thousand files added where 63 links reach in under ${LIMIT_MS} ms of CPU, or in linear time`, () => {
      // The other trees keep the shape: 63 links reach each of the files added, more link paths
      // than the plan follows in a change.
      const document = judgedPlan(many, {
        small: () => commitFixture(SMALL_TREE, { links: 63, coreLinks: 63, addedToCore: 125 }),
        big: () => commitFixture(BIG_TREE, { links: 463, coreLinks: 63, addedToCore: 2000 }),
      });
      assert.ok(document.changed > 1200, `changed ${document.changed}`);
      assert.deepEqual(
        [document.everything, document.reason, document.tier],
        [true, "link", "S"],
        "more link paths than the cap run everything",
      );
    });

    it(`plans a change that adds 300 links in under ${LIMIT_MS} ms of CPU, or in linear time`, () => {
      const added = repo.commit(head, fixtureLinks(300, 20));
      const document = judgedPlan(
        { base, head: added },
        {
          small: () => withLinks(commitFixture(SMALL_TREE, { addedToCore: 3 }), 38, 3),
          big: () => withLinks(commitFixture(BIG_TREE, { addedToCore: 40 }), 300, 20),
        },
      );
      assert.deepEqual([document.everything, document.reason], [true, "link"]);
    });
  });
});
