import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BusyError } from "../src/core/errors.ts";
import { Masker } from "../src/core/mask.ts";
import { Output } from "../src/core/output.ts";
import { Run } from "../src/core/run.ts";
import { RunLog } from "../src/core/runlog.ts";
import { fakeRuntime, tempDir, ZONE } from "./helpers/fixtures.ts";

function newLog(masker = new Masker()): RunLog {
  return new RunLog(join(tempDir(), "state", "staging"), masker);
}

describe("the run log", () => {
  it("appends masked records chained by hash, and verifies the chain", () => {
    const m = new Masker();
    m.register(ZONE, "<zone>");
    const log = newLog(m);
    const at = new Date("2026-11-21T06:00:00Z");
    log.append(at, "run_1", "run.registered", { host: `console.${ZONE}` });
    log.append(at, "run_1", "run.done", { result: "ok" });
    const records = log.records();
    assert.equal(records.length, 2);
    assert.equal(records[0]?.prev, "genesis");
    assert.equal(records[1]?.seq, 2);
    assert.equal(readFileSync(log.logPath, "utf8").includes(ZONE), false);
    assert.equal(records[0]?.host, "console.<zone>");
    assert.deepEqual(log.verify(), []);
  });

  it("detects an edited or removed line", () => {
    const log = newLog();
    const at = new Date();
    for (const event of ["a", "b", "c"]) log.append(at, "run_1", event, {});
    const lines = readFileSync(log.logPath, "utf8").split("\n");
    writeFileSync(log.logPath, [lines[0], lines[2], ""].join("\n"));
    assert.ok(log.verify().length > 0);
    writeFileSync(
      log.logPath,
      [lines[0], lines[1]?.replace('"b"', '"x"'), lines[2], ""].join("\n"),
    );
    assert.ok(log.verify().some((p) => p.includes("line 3")));
  });

  it("holds an exclusive lock that a second run cannot take", () => {
    const log = newLog();
    log.lock({ runId: "run_a", command: "zone apply", startedAt: "t" });
    assert.throws(
      () => log.lock({ runId: "run_b", command: "routes apply", startedAt: "t" }),
      (e: unknown) => {
        assert.ok(e instanceof BusyError);
        assert.match(e.message, /held by run_a \(zone apply/);
        return true;
      },
    );
    assert.throws(() => log.unlock("run_b"), /held by run_a/);
    log.unlock("run_a");
    assert.equal(log.holder(), undefined);
  });

  it("breaks a stale lock only with a logged reason", () => {
    const log = newLog();
    log.lock({ runId: "run_a", command: "zone apply", startedAt: "t" });
    const broken = log.breakLock(new Date(), "run_c", "machine crashed mid-run", "operator");
    assert.equal(broken?.runId, "run_a");
    assert.equal(log.holder(), undefined);
    const record = log.records().at(-1);
    assert.equal(record?.event, "lock.broken");
    assert.equal(record?.reason, "machine crashed mid-run");
  });
});

describe("a registered run", () => {
  function newRun(dryRun = false) {
    const runtime = fakeRuntime();
    const m = new Masker();
    const log = newLog(m);
    const run = new Run(runtime, log, new Output(runtime, m), {
      command: "zone apply",
      environment: "staging",
      dryRun,
    });
    return { runtime, log, run };
  }

  it("refuses a write before registration and after it finishes", () => {
    const { run } = newRun();
    assert.throws(() => run.assertWritable("PATCH setting"), /outside a registered run/);
    run.register();
    run.assertWritable("PATCH setting");
    run.finish("ok");
    assert.throws(() => run.assertWritable("PATCH setting"), /outside a registered run/);
  });

  it("refuses every write in a dry run, and registers nothing", () => {
    const { run, log } = newRun(true);
    run.register();
    assert.equal(run.registered, false);
    assert.throws(() => run.assertWritable("POST dns"), /dry run sends nothing/);
    assert.equal(log.records().length, 0);
    assert.equal(log.holder(), undefined);
  });

  it("writes registered, step and done records, then releases the lock", () => {
    const { run, log } = newRun();
    run.register({ plan: { create: 1 } });
    assert.equal(log.holder()?.runId, run.id);
    run.step("dns", "console", "create");
    run.finish("ok");
    assert.deepEqual(
      log.records().map((r) => r.event),
      ["run.registered", "run.step", "run.done"],
    );
    const done = log.records().at(-1);
    assert.equal(done?.result, "ok");
    assert.equal(done?.steps, 1);
    assert.equal(log.holder(), undefined);
    assert.match(run.id, /^run_[0-9a-hjkmnp-tv-z]{26}$/);
    assert.deepEqual(
      run.lines.map((l) => l.event),
      ["run.registered", "run.done"],
    );
    assert.equal(run.lines[0]?.service, "ops");
  });

  it("writes the lines beside the log", async () => {
    const { run, log } = newRun();
    run.register();
    run.finish("failed", { error: "x" });
    await run.flushLines();
    const lines = readFileSync(join(log.dir, "lines.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1] ?? "{}").level, "error");
  });
});
