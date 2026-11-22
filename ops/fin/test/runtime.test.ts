import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXIT } from "../src/core/errors.ts";
import { GENESIS, sha256 } from "../src/core/runlog.ts";
import {
  INTERRUPT_SIGNALS,
  processRuntime,
  REPEAT_GRACE_MS,
  STOP_EXIT,
  stopDescription,
} from "../src/core/runtime.ts";
import { type Child, spawnChild } from "./helpers/child.ts";
import { tempDir, writePrivate } from "./helpers/fixtures.ts";

describe("the process runtime", () => {
  it("stops on SIGINT, SIGTERM, SIGHUP and SIGQUIT with 128 + the signal's number, and on a closed output or an uncaught error with 70", () => {
    assert.deepEqual([...INTERRUPT_SIGNALS].sort(), ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"]);
    assert.deepEqual(STOP_EXIT, {
      SIGHUP: 129,
      SIGINT: 130,
      SIGQUIT: 131,
      SIGTERM: 143,
      "output-closed": EXIT.internal,
      "uncaught-error": EXIT.internal,
    });
    assert.equal(stopDescription("SIGHUP"), "interrupted by SIGHUP");
    assert.equal(stopDescription("output-closed"), "standard output or error closed");
  });

  it("installs the process guards only when asked (main.ts asks), and a trap only while it is held", () => {
    const before = {
      uncaught: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
      stdout: process.stdout.listenerCount("error"),
      hup: process.listenerCount("SIGHUP"),
      quit: process.listenerCount("SIGQUIT"),
    };
    const runtime = processRuntime(tempDir());
    assert.equal(process.listenerCount("uncaughtException"), before.uncaught);
    assert.equal(process.listenerCount("unhandledRejection"), before.rejection);
    assert.equal(process.stdout.listenerCount("error"), before.stdout);
    const untrap = runtime.trap({ stop: async () => {}, closeNow: () => {} });
    assert.equal(process.listenerCount("SIGHUP"), before.hup + 1);
    assert.equal(process.listenerCount("SIGQUIT"), before.quit + 1);
    untrap();
    assert.equal(process.listenerCount("SIGHUP"), before.hup);
    assert.equal(process.listenerCount("SIGQUIT"), before.quit);
  });

  it("reports the commit and whether the checkout has local changes", () => {
    const dir = tempDir();
    execFileSync("git", ["init", "-q", dir]);
    const runtime = processRuntime(dir);
    assert.equal(runtime.commit(), undefined, "no commit yet");
    assert.equal(runtime.dirty(), false);
    writeFileSync(join(dir, "file.txt"), "x");
    assert.equal(runtime.dirty(), true);
    assert.equal(processRuntime(tempDir()).dirty(), undefined, "not a checkout");
  });
});

const MARKER = "marker-text-that-is-never-printed";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The events, results and stop fields of the child's run log, and that the lock is free. */
function closedRun(child: Child) {
  const log = child.log();
  const records = log.records();
  return {
    events: records.map((r) => r.event),
    done: records.at(-1),
    lockFree: log.holder() === undefined,
    problems: log.verify().problems,
  };
}

const IN_FLIGHT = { kind: "dns", name: "console", action: "create" };

/**
 * Resolves once the child has taken the first stop for `signal` (it says so on standard error
 * after it noted when the stop came), so a second signal sent after this is a repeat of it.
 */
function stopTaken(child: Child, signal: string): Promise<void> {
  return child.waitFor(`interrupted by ${signal}: closing the run`, "stderr");
}

/** A run log of `count` chained records with its head file, written at once. */
function writeLog(dir: string, count: number): void {
  const lines: string[] = [];
  let prev = GENESIS;
  for (let seq = 1; seq <= count; seq++) {
    const line = JSON.stringify({
      seq,
      prev,
      at: "2026-11-21T06:00:00.000Z",
      runId: "run_earlier",
      event: "run.step",
      kind: "dns",
      name: "console",
      action: "create",
    });
    lines.push(line);
    prev = sha256(line);
  }
  writeFileSync(join(dir, "runs.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "head.json"), `${JSON.stringify({ seq: count, hash: prev })}\n`, {
    mode: 0o600,
  });
}

describe("the stop rules, in a real process", { concurrency: true }, () => {
  for (const [signal, exit] of [
    ["SIGHUP", EXIT.hangup],
    ["SIGINT", EXIT.interrupted],
  ] as const) {
    it(`treats ${signal} sent twice at once as one stop (a closing terminal sends SIGHUP twice): the change in flight recorded, run.done written, the lock released`, async () => {
      const child = spawnChild(["stub", "wait", "staging"]);
      try {
        await child.waitFor("waiting");
        child.process.kill(signal);
        await sleep(50);
        child.process.kill(signal);
        assert.equal(await child.exit(), exit, child.errors());
        const run = closedRun(child);
        assert.deepEqual(run.events, ["run.registered", "run.step", "run.done"]);
        assert.equal(run.done?.interrupted, signal);
        assert.equal(run.done?.inFlight, undefined);
        assert.equal(run.done?.forced, undefined);
        assert.equal(run.lockFree, true);
        assert.deepEqual(run.problems, []);
      } finally {
        child.process.kill("SIGKILL");
      }
    });
  }

  it("closes the run at once on a second Ctrl-C that comes later: run.done names the change in flight, the lock is released", async () => {
    const child = spawnChild(["stub", "hang", "staging"]);
    try {
      await child.waitFor("waiting");
      child.process.kill("SIGINT");
      // The second comes the grace after the child took the first, which no load can make early;
      // it has until the stop's wait for the change ends (INTERRUPT_SETTLE_MS) to arrive.
      await stopTaken(child, "SIGINT");
      await sleep(REPEAT_GRACE_MS + 100);
      child.process.kill("SIGINT");
      assert.equal(await child.exit(), EXIT.interrupted, child.errors());
      // No time is measured: the change takes ten seconds, so waiting for it would close the run
      // after the wait for it, with no forced close, or at the deadline as "deadline"; run.done
      // says which close it was.
      const run = closedRun(child);
      assert.deepEqual(run.events, ["run.registered", "run.done"]);
      assert.equal(run.done?.result, "failed");
      assert.equal(run.done?.interrupted, "SIGINT");
      assert.equal(run.done?.forced, "SIGINT");
      assert.deepEqual(run.done?.inFlight, IN_FLIGHT);
      assert.equal(run.lockFree, true);
      assert.deepEqual(run.problems, []);
      assert.match(child.errors(), /interrupted by SIGINT: closing the run at once/);
    } finally {
      child.process.kill("SIGKILL");
    }
  });

  it("never lets a repeated hangup cut the clean-up short", async () => {
    const child = spawnChild(["stub", "hang", "staging"]);
    try {
      await child.waitFor("waiting");
      child.process.kill("SIGHUP");
      await stopTaken(child, "SIGHUP");
      await sleep(REPEAT_GRACE_MS + 100);
      child.process.kill("SIGHUP");
      assert.equal(await child.exit(), EXIT.hangup, child.errors());
      const run = closedRun(child);
      assert.deepEqual(run.events, ["run.registered", "run.done"]);
      assert.equal(run.done?.interrupted, "SIGHUP");
      assert.equal(run.done?.forced, undefined, "closed by the stop, after the settle wait");
      assert.deepEqual(run.done?.inFlight, IN_FLIGHT);
      assert.equal(run.lockFree, true);
    } finally {
      child.process.kill("SIGKILL");
    }
  });

  it("closes the run at once on SIGQUIT (exit 131): run.done names the change in flight, the lock is released", async () => {
    const child = spawnChild(["stub", "hang", "staging"]);
    try {
      await child.waitFor("waiting");
      child.process.kill("SIGQUIT");
      assert.equal(await child.exit(), EXIT.quit, child.errors());
      // No time is measured: waiting for the ten-second change would close the run after the
      // wait for it, with no forced close, or at the deadline as "deadline"; run.done says which.
      const run = closedRun(child);
      assert.deepEqual(run.events, ["run.registered", "run.done"]);
      assert.equal(run.done?.interrupted, "SIGQUIT");
      assert.equal(run.done?.forced, "SIGQUIT");
      assert.deepEqual(run.done?.inFlight, IN_FLIGHT);
      assert.equal(run.lockFree, true);
      assert.deepEqual(run.problems, []);
    } finally {
      child.process.kill("SIGKILL");
    }
  });

  for (const kind of ["throw", "reject"] as const) {
    it(`closes the run (exit 70) on ${kind === "throw" ? "an uncaught exception" : "an unhandled rejection"} without waiting for the change in flight, and never prints its text`, async () => {
      const child = spawnChild(["stub", kind, "staging"], { env: { FIN_TEST_MARKER: MARKER } });
      try {
        assert.equal(await child.exit(), EXIT.internal, child.errors());
        const run = closedRun(child);
        assert.deepEqual(run.events, ["run.registered", "run.done"], "no step: it did not wait");
        assert.equal(run.done?.result, "failed");
        assert.equal(run.done?.interrupted, "uncaught-error");
        assert.deepEqual(run.done?.inFlight, IN_FLIGHT);
        assert.equal(run.lockFree, true);
        assert.deepEqual(run.problems, []);
        assert.match(child.errors(), /an uncaught error: closing the run/);
        assert.equal(`${child.out()}${child.errors()}`.includes(MARKER), false);
      } finally {
        child.process.kill("SIGKILL");
      }
    });
  }

  it("prints the fixed message and exits 70 on an uncaught error outside a run", async () => {
    const child = spawnChild(["probe", "throw", "staging"], { env: { FIN_TEST_MARKER: MARKER } });
    try {
      assert.equal(await child.exit(), EXIT.internal, child.errors());
      assert.match(
        child.errors(),
        /^error: internal error \(an uncaught error; its text is not printed/m,
      );
      assert.equal(`${child.out()}${child.errors()}`.includes(MARKER), false);
      assert.equal(existsSync(join(child.logDir, "lock.json")), false);
    } finally {
      child.process.kill("SIGKILL");
    }
  });

  it("closes the run (exit 70) when its standard error closes, as a closed output and not as an uncaught error", async () => {
    const child = spawnChild(["stub", "warn", "staging"]);
    try {
      await child.waitFor("sending c1", "stderr");
      child.process.stderr.destroy();
      assert.equal(await child.exit(), EXIT.internal);
      const sent = child.sent();
      const run = closedRun(child);
      assert.deepEqual(run.events, ["run.registered", ...sent.map(() => "run.step"), "run.done"]);
      assert.equal(run.done?.interrupted, "output-closed");
      assert.equal(run.done?.steps, sent.length);
      assert.ok(sent.length < 5, "it stopped before the end of the plan");
      assert.equal(run.lockFree, true);
      assert.deepEqual(run.problems, []);
    } finally {
      child.process.kill("SIGKILL");
    }
  });

  it("exits at the deadline when the clean-up hangs, with run.done written and the lock released", async () => {
    const dir = tempDir();
    const child = spawnChild(["stub", "wait", "staging"], {
      env: {
        FIN_TEST_HANG_SHIPPING: "1",
        FIN_OPS_INGEST_HOST: "ingest.example.com",
        FIN_OPS_INGEST_TOKEN_FILE: writePrivate(dir, "ingest", `tok${"x".repeat(24)}`),
      },
    });
    // The bounds hold the 5-second deadline, from the signal. The watchdog starts with the signal
    // too: started with the spawn, it killed a child that a loaded machine took over 4 s to start
    // before the child's own deadline came.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await child.waitFor("waiting");
      const sent = performance.now();
      child.process.kill("SIGTERM");
      watchdog = setTimeout(() => child.process.kill("SIGKILL"), 9_000);
      assert.equal(await child.exit(), EXIT.terminated, child.errors());
      const took = performance.now() - sent;
      assert.ok(took > 4_000 && took < 7_000, `exited after ${Math.round(took)} ms`);
      const run = closedRun(child);
      assert.deepEqual(run.events, ["run.registered", "run.step", "run.done"]);
      assert.equal(run.done?.interrupted, "SIGTERM");
      assert.equal(run.lockFree, true);
      assert.match(child.errors(), /the clean-up did not finish in time/);
    } finally {
      clearTimeout(watchdog);
      child.process.kill("SIGKILL");
    }
  });

  it("closes the run on a signal that comes the moment the lock is taken, even while a long log is checked", async () => {
    const child = spawnChild(["stub", "wait", "staging"], {
      before: (dir) => writeLog(dir, 30_000),
    });
    try {
      const lock = join(child.logDir, "lock.json");
      while (!existsSync(lock)) {
        if (child.process.exitCode !== null || child.process.signalCode !== null) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      child.process.kill("SIGINT");
      const ended = await child.ended();
      assert.deepEqual(ended, { code: EXIT.interrupted, signal: null }, child.errors());
      const run = closedRun(child);
      assert.equal(run.lockFree, true);
      assert.deepEqual(run.problems, []);
      const added = run.events.slice(30_000);
      if (added.length > 0) assert.equal(added.at(-1), "run.done");
    } finally {
      child.process.kill("SIGKILL");
    }
  });
});
