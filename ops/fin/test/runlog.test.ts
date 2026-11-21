import assert from "node:assert/strict";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "../src/core/args.ts";
import { BusyError, FinError } from "../src/core/errors.ts";
import { Masker } from "../src/core/mask.ts";
import { Output } from "../src/core/output.ts";
import { Run } from "../src/core/run.ts";
import { GENESIS, parseHead, RunLog, sha256 } from "../src/core/runlog.ts";
import {
  type FakeRuntimeOptions,
  fakeRuntime,
  fakeToken,
  tempDir,
  writePrivate,
  ZONE,
} from "./helpers/fixtures.ts";

function newLog(masker = new Masker()): RunLog {
  return new RunLog(join(tempDir(), "state", "staging"), masker);
}

function fill(log: RunLog, events: readonly string[]): void {
  const at = new Date("2026-11-21T06:00:00Z");
  for (const event of events) log.append(at, "run_1", event, { detail: event });
}

describe("the run log", () => {
  it("appends masked records chained by hash, and verifies the chain", () => {
    const m = new Masker();
    m.register(ZONE, "<zone>");
    const log = newLog(m);
    const at = new Date("2026-11-21T06:00:00Z");
    log.append(at, "run_1", "run.registered", { host: `console.${ZONE}` });
    const { record, hash } = log.append(at, "run_1", "run.done", { result: "ok" });
    const records = log.records();
    assert.equal(records.length, 2);
    assert.equal(records[0]?.prev, GENESIS);
    assert.equal(records[1]?.seq, 2);
    assert.equal(record.seq, 2);
    assert.equal(readFileSync(log.logPath, "utf8").includes(ZONE), false);
    assert.equal(records[0]?.host, "console.<zone>");
    assert.deepEqual(log.readHead(), { seq: 2, hash });
    const result = log.verify();
    assert.deepEqual(result.problems, []);
    assert.equal(result.count, 2);
    assert.deepEqual(result.head, { seq: 2, hash });
  });

  it("never lets a field overwrite the chain's own fields", () => {
    const log = newLog();
    log.append(new Date(), "run_1", "run.step", { seq: 99, prev: "x", event: "forged" });
    const record = log.records()[0];
    assert.equal(record?.seq, 1);
    assert.equal(record?.prev, GENESIS);
    assert.equal(record?.event, "run.step");
    assert.deepEqual(log.verify().problems, []);
  });

  it("detects an edited or removed line", () => {
    const log = newLog();
    fill(log, ["a", "b", "c"]);
    const lines = readFileSync(log.logPath, "utf8").split("\n");
    writeFileSync(log.logPath, [lines[0], lines[2], ""].join("\n"));
    assert.ok(log.verify().problems.length > 0);
    writeFileSync(
      log.logPath,
      [lines[0], lines[1]?.replace('"b"', '"x"'), lines[2], ""].join("\n"),
    );
    assert.ok(log.verify().problems.some((p) => p.includes("line 3")));
  });

  it("detects records removed from the end, and an emptied or deleted log", () => {
    const log = newLog();
    fill(log, ["run.registered", "run.step", "run.done", "lock.broken"]);
    const lines = readFileSync(log.logPath, "utf8").split("\n");
    writeFileSync(log.logPath, `${lines[0]}\n`);
    assert.match(log.verify().problems.join("; "), /names record 4, but the log holds 1/);
    writeFileSync(log.logPath, "");
    assert.match(log.verify().problems.join("; "), /names record 4, but the log holds 0/);
    rmSync(log.logPath);
    assert.match(log.verify().problems.join("; "), /records were removed/);
  });

  it("detects a removed head file", () => {
    const log = newLog();
    fill(log, ["a"]);
    rmSync(log.headPath);
    assert.deepEqual(log.verify().problems, ["the head file is missing"]);
  });

  it("checks a head that left the machine, which catches a log and head file rewritten together", () => {
    const log = newLog();
    fill(log, ["run.registered", "run.step", "run.done"]);
    const shipped = log.readHead();
    assert.ok(shipped !== undefined);
    assert.deepEqual(log.verify(shipped).problems, []);
    // Rewrite the whole log with a consistent chain and head file: only the shipped head tells.
    rmSync(log.logPath);
    rmSync(log.headPath);
    fill(
      log,
      ["run.registered", "run.step", "run.done"].map((e) => `${e}-forged`),
    );
    assert.deepEqual(log.verify().problems, []);
    assert.match(
      log.verify(shipped).problems.join("; "),
      /record 3 is not the record the head given names/,
    );
    rmSync(log.logPath);
    rmSync(log.headPath);
    assert.match(log.verify(shipped).problems.join("; "), /names record 3, but the log holds 0/);
    assert.deepEqual(parseHead(`3:${shipped.hash}`), shipped);
    assert.equal(parseHead("3:abc"), undefined);
    assert.equal(parseHead(`0:${shipped.hash}`), undefined);
  });

  it("reports a line that is not JSON instead of failing, and reading skips it", () => {
    const log = newLog();
    fill(log, ["a", "b"]);
    appendFileSync(log.logPath, "this line was tampered\n");
    const result = log.verify();
    assert.equal(result.count, 3);
    assert.ok(result.problems.includes("line 3 is not a JSON record"));
    assert.equal(log.records().length, 2);
  });

  it("masks values in every form and keeps valid JSON whatever is registered", () => {
    const m = new Masker();
    m.register("12", "<overlay:oncall.escalateAfterMinutes>");
    m.register('Acme "Private" Holdings', "<overlay:cloudflare.accountName>");
    const log = newLog(m);
    const at = new Date();
    for (let i = 0; i < 14; i++) {
      log.append(at, "run_1", "run.step", { n: i, error: 'failed for Acme "Private" Holdings' });
    }
    const text = readFileSync(log.logPath, "utf8");
    assert.equal(text.includes("Private"), false);
    const records = log.records();
    assert.equal(records.length, 14);
    assert.equal(records[11]?.seq, 12);
    assert.equal(records[12]?.n, "<overlay:oncall.escalateAfterMinutes>");
    assert.deepEqual(log.verify().problems, []);
    log.lock({ runId: "run_12", command: "zone apply", startedAt: "t" });
    assert.equal(log.holder()?.runId, "run_12");
    log.unlock("run_12");
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
    assert.equal(log.release("run_b"), "held-by-another");
    assert.equal(log.holder()?.runId, "run_a");
    assert.equal(log.release("run_a"), "released");
    assert.equal(log.release("run_a"), "free");
    assert.equal(log.holder(), undefined);
  });

  it("breaks a stale lock only with a logged reason", () => {
    const log = newLog();
    log.lock({ runId: "run_a", command: "zone apply", startedAt: "t" });
    const broken = log.breakLock(new Date(), "run_c", "machine crashed mid-run", "operator");
    assert.equal(broken?.holder.runId, "run_a");
    assert.equal(broken?.appended.record.seq, 1);
    assert.equal(log.holder(), undefined);
    const record = log.records().at(-1);
    assert.equal(record?.event, "lock.broken");
    assert.equal(record?.reason, "machine crashed mid-run");
    assert.equal(sha256(readFileSync(log.logPath, "utf8").trim()), broken?.appended.hash);
  });
});

describe("a registered run", () => {
  function newRun(dryRun = false, options: FakeRuntimeOptions = {}, argv: string[] = []) {
    const runtime = fakeRuntime(options);
    const m = new Masker();
    const log = newLog(m);
    const args = parseArgs(argv, {
      positionals: [],
      flags: [
        { name: "spike", kind: "boolean", description: "" },
        { name: "confirm-delete", kind: "integer", description: "" },
        { name: "manifest", kind: "string", description: "" },
      ],
    });
    const run = new Run(runtime, log, new Output(runtime, m), {
      command: "zone apply",
      environment: "staging",
      dryRun,
      args,
    });
    return { runtime, log, run, masker: m };
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
    run.acquire();
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
    const head = log.readHead();
    assert.equal(run.lines[1]?.logSeq, head?.seq);
    assert.equal(run.lines[1]?.logHead, head?.hash);
  });

  it("records the arguments, the safety overrides and a dirty checkout with the registration", () => {
    const { run, log, runtime } = newRun(false, { dirty: true }, [
      "--spike",
      "--confirm-delete",
      "2",
      "--manifest",
      "release/manifest.json",
    ]);
    run.register();
    const registered = log.records()[0];
    assert.deepEqual(registered?.args, {
      positionals: [],
      flags: { spike: true, "confirm-delete": 2, manifest: "release/manifest.json" },
    });
    assert.equal(registered?.dirty, true);
    assert.deepEqual(run.lines[0]?.flags, { spike: true, "confirm-delete": 2, manifest: true });
    assert.equal(run.lines[0]?.dirty, true);
    assert.match(runtime.err(), /local changes/);
    run.finish("ok");
  });

  it("writes the lines beside the log as they happen", () => {
    const { run, log } = newRun();
    run.register();
    const file = join(log.dir, "lines.jsonl");
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
    run.finish("failed", { error: "x" });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1] ?? "{}").level, "error");
  });

  it("registers once: a run that finished refuses to register again", () => {
    const { run, log } = newRun();
    run.register();
    run.finish("ok");
    assert.throws(
      () => run.register(),
      (e: unknown) => e instanceof FinError && /registers once/.test(e.message),
    );
    assert.equal(log.records().length, 2);
    assert.equal(log.holder(), undefined);
  });

  it("stops writing once another run holds the lock, and leaves that run's lock alone", () => {
    const { run, log, runtime } = newRun();
    run.register();
    log.breakLock(new Date(), "run_breaker", "the machine was thought gone", "operator");
    log.lock({ runId: "run_b", command: "routes apply", startedAt: "t" });
    assert.throws(
      () => run.assertWritable("POST dns"),
      (e: unknown) =>
        e instanceof BusyError && /no longer holds the run lock \(run_b/.test(e.message),
    );
    assert.doesNotThrow(() => run.finish("failed", { error: "lock lost" }));
    assert.equal(log.holder()?.runId, "run_b");
    const done = log.records().at(-1);
    assert.equal(done?.event, "run.done");
    assert.equal(done?.lockLost, true);
    assert.match(runtime.err(), /another run holds the run lock now/);
  });

  it("closes a run whose log cannot be written without throwing", () => {
    const { run, log } = newRun();
    run.register();
    rmSync(log.dir, { recursive: true, force: true });
    writeFileSync(log.dir, "not a directory");
    assert.doesNotThrow(() => run.finish("failed", { error: "x" }));
    assert.equal(run.finished, true);
  });

  it("ships the lines with the ingest token, and only warns when shipping cannot happen", async () => {
    const dir = tempDir();
    const token = fakeToken("ingest");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: calls.length === 1 ? 202 : 503 });
    };
    const env = {
      FIN_OPS_INGEST_HOST: "ingest.example.com",
      FIN_OPS_INGEST_TOKEN_FILE: writePrivate(dir, "ingest", token),
    };
    const { run, runtime } = newRun(false, { env, fetch });
    run.register();
    await run.flushLines();
    assert.equal(calls.length, 1);
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${token}`);
    assert.equal(calls[0]?.url, "https://ingest.example.com/");
    assert.equal(JSON.parse(String(calls[0]?.init.body))[0].event, "run.registered");
    run.finish("ok");
    await run.flushLines();
    assert.equal(calls.length, 2);
    assert.match(runtime.err(), /answered 503; they stay local/);
    assert.equal(runtime.err().includes(token), false);

    const open = join(dir, "open-token");
    writeFileSync(open, token, { mode: 0o644 });
    const bad = newRun(false, { env: { ...env, FIN_OPS_INGEST_TOKEN_FILE: open }, fetch });
    bad.run.register();
    bad.run.finish("ok");
    await assert.doesNotReject(bad.run.flushLines());
    assert.match(bad.runtime.err(), /others can read.*the lines stay local/);
    assert.equal(calls.length, 2);
  });
});
