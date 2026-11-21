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
import { EXIT } from "../src/core/errors.ts";
import { Masker } from "../src/core/mask.ts";
import { RunLog } from "../src/core/runlog.ts";
import {
  commandEnv,
  fakeRuntime,
  privateValues,
  REPO_ROOT,
  tempDir,
  ZONE,
  ZONE_ID,
} from "./helpers/fixtures.ts";

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
