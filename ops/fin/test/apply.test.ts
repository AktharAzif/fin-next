// Context.applyPlan and the CLI's registered-run paths, driven through runCli with stub mutating
// commands: dry runs, held and refused plans, deletions, failures, refusals, the run lock (taken
// before the command reads anything), shipping, interrupts and GitHub Actions output.

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.ts";
import type { Command } from "../src/command.ts";
import type { Context } from "../src/core/context.ts";
import { EXIT, ProviderError, RefusedError } from "../src/core/errors.ts";
import { Masker } from "../src/core/mask.ts";
import type { Change } from "../src/core/plan.ts";
import { RunLog } from "../src/core/runlog.ts";
import {
  commandEnv,
  type FakeRuntime,
  type FakeRuntimeOptions,
  fakeRuntime,
  fakeToken,
  hex,
  overlayFixture,
  privateValues,
  tempDir,
  writeOverlay,
  writePrivate,
  ZONE,
} from "./helpers/fixtures.ts";
import { jobLog } from "./helpers/runner.ts";

/** Waits until the condition holds, letting other work run between checks (a few hundred turns at most). */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), "the condition never held");
}

/** A promise and the function that settles it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

interface StubOptions {
  changes: Change[];
  /** Runs inside each change, after the write check. */
  apply?: (change: Change, ctx: Context) => Promise<void>;
  /** Runs where a command reads provider state, before it builds its plan. */
  read?: (ctx: Context) => Promise<void>;
  /** Applies the plan a second time after the first. */
  twice?: boolean;
  /** A writer that forgets assertWritable(), so only the core's own checks stand in the way. */
  unchecked?: boolean;
  words?: string[];
}

interface Stub {
  command: Command;
  reads: number;
  applied: string[];
}

function stub(options: StubOptions): Stub {
  const s: Stub = {
    reads: 0,
    applied: [],
    command: {
      words: options.words ?? ["stub", "apply"],
      summary: "a stub mutating command",
      positionals: [],
      flags: [],
      overlay: true,
      mutating: true,
      runbook: "pnpm-fin.md",
      async run(ctx) {
        s.reads++;
        await options.read?.(ctx);
        const apply = async (change: Change) => {
          if (options.unchecked !== true) ctx.run.assertWritable(`write ${change.kind}`);
          await options.apply?.(change, ctx);
          s.applied.push(change.name);
        };
        const code = await ctx.applyPlan("stub plan", options.changes, apply);
        if (options.twice === true) return ctx.applyPlan("stub plan again", options.changes, apply);
        return code;
      },
    },
  };
  return s;
}

interface Harness {
  runtime: FakeRuntime;
  env: Record<string, string>;
  dir: string;
  log: RunLog;
  run(s: Stub, flags?: string[]): Promise<number>;
  events(): string[];
  lines(): Array<Record<string, unknown>>;
}

function harness(options: FakeRuntimeOptions = {}, extraEnv: Record<string, string> = {}): Harness {
  const { env, dir } = commandEnv(extraEnv);
  const runtime = fakeRuntime({ ...options, env: { ...env, ...options.env } });
  const stateDir = join(env.FIN_STATE_DIR ?? "", "staging");
  const log = new RunLog(stateDir, new Masker());
  const linesFile = join(stateDir, "lines.jsonl");
  return {
    runtime,
    env,
    dir,
    log,
    run: (s, flags = []) => runCli([...s.command.words, "staging", ...flags], runtime, [s.command]),
    events: () => log.records().map((r) => r.event),
    lines: () =>
      existsSync(linesFile)
        ? readFileSync(linesFile, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
  };
}

const CREATE: Change = { kind: "dns", name: `console.${ZONE}`, action: "create" };
const UPDATE: Change = { kind: "setting", name: "0rtt", action: "update", fields: ["value"] };
const DELETE: Change = { kind: "rule", name: "fin_next_old", action: "delete" };
const KEEP: Change = { kind: "dns", name: `staff.${ZONE}`, action: "keep" };
const HELD: Change = { kind: "setting", name: "polish", action: "update", held: "shared zone" };

function readable(h: Harness): string {
  const read = (name: string) =>
    existsSync(join(h.log.dir, name)) ? readFileSync(join(h.log.dir, name), "utf8") : "";
  return [h.runtime.out(), h.runtime.err(), read("runs.jsonl"), read("lines.jsonl")].join("\n");
}

function assertNoLeak(h: Harness, extra: readonly string[] = []): void {
  const text = readable(h).toLowerCase();
  for (const value of [...privateValues(), ...extra]) {
    assert.equal(text.includes(value.toLowerCase()), false, `leaked ${value.slice(0, 4)}...`);
  }
}

describe("a dry run", () => {
  it("prints the plan, sends nothing, takes no lock and writes nothing (exit 1 with changes)", async () => {
    const h = harness();
    const s = stub({ changes: [CREATE, KEEP] });
    assert.equal(await h.run(s, ["--dry-run"]), 1);
    assert.deepEqual(s.applied, []);
    assert.deepEqual(h.events(), []);
    assert.deepEqual(h.lines(), []);
    assert.equal(h.log.holder(), undefined);
    assert.match(h.runtime.out(), /\+ create dns <host:console>/);
    assert.match(h.runtime.out(), /dry run: nothing was sent/);
    assertNoLeak(h);
  });

  it("exits 0 when nothing differs, and 1 when only held changes remain", async () => {
    const h = harness();
    assert.equal(await h.run(stub({ changes: [KEEP] }), ["--dry-run"]), 0);
    assert.equal(await h.run(stub({ changes: [KEEP, HELD] }), ["--dry-run"]), 1);
    assert.deepEqual(h.events(), []);
  });
});

describe("a mutating run", () => {
  it("registers, records one step per change, closes with run.done ok and frees the lock", async () => {
    const h = harness();
    const s = stub({ changes: [CREATE, UPDATE, KEEP] });
    assert.equal(await h.run(s), EXIT.ok);
    assert.deepEqual(s.applied, [`console.${ZONE}`, "0rtt"]);
    assert.deepEqual(h.events(), ["run.registered", "run.step", "run.step", "run.done"]);
    const [registered, , , done] = h.log.records();
    assert.equal(registered?.command, "stub apply");
    assert.deepEqual(registered?.plan, { create: 1, update: 1, delete: 0, keep: 1, held: 0 });
    assert.equal(registered?.commit, "e".repeat(40));
    assert.equal(registered?.dirty, false);
    assert.equal(done?.result, "ok");
    assert.equal(done?.steps, 2);
    assert.equal(h.log.holder(), undefined);
    const lines = h.lines();
    assert.deepEqual(
      lines.map((l) => l.event),
      ["run.registered", "run.done"],
    );
    assert.deepEqual(
      h.log.verify({ seq: Number(lines[1]?.logSeq), hash: String(lines[1]?.logHead) }).problems,
      [],
    );
    assert.match(h.runtime.out(), /done: create dns <host:console>/);
    assertNoLeak(h);
  });

  it("changes nothing and leaves no record when nothing differs, or only held changes remain", async () => {
    const h = harness();
    assert.equal(await h.run(stub({ changes: [KEEP] })), 0);
    assert.equal(await h.run(stub({ changes: [KEEP, HELD] })), 1);
    assert.deepEqual(h.events(), []);
    assert.equal(h.log.holder(), undefined);
  });

  it("refuses deletions without the exact --confirm-delete (exit 77, nothing sent, no record)", async () => {
    const h = harness();
    const s = stub({ changes: [CREATE, DELETE] });
    assert.equal(await h.run(s), EXIT.refused);
    assert.equal(await h.run(s, ["--confirm-delete", "2"]), EXIT.refused);
    assert.deepEqual(s.applied, []);
    assert.deepEqual(h.events(), []);
    assert.equal(h.log.holder(), undefined);
    assert.match(h.runtime.err(), /--confirm-delete 1/);
    assert.equal(await h.run(s, ["--confirm-delete", "1"]), EXIT.ok);
    assert.deepEqual(s.applied, [`console.${ZONE}`, "fin_next_old"]);
    const registered = h.log.records()[0] as { args?: { flags?: Record<string, unknown> } };
    assert.deepEqual(registered.args?.flags, { "confirm-delete": 1 });
    assert.deepEqual(h.lines()[0]?.flags, { "confirm-delete": 1 });
  });

  it("records the safety overrides a run was given", async () => {
    const h = harness();
    assert.equal(await h.run(stub({ changes: [CREATE] }), ["--spike", "--fallback"]), 0);
    const registered = h.log.records()[0] as { args?: { flags?: Record<string, unknown> } };
    assert.deepEqual(registered.args?.flags, { spike: true, fallback: true });
    assert.deepEqual(h.lines()[0]?.flags, { spike: true, fallback: true });
  });

  it("closes a failed apply as failed with its error, prints the error and frees the lock", async () => {
    const h = harness();
    const s = stub({
      changes: [CREATE, UPDATE],
      apply: async (change) => {
        if (change.kind === "setting") {
          throw new ProviderError("cloudflare", `cloudflare PATCH answered 500 for ${ZONE}`, 500);
        }
      },
    });
    assert.equal(await h.run(s), EXIT.unavailable);
    assert.deepEqual(h.events(), ["run.registered", "run.step", "run.done"]);
    const done = h.log.records().at(-1);
    assert.equal(done?.result, "failed");
    assert.equal(done?.error, "cloudflare PATCH answered 500 for <zone>");
    assert.equal(h.log.holder(), undefined);
    assert.match(h.runtime.err(), /error: cloudflare PATCH answered 500 for <zone>/);
    assert.equal(h.lines().at(-1)?.result, "failed");
    assertNoLeak(h);
  });

  it("closes a run that a safety rule stopped mid-plan as refused (exit 77)", async () => {
    const h = harness();
    const s = stub({
      changes: [CREATE, UPDATE],
      apply: async (change) => {
        if (change.kind === "setting") throw new RefusedError("a never-touch name was refused");
      },
    });
    assert.equal(await h.run(s), EXIT.refused);
    const done = h.log.records().at(-1);
    assert.equal(done?.event, "run.done");
    assert.equal(done?.result, "refused");
    assert.equal(h.lines().at(-1)?.result, "refused");
  });

  it("takes the run lock before it reads anything: a held lock stops the command at once (exit 75)", async () => {
    const h = harness();
    h.log.lock({ runId: "run_other", command: "zone apply", startedAt: "t" });
    const s = stub({ changes: [CREATE] });
    assert.equal(await h.run(s), EXIT.busy);
    assert.equal(s.reads, 0);
    assert.deepEqual(s.applied, []);
    assert.deepEqual(h.events(), []);
    assert.equal(h.log.holder()?.runId, "run_other");
    assert.match(h.runtime.err(), /held by run_other/);
  });

  it("keeps a second run out while the first reads, so no plan goes stale", async () => {
    const h = harness();
    let resume: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reading: () => void = () => {};
    const isReading = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const a = stub({
      changes: [CREATE],
      read: async () => {
        reading();
        await paused;
      },
    });
    const first = h.run(a);
    await isReading;
    const b = stub({ changes: [UPDATE] });
    assert.equal(await h.run(b), EXIT.busy);
    assert.equal(b.reads, 0);
    resume();
    assert.equal(await first, EXIT.ok);
    assert.deepEqual(a.applied, [`console.${ZONE}`]);
    assert.deepEqual(b.applied, []);
  });

  it("stops sending once another run took the lock, and leaves that run's lock alone", async () => {
    const h = harness();
    const s = stub({
      changes: [CREATE, UPDATE],
      unchecked: true,
      apply: async (change, ctx) => {
        if (change.kind !== "dns") return;
        ctx.log.breakLock(new Date(), "run_breaker", "the run was thought gone", "operator");
        ctx.log.lock({ runId: "run_b", command: "routes apply", startedAt: "t" });
      },
    });
    assert.equal(await h.run(s), EXIT.busy);
    assert.deepEqual(s.applied, [`console.${ZONE}`]);
    assert.equal(h.log.holder()?.runId, "run_b");
    const done = h.log.records().at(-1);
    assert.equal(done?.event, "run.done");
    assert.equal(done?.result, "failed");
    assert.equal(done?.lockLost, true);
    // The core checks before the change starts, whatever the change's own writer checks.
    assert.match(h.runtime.err(), /update setting: this run no longer holds the run lock/);
  });

  it("applies one plan per run: a second plan after run.done is refused before it sends", async () => {
    const h = harness();
    const s = stub({ changes: [CREATE], twice: true });
    assert.equal(await h.run(s), EXIT.internal);
    assert.deepEqual(s.applied, [`console.${ZONE}`]);
    assert.deepEqual(h.events(), ["run.registered", "run.step", "run.done"]);
    assert.match(h.runtime.err(), /registers once/);
    assert.equal(h.log.holder(), undefined);
  });

  it("records a checkout with local changes as dirty", async () => {
    const h = harness({ dirty: true });
    assert.equal(await h.run(stub({ changes: [CREATE] })), 0);
    assert.equal(h.log.records()[0]?.dirty, true);
    assert.equal(h.lines()[0]?.dirty, true);
  });

  it("keeps its own numbers when they equal a private one: the plan, the refusal, the flags and the lines", async () => {
    const overlay = { ...overlayFixture(), thresholds: { "api-v4": 12, "errors-5xx": 15 } };
    const dir = tempDir();
    const h = harness(
      { env: { GITHUB_ACTIONS: "true" } },
      { FIN_OVERLAY_FILE: writeOverlay(dir, overlay) },
    );
    const deletions: Change[] = Array.from({ length: 12 }, (_, i) => ({
      kind: "rule",
      name: `fin_next_old_${i}`,
      action: "delete",
    }));
    const s = stub({ changes: deletions });
    assert.equal(await h.run(s), EXIT.refused);
    assert.match(
      h.runtime.err(),
      /the plan deletes 12 object\(s\); re-run with --confirm-delete 12 to allow it/,
    );
    assert.equal(await h.run(s, ["--confirm-delete", "12"]), EXIT.ok);
    assert.match(h.runtime.out(), /^ {2}0 to create, 0 to update, 12 to delete, 0 unchanged$/m);
    const [registered] = h.log.records();
    assert.deepEqual((registered?.args as { flags?: unknown } | undefined)?.flags, {
      "confirm-delete": 12,
    });
    assert.deepEqual(registered?.plan, { create: 0, update: 0, delete: 12, keep: 0, held: 0 });
    // A second run: its run.registered line's logSeq passes 15 (the other private number).
    assert.equal(await h.run(stub({ changes: [CREATE, UPDATE] })), EXIT.ok);
    const lines = h.lines();
    assert.deepEqual(
      lines.map((l) => [l.event, l.logSeq, l.steps]),
      [
        ["run.registered", 1, undefined],
        ["run.done", 14, 12],
        ["run.registered", 15, undefined],
        ["run.done", 18, 2],
      ],
    );
    assert.deepEqual(h.lines()[0]?.flags, { "confirm-delete": 12 });
    for (const line of lines) {
      assert.deepEqual(
        h.log.verify({ seq: Number(line.logSeq), hash: String(line.logHead) }).problems,
        [],
      );
    }
    assert.doesNotMatch(readable(h), /<overlay:thresholds/);
    assert.doesNotMatch(h.runtime.err(), /::add-mask::1[25]$/m);
  });

  it("does not start on a run log that does not verify (exit 1), before it reads anything", async () => {
    const h = harness();
    assert.equal(await h.run(stub({ changes: [CREATE, UPDATE] })), EXIT.ok);
    const lines = readFileSync(h.log.logPath, "utf8").split("\n");
    writeFileSync(h.log.logPath, `${lines[0]}\n`);
    const s = stub({ changes: [CREATE] });
    assert.equal(await h.run(s), EXIT.drift);
    assert.equal(s.reads, 0);
    assert.deepEqual(s.applied, []);
    assert.equal(h.log.holder(), undefined);
    assert.match(
      h.runtime.err(),
      /the run log does not verify \(the head file names record 4, but the log holds 1/,
    );
    assert.equal(h.log.records().length, 1, "the gap is still there for log verify to report");
    // A dry run still reads and prints its plan: it writes nothing.
    assert.equal(await h.run(s, ["--dry-run"]), 1);
    assert.equal(s.reads, 1);
  });
});

describe("shipping the lines", () => {
  it("ships run.registered before the first change and the rest at the end, masked", async () => {
    const order: string[] = [];
    const bodies: string[] = [];
    const token = fakeToken("ingest");
    const fetch = async (url: string, init: RequestInit) => {
      order.push(`ship ${url}`);
      bodies.push(String(init.body));
      assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${token}`);
      return new Response("", { status: 202 });
    };
    const dir = tempDir();
    const h = harness(
      { fetch },
      {
        FIN_OPS_INGEST_HOST: "ingest.example.com",
        FIN_OPS_INGEST_TOKEN_FILE: writePrivate(dir, "ingest", token),
      },
    );
    const s = stub({
      changes: [CREATE],
      apply: async () => {
        order.push("apply");
      },
    });
    assert.equal(await h.run(s), 0);
    assert.deepEqual(order, [
      "ship https://ingest.example.com/",
      "apply",
      "ship https://ingest.example.com/",
    ]);
    assert.deepEqual(
      bodies.flatMap((b) => (JSON.parse(b) as Array<{ event: string }>).map((l) => l.event)),
      ["run.registered", "run.done"],
    );
    for (const body of bodies) {
      for (const value of [...privateValues(), token]) {
        assert.equal(body.toLowerCase().includes(value.toLowerCase()), false, value.slice(0, 4));
      }
    }
    assertNoLeak(h, [token]);
  });

  it("never changes the exit code when the ingest token file is unusable", async () => {
    const dir = tempDir();
    const open = join(dir, "open-token");
    writeFileSync(open, fakeToken("open"), { mode: 0o644 });
    let shipped = 0;
    const h = harness(
      {
        fetch: async () => {
          shipped++;
          return new Response("", { status: 202 });
        },
      },
      { FIN_OPS_INGEST_HOST: "ingest.example.com", FIN_OPS_INGEST_TOKEN_FILE: open },
    );
    assert.equal(await h.run(stub({ changes: [CREATE] })), EXIT.ok);
    const refused = stub({
      changes: [CREATE],
      apply: async () => {
        throw new RefusedError("refused by a safety rule");
      },
    });
    assert.equal(await h.run(refused), EXIT.refused);
    assert.equal(shipped, 0);
    assert.match(h.runtime.err(), /others can read.*the lines stay local/);
    assert.equal(h.lines().length, 4);
  });
});

describe("an interrupted run", () => {
  it("lets the change in flight settle and records it, then starts no later change, while the ingest is still shipping", async () => {
    const ingest = gate();
    const bodies: string[] = [];
    const fetch = async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      // The first POST (run.registered) answers; the next one is slow, as a stalled ingest is.
      if (bodies.length > 1) await ingest.wait;
      return new Response("", { status: 202 });
    };
    const h = harness(
      // The settle wait never times out here: the run closes when the change settles.
      { fetch, sleep: () => new Promise<void>(() => {}) },
      {
        FIN_OPS_INGEST_HOST: "ingest.example.com",
        FIN_OPS_INGEST_TOKEN_FILE: writePrivate(tempDir(), "ingest", fakeToken("ingest")),
      },
    );
    const inside = gate();
    const change = gate();
    const DOCS: Change = { kind: "dns", name: `docs.${ZONE}`, action: "create" };
    const s = stub({
      changes: [CREATE, UPDATE, DOCS],
      apply: async (c) => {
        if (c === CREATE) {
          inside.open();
          await change.wait;
        }
      },
    });
    const pending = h.run(s);
    await inside.wait;
    const stopping = h.runtime.interrupt("SIGINT");
    await until(() => h.runtime.err().includes("closing the run"));
    assert.deepEqual(h.events(), ["run.registered"], "the run waits for the change in flight");
    assert.ok(h.log.holder() !== undefined, "and keeps the lock meanwhile");
    change.open();
    await until(() => h.events().includes("run.done"));
    assert.deepEqual(h.events(), ["run.registered", "run.step", "run.done"]);
    const done = h.log.records().at(-1);
    assert.equal(done?.result, "failed");
    assert.equal(done?.steps, 1);
    assert.equal(done?.interrupted, "SIGINT");
    assert.equal(done?.inFlight, undefined, "the change settled and is a step");
    assert.equal(h.log.holder(), undefined);
    assert.deepEqual(s.applied, [`console.${ZONE}`], "no later change was sent");
    ingest.open();
    assert.equal(await stopping, true);
    assert.equal(await pending, EXIT.interrupted);
    assert.deepEqual(s.applied, [`console.${ZONE}`]);
    assert.deepEqual(h.events(), ["run.registered", "run.step", "run.done"]);
    const shipped = bodies.flatMap((b) => JSON.parse(b) as Array<Record<string, unknown>>);
    assert.deepEqual(
      shipped.map((l) => [l.event, l.interrupted]),
      [
        ["run.registered", undefined],
        ["run.done", "SIGINT"],
      ],
    );
  });

  it("closes the run without a change that does not settle in time, naming it in run.done, and sends nothing after", async () => {
    const h = harness();
    const inside = gate();
    const change = gate();
    const s = stub({
      changes: [CREATE, UPDATE],
      // Even a writer that never checks is not called for a change after run.done.
      unchecked: true,
      apply: async (c) => {
        if (c === CREATE) {
          inside.open();
          await change.wait;
        }
      },
    });
    const pending = h.run(s);
    await inside.wait;
    // The fake runtime's sleep returns at once: the settle wait times out.
    assert.equal(await h.runtime.interrupt("SIGINT"), true);
    assert.deepEqual(h.events(), ["run.registered", "run.done"]);
    const done = h.log.records().at(-1);
    assert.equal(done?.result, "failed");
    assert.equal(done?.error, "interrupted by SIGINT");
    assert.equal(done?.interrupted, "SIGINT");
    assert.equal(done?.steps, 0);
    assert.deepEqual(done?.inFlight, { kind: "dns", name: "<host:console>", action: "create" });
    assert.equal(h.log.holder(), undefined);
    assert.deepEqual(
      h.lines().map((l) => l.event),
      ["run.registered", "run.done"],
    );
    assert.match(h.runtime.err(), /interrupted by SIGINT: closing the run/);
    change.open();
    assert.equal(await pending, EXIT.interrupted);
    assert.deepEqual(s.applied, [`console.${ZONE}`], "the later change never started");
    assert.deepEqual(h.events(), ["run.registered", "run.done"], "nothing is written after it");
    assert.equal(await h.runtime.interrupt("SIGINT"), false, "the trap is gone with the run");
  });

  it("frees the lock of a run interrupted while it reads, with no record", async () => {
    const h = harness();
    let reading: () => void = () => {};
    const isReading = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const s = stub({
      changes: [CREATE],
      read: async () => {
        reading();
        await new Promise(() => {});
      },
    });
    void h.run(s);
    await isReading;
    assert.ok(h.log.holder() !== undefined);
    assert.equal(await h.runtime.interrupt("SIGTERM"), true);
    assert.equal(h.log.holder(), undefined);
    assert.deepEqual(h.events(), []);
  });

  for (const [signal, exit] of [
    ["SIGINT", EXIT.interrupted],
    ["SIGTERM", EXIT.terminated],
    ["SIGHUP", EXIT.hangup],
  ] as const) {
    it(`exits ${exit} on ${signal} in a real process: the change in flight recorded, run.done written, the lock released`, async () => {
      const child = spawnChild(["stub", "wait", "staging"]);
      try {
        await child.waitFor("waiting");
        child.process.kill(signal);
        assert.equal(await child.exit(), exit, child.errors());
        const log = child.log();
        assert.deepEqual(
          log.records().map((r) => [r.event, r.result, r.interrupted]),
          [
            ["run.registered", undefined, undefined],
            ["run.step", undefined, undefined],
            ["run.done", "failed", signal],
          ],
        );
        assert.equal(log.holder(), undefined);
        assert.deepEqual(log.verify().problems, []);
      } finally {
        child.process.kill("SIGKILL");
      }
    });
  }

  it("closes the run (exit 70) when its standard output closes, sending nothing after the change in flight", async () => {
    const child = spawnChild(["stub", "steps", "staging"]);
    try {
      await child.waitFor("done: create dns c1");
      // The reader goes away, as `| head` does.
      child.process.stdout.destroy();
      assert.equal(await child.exit(), EXIT.internal, child.errors());
      assert.doesNotMatch(child.errors(), /Unhandled 'error' event|EPIPE/);
      assert.match(child.errors(), /standard output or error closed: closing the run/);
      const sent = child.sent();
      assert.ok(sent.length >= 2 && sent.length <= 3, sent.join(","));
      const log = child.log();
      const records = log.records();
      assert.deepEqual(
        records.map((r) => r.event),
        ["run.registered", ...sent.map(() => "run.step"), "run.done"],
        "every change that went out is recorded",
      );
      const done = records.at(-1);
      assert.equal(done?.result, "failed");
      assert.equal(done?.interrupted, "output-closed");
      assert.equal(done?.steps, sent.length);
      assert.equal(log.holder(), undefined);
      assert.deepEqual(log.verify().problems, []);
    } finally {
      child.process.kill("SIGKILL");
    }
  });
});

interface Child {
  process: ChildProcessWithoutNullStreams;
  /** Resolves once standard output has shown the text; rejects if the child exits first. */
  waitFor(text: string): Promise<void>;
  exit(): Promise<number | null>;
  errors(): string;
  /** The changes the child sent (the `stub steps` command's counter file). */
  sent(): string[];
  log(): RunLog;
}

/** Runs ops/fin's main() with the stub commands of helpers/interrupt-child.ts in a real process. */
function spawnChild(argv: readonly string[]): Child {
  const dir = tempDir();
  const stateDir = join(dir, "state");
  const counter = join(dir, "sent.txt");
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./helpers/interrupt-child.ts", import.meta.url)), ...argv],
    {
      env: {
        PATH: process.env.PATH ?? "",
        FIN_STATE_DIR: stateDir,
        FIN_TEST_COUNTER_FILE: counter,
      },
    },
  );
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const exited = once(child, "exit").then(([code]) => code as number | null);
  return {
    process: child,
    waitFor: (text) =>
      new Promise<void>((resolve, reject) => {
        let seen = "";
        child.stdout.on("data", (chunk: Buffer) => {
          seen += chunk.toString();
          if (seen.includes(text)) resolve();
        });
        void exited.then((code) =>
          reject(new Error(`the child exited early (${code}): ${errors}`)),
        );
      }),
    exit: () => exited,
    errors: () => errors,
    sent: () =>
      existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").filter(Boolean) : [],
    log: () => new RunLog(join(stateDir, "staging"), new Masker()),
  };
}

describe("in GitHub Actions", () => {
  it("keeps standard output masked and free of add-mask commands; the commands go to standard error", async () => {
    const h = harness({ env: { GITHUB_ACTIONS: "true" } });
    assert.equal(await h.run(stub({ changes: [CREATE] })), 0);
    const out = h.runtime.out();
    assert.equal(out.includes("::add-mask::"), false);
    for (const value of privateValues()) assert.equal(out.includes(value), false, value);
    const telemetry = out.split("\n").filter((l) => l.startsWith("{"));
    assert.deepEqual(
      telemetry.map((l) => (JSON.parse(l) as { event: string }).event),
      ["run.registered", "run.done"],
    );
    assert.match(h.runtime.err(), /^::add-mask::/m);
  });

  it("never lets a printed name turn the runner's command processing off, so later add-masks still mask", async () => {
    const token = fakeToken("operator");
    const runtimeId = hex(32, "9");
    const h = harness(
      { env: { GITHUB_ACTIONS: "true" } },
      { FIN_CF_TOKEN_FILE: writePrivate(tempDir(), "cf-token", token) },
    );
    // Names a provider (or a crafted lock file or argument) could put in front of the output.
    const changes: Change[] = [
      { kind: "dns", name: "x\n::stop-commands::zz", action: "create" },
      {
        kind: "dns",
        name: "y\r\n##[stop-commands]yy",
        action: "create",
        detail: `${String.fromCharCode(0x2028)}::stop-commands::ww`,
      },
    ];
    const s = stub({
      changes,
      apply: async (change, ctx) => {
        if (change !== changes[0]) return;
        ctx.credential("FIN_CF_TOKEN_FILE");
        ctx.masker.register(runtimeId, "<tunnel:console>");
        ctx.out.info(`created ${runtimeId} with ${token}`);
      },
    });
    assert.equal(await h.run(s), EXIT.ok);
    const view = jobLog(h.runtime.all());
    assert.equal(view.stopped, false, "no stop-commands took effect");
    for (const value of [...privateValues(), token, runtimeId]) {
      assert.equal(
        view.text.toLowerCase().includes(value.toLowerCase()),
        false,
        `${value.slice(0, 4)}...`,
      );
    }
    assert.ok(view.masks.includes(token) && view.masks.includes(runtimeId));
    for (const line of h.runtime.all().split("\n")) {
      if (/^\s*::/.test(line)) assert.match(line, /^::add-mask::/);
      assert.equal(line.includes("##["), false, line);
    }
  });
});
