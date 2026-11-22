import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { COMMANDS, runCli } from "../src/cli.ts";
import type { Command } from "../src/command.ts";
import { EXIT, RefusedError } from "../src/core/errors.ts";
import { Masker } from "../src/core/mask.ts";
import { RunLog } from "../src/core/runlog.ts";
import {
  commandEnv,
  type FakeRuntime,
  fakeRuntime,
  overlayFixture,
  privateValues,
  REPO_ROOT,
  tempDir,
  writeOverlay,
  ZONE,
  ZONE_ID,
} from "./helpers/fixtures.ts";
import { jobLog } from "./helpers/runner.ts";

/**
 * Everything a command left readable: its output (but the add-mask commands, which carry the
 * values for the runner on standard error) and the files in the state directory.
 */
function readable(stateDir: string, r: FakeRuntime): string {
  const files = existsSync(stateDir)
    ? readdirSync(stateDir).map((name) => readFileSync(join(stateDir, name), "utf8"))
    : [];
  const err = r
    .err()
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"));
  return [r.out(), ...err, ...files].join("\n");
}

describe("the CLI", () => {
  it("prints usage with no arguments (exit 64) and on help (exit 0)", async () => {
    const r1 = fakeRuntime();
    assert.equal(await runCli([], r1), EXIT.usage);
    assert.match(r1.out(), /usage: pnpm fin/);
    const r2 = fakeRuntime();
    assert.equal(await runCli(["help"], r2), EXIT.ok);
    assert.match(r2.out(), /overlay check <env>/);
  });

  it("refuses an unknown command, a missing or unknown environment, and unknown flags", async () => {
    const r = fakeRuntime();
    assert.equal(await runCli(["zone", "destroy", "staging"], r), EXIT.usage);
    assert.equal(await runCli(["overlay", "check"], r), EXIT.usage);
    assert.equal(await runCli(["overlay", "check", "production"], r), EXIT.usage);
    assert.equal(await runCli(["overlay", "check", "staging", "--force"], r), EXIT.usage);
    assert.match(r.err(), /unknown flag --force/);
  });

  it("checks the overlay and prints only placeholders", async () => {
    const { env } = commandEnv();
    const r = fakeRuntime({ env });
    assert.equal(await runCli(["overlay", "check", "staging"], r), EXIT.ok);
    assert.match(r.out(), /host admin: <host:admin>/);
    assert.match(r.out(), /zone <zone>/);
    for (const value of privateValues()) assert.equal(r.out().includes(value), false, value);
  });

  it("prints its own counts as they are when they equal a private number", async () => {
    const overlay = { ...overlayFixture(), thresholds: { "api-v4": 11, "errors-5xx": 2 } };
    const dir = tempDir();
    const env = { FIN_OVERLAY_FILE: writeOverlay(dir, overlay), FIN_STATE_DIR: join(dir, "state") };
    const r = fakeRuntime({ env: { ...env, GITHUB_ACTIONS: "true" } });
    assert.equal(await runCli(["overlay", "check", "staging"], r), EXIT.ok);
    // The allow-list's 11 labels are published in the plan: a masked count would name the threshold.
    assert.match(r.out(), /allow-list: 11 labels, 2 spike-only, 3 fallback-only; never-touch: 5/);
    assert.doesNotMatch(r.out(), /<overlay:thresholds/);
    assert.doesNotMatch(r.err(), /^::add-mask::(?:11|2)$/m);
    const log = new RunLog(join(env.FIN_STATE_DIR, "staging"), new Masker());
    for (let i = 0; i < 11; i++) log.append(new Date(), "run_1", "run.step", {});
    const r2 = fakeRuntime({ env });
    assert.equal(await runCli(["log", "verify", "staging"], r2), EXIT.ok);
    assert.match(
      r2.out(),
      /run log: 11 record\(s\), chain intact; head: record 11, sha256 [0-9a-f]{64}$/m,
    );
  });

  it("keeps a run log that does not verify and starts a new one, only with a reason", async () => {
    const { env } = commandEnv({ GITHUB_ACTIONS: "true" });
    const stateDir = join(env.FIN_STATE_DIR ?? "", "staging");
    const log = new RunLog(stateDir, new Masker());
    for (const event of ["run.registered", "run.step", "run.done"])
      log.append(new Date(), "run_1", event, {});
    const shipped = log.readHead();
    const lines = readFileSync(log.logPath, "utf8").split("\n");
    writeFileSync(log.logPath, `${lines[0]}\n`);
    const r = fakeRuntime({ env });
    // A lock break would append past the gap: it is refused like a run.
    log.lock({ runId: "run_stale", command: "routes apply", startedAt: "t" });
    assert.equal(
      await runCli(["lock", "break", "staging", "--reason", "the run's machine crashed"], r),
      EXIT.drift,
    );
    assert.match(
      r.err(),
      /does not verify \(the head file names record 3, but the log holds 1: records were removed\), so the lock is not broken/,
    );
    assert.equal(log.holder()?.runId, "run_stale");
    assert.equal(await runCli(["log", "restart", "staging"], r), EXIT.usage);
    const reason = `the disk under the state dir for ${ZONE} was restored`;
    assert.equal(await runCli(["log", "restart", "staging", "--reason", reason], r), EXIT.ok);
    assert.match(
      r.out(),
      /run log: restarted; the old one is kept beside it \(runs\.broken-run_[0-9a-z]+\.jsonl, head\.broken-run_[0-9a-z]+\.json\)/,
    );
    const [first] = log.records();
    assert.equal(first?.event, "log.restarted");
    assert.equal(first?.reason, "the disk under the state dir for <zone> was restored");
    assert.deepEqual(
      (first?.previous as { headFileHead?: unknown } | undefined)?.headFileHead,
      shipped,
    );
    const line = JSON.parse(
      readFileSync(join(stateDir, "lines.jsonl"), "utf8").trim().split("\n").at(-1) ?? "{}",
    );
    assert.equal(line.event, "log.restarted");
    assert.equal(line.level, "warn");
    assert.deepEqual(line.previousHeadFile, shipped);
    assert.deepEqual({ seq: line.logSeq, hash: line.logHead }, log.readHead());
    assert.equal(await runCli(["log", "verify", "staging"], fakeRuntime({ env })), EXIT.ok);
    assert.equal(
      await runCli(["lock", "break", "staging", "--reason", "the run's machine crashed"], r),
      EXIT.ok,
    );
    assert.equal(log.holder(), undefined);
    const r3 = fakeRuntime({ env });
    assert.equal(
      await runCli(["log", "restart", "staging", "--reason", "checking twice is harmless"], r3),
      EXIT.ok,
    );
    assert.match(r3.out(), /it verifies; there is nothing to restart/);
    for (const value of privateValues())
      assert.equal(readable(stateDir, r).includes(value), false, value);
  });

  it("reports a whole last record that lost its newline (exit 1), refuses a lock break, and restarts the log", async () => {
    const { env } = commandEnv();
    const stateDir = join(env.FIN_STATE_DIR ?? "", "staging");
    const log = new RunLog(stateDir, new Masker());
    for (const event of ["run.registered", "run.step", "lock.broken"]) {
      log.append(new Date(), "run_1", event, {});
    }
    writeFileSync(log.logPath, readFileSync(log.logPath, "utf8").slice(0, -1));
    log.lock({ runId: "run_stale", command: "routes apply", startedAt: "t" });
    const unended = /the last line does not end with a newline \(line 3 is incomplete\)/;

    const verify = fakeRuntime({ env });
    assert.equal(await runCli(["log", "verify", "staging"], verify), EXIT.drift);
    assert.match(verify.err(), unended);
    assert.doesNotMatch(verify.out(), /chain intact/);

    const refused = fakeRuntime({ env });
    const reason = "the run's machine crashed";
    assert.equal(
      await runCli(["lock", "break", "staging", "--reason", reason], refused),
      EXIT.drift,
    );
    assert.match(refused.err(), /the run log does not verify \(.*\), so the lock is not broken/);
    assert.match(refused.err(), unended);
    assert.equal(log.holder()?.runId, "run_stale");

    const restart = fakeRuntime({ env });
    assert.equal(
      await runCli(
        ["log", "restart", "staging", "--reason", "the disk filled up mid-write"],
        restart,
      ),
      EXIT.ok,
    );
    assert.match(restart.err(), unended);
    assert.match(restart.out(), /run log: restarted; the old one is kept beside it/);
    assert.equal(await runCli(["log", "verify", "staging"], fakeRuntime({ env })), EXIT.ok);
    assert.equal(
      await runCli(["lock", "break", "staging", "--reason", reason], fakeRuntime({ env })),
      EXIT.ok,
    );
    assert.equal(log.holder(), undefined);
  });

  it("refuses a lock break (exit 1) on a log with a torn last line or a changed middle line, and appends nothing", async () => {
    for (const damage of ["torn", "middle"] as const) {
      const { env } = commandEnv();
      const log = new RunLog(join(env.FIN_STATE_DIR ?? "", "staging"), new Masker());
      for (const event of ["run.registered", "run.step", "run.done"]) {
        log.append(new Date(), "run_1", event, {});
      }
      if (damage === "torn") {
        // A stale lock and a damaged log together: the run crashed during an append.
        appendFileSync(log.logPath, '{"seq":4,"prev":"abc","at":"2026');
      } else {
        const lines = readFileSync(log.logPath, "utf8").split("\n");
        writeFileSync(
          log.logPath,
          [lines[0], lines[1]?.replace("run.step", "run.stap"), lines[2], ""].join("\n"),
        );
      }
      log.lock({ runId: "run_stale", command: "routes apply", startedAt: "t" });
      const before = readFileSync(log.logPath, "utf8");
      const problems = log.verify().problems;
      assert.ok(problems.length > 0, damage);
      const r = fakeRuntime({ env });
      assert.equal(
        await runCli(["lock", "break", "staging", "--reason", "the run's machine crashed"], r),
        EXIT.drift,
        damage,
      );
      assert.match(r.err(), /the run log does not verify .*so the lock is not broken/, damage);
      assert.equal(log.holder()?.runId, "run_stale", damage);
      assert.equal(readFileSync(log.logPath, "utf8"), before, damage);
      assert.deepEqual(log.verify().problems, problems, `${damage}: the same problems, no more`);
      assert.equal(existsSync(join(env.FIN_STATE_DIR ?? "", "staging", "lines.jsonl")), false);
    }
  });

  it("keeps a crafted argument or lock file from turning the runner's command processing off", async () => {
    const { env } = commandEnv({ GITHUB_ACTIONS: "true" });
    const stateDir = join(env.FIN_STATE_DIR ?? "", "staging");
    const r = fakeRuntime({ env });
    assert.equal(await runCli(["lock", "status", "staging\n::stop-commands::zz"], r), EXIT.usage);
    const log = new RunLog(stateDir, new Masker());
    log.lock({
      runId: "run_x\n::stop-commands::yy",
      command: "##[stop-commands]ww",
      startedAt: "t",
    });
    assert.equal(await runCli(["lock", "status", "staging"], r), EXIT.ok);
    assert.equal(await runCli(["overlay", "check", "staging"], r), EXIT.ok);
    const view = jobLog(r.all());
    assert.equal(view.stopped, false);
    assert.ok(view.masks.length > 0);
    for (const value of privateValues()) {
      assert.equal(view.text.toLowerCase().includes(value.toLowerCase()), false, value);
    }
  });

  it("fails closed (exit 78) without an overlay", async () => {
    const r = fakeRuntime({ env: {} });
    assert.equal(await runCli(["overlay", "check", "staging"], r), EXIT.config);
    assert.match(r.err(), /FIN_OVERLAY_FILE is not set/);
  });

  it("verifies the run log and reports and breaks the lock", async () => {
    const { env } = commandEnv();
    const r = fakeRuntime({ env });
    assert.equal(await runCli(["log", "verify", "staging"], r), EXIT.ok);
    assert.equal(await runCli(["lock", "status", "staging"], r), EXIT.ok);
    assert.match(r.out(), /run lock: free/);
    assert.equal(await runCli(["lock", "break", "staging"], r), EXIT.usage);
    assert.equal(
      await runCli(["lock", "break", "staging", "--reason", "the run's machine crashed"], r),
      EXIT.ok,
    );
    assert.match(r.out(), /already free/);
  });

  it("reports a tampered run log (exit 1) instead of failing on it", async () => {
    const { env } = commandEnv();
    const log = new RunLog(join(env.FIN_STATE_DIR ?? "", "staging"), new Masker());
    log.append(new Date(), "run_1", "run.registered", {});
    log.append(new Date(), "run_1", "run.done", { result: "ok" });
    const r = fakeRuntime({ env });
    assert.equal(await runCli(["log", "verify", "staging"], r), EXIT.ok);
    const head = log.readHead();
    assert.match(
      r.out(),
      new RegExp(`2 record\\(s\\), chain intact; head: record 2, sha256 ${head?.hash}`),
    );
    appendFileSync(log.logPath, "this line was tampered\n");
    const r2 = fakeRuntime({ env });
    assert.equal(await runCli(["log", "verify", "staging"], r2), EXIT.drift);
    assert.match(r2.err(), /run log: line 3 is not a JSON record/);
    assert.doesNotMatch(r2.err(), /internal error|tampered/);
  });

  it("checks the log against a head that left the machine", async () => {
    const { env } = commandEnv();
    const log = new RunLog(join(env.FIN_STATE_DIR ?? "", "staging"), new Masker());
    for (const event of ["run.registered", "run.done", "lock.broken"]) {
      log.append(new Date(), "run_1", event, {});
    }
    const head = log.readHead();
    const r = fakeRuntime({ env });
    assert.equal(
      await runCli(["log", "verify", "staging", "--head", `${head?.seq}:${head?.hash}`], r),
      EXIT.ok,
    );
    const lines = readFileSync(log.logPath, "utf8").split("\n");
    writeFileSync(log.logPath, `${lines[0]}\n`);
    rmSync(log.headPath);
    const r2 = fakeRuntime({ env });
    assert.equal(
      await runCli(["log", "verify", "staging", "--head", `${head?.seq}:${head?.hash}`], r2),
      EXIT.drift,
    );
    assert.match(r2.err(), /names record 3, but the log holds 1: records were removed/);
    assert.equal(await runCli(["log", "verify", "staging", "--head", "3:abc"], r2), EXIT.usage);
  });

  it("breaks a lock with a masked reason, a lock.broken line and the log's head", async () => {
    const { env } = commandEnv({ GITHUB_ACTIONS: "true" });
    const stateDir = join(env.FIN_STATE_DIR ?? "", "staging");
    const log = new RunLog(stateDir, new Masker());
    log.lock({ runId: "run_stale", command: "routes apply", startedAt: "t" });
    const r = fakeRuntime({ env });
    const reason = `the routes run for staff.${ZONE} hung, zone ${ZONE_ID}`;
    assert.equal(await runCli(["lock", "break", "staging", "--reason", reason], r), EXIT.ok);
    assert.equal(log.holder(), undefined);
    const record = log.records().at(-1);
    assert.equal(record?.event, "lock.broken");
    assert.equal(
      record?.reason,
      "the routes run for <host:admin> hung, zone <overlay:cloudflare.zoneId>",
    );
    const lines = readFileSync(join(stateDir, "lines.jsonl"), "utf8").trim().split("\n");
    const line = JSON.parse(lines.at(-1) ?? "{}");
    assert.equal(line.event, "lock.broken");
    assert.equal(line.holderRunId, "run_stale");
    assert.deepEqual({ seq: line.logSeq, hash: line.logHead }, log.readHead());
    assert.match(r.out(), /"event":"lock.broken"/);
    for (const text of [r.out(), readFileSync(log.logPath, "utf8"), lines.join("\n")]) {
      for (const value of privateValues()) assert.equal(text.includes(value), false, value);
    }
  });

  it("warns that a reason is logged as typed without the overlay, and refuses a reason of several lines", async () => {
    const dir = tempDir();
    const env = { FIN_STATE_DIR: join(dir, "state") };
    const log = new RunLog(join(env.FIN_STATE_DIR, "staging"), new Masker());
    log.lock({ runId: "run_stale", command: "routes apply", startedAt: "t" });
    const r = fakeRuntime({ env });
    assert.equal(
      await runCli(["lock", "break", "staging", "--reason", "first line\nsecond line"], r),
      EXIT.usage,
    );
    assert.equal(log.holder()?.runId, "run_stale");
    assert.equal(
      await runCli(["lock", "break", "staging", "--reason", "the machine crashed mid-run"], r),
      EXIT.ok,
    );
    assert.match(r.err(), /the overlay is not loaded.*logged as typed/);
  });

  it("checks every pending change before the run registers, so a refusal sends nothing", async () => {
    const { env } = commandEnv();
    const r = fakeRuntime({ env });
    const applied: string[] = [];
    const command: Command = {
      words: ["test", "apply"],
      summary: "a test command",
      positionals: [],
      flags: [],
      overlay: true,
      mutating: true,
      runbook: "pnpm-fin.md",
      run: (ctx) =>
        ctx.applyPlan(
          "test",
          [
            { kind: "thing", name: "first", action: "create" },
            { kind: "thing", name: "second", action: "create" },
          ],
          async (change) => {
            applied.push(change.name);
          },
          {},
          {
            check: (change) => {
              if (change.name === "second") throw new RefusedError("the second is refused");
            },
          },
        ),
    };
    assert.equal(await runCli(["test", "apply", "staging"], r, [command]), EXIT.refused);
    assert.deepEqual(applied, []);
    assert.equal(existsSync(join(env.FIN_STATE_DIR ?? "", "staging", "runs.jsonl")), false);
    assert.equal(existsSync(join(env.FIN_STATE_DIR ?? "", "staging", "lock.json")), false);
  });

  it("records a refusal during a run as refused, not failed", async () => {
    const { env } = commandEnv();
    const r = fakeRuntime({ env });
    const command: Command = {
      words: ["test", "apply"],
      summary: "a test command",
      positionals: [],
      flags: [],
      overlay: true,
      mutating: true,
      runbook: "pnpm-fin.md",
      run: (ctx) =>
        ctx.applyPlan("test", [{ kind: "thing", name: "one", action: "create" }], async () => {
          throw new RefusedError("a safety rule stopped it");
        }),
    };
    assert.equal(await runCli(["test", "apply", "staging"], r, [command]), EXIT.refused);
    const records = readFileSync(join(env.FIN_STATE_DIR ?? "", "staging", "runs.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(records.at(-1)?.event, "run.done");
    assert.equal(records.at(-1)?.result, "refused");
    assert.equal(existsSync(join(env.FIN_STATE_DIR ?? "", "staging", "lock.json")), false);
  });

  it("names a runbook that exists for every command", () => {
    for (const command of COMMANDS) {
      assert.ok(
        existsSync(join(REPO_ROOT, "docs", "runbooks", command.runbook)),
        `${command.words.join(" ")}: docs/runbooks/${command.runbook} is missing`,
      );
    }
  });

  it("runs as a real process through main.ts", () => {
    const run = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "ops", "fin", "src", "main.ts"), "help"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(run.status, 0);
    assert.match(run.stdout, /usage: pnpm fin/);
  });
});

describe("the package", () => {
  it("imports only node: built-ins and relative files in src/", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) files.push(path);
      }
    };
    walk(join(REPO_ROOT, "ops", "fin", "src"));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/^\s*(?:import|export)[^"']*from\s*["']([^"']+)["']/gm)) {
        const spec = match[1] ?? "";
        assert.ok(
          spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"),
          `${file}: ${spec}`,
        );
      }
    }
  });
});
