import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { COMMANDS, runCli } from "../src/cli.ts";
import { EXIT } from "../src/core/errors.ts";
import { commandEnv, fakeRuntime, privateValues, REPO_ROOT } from "./helpers/fixtures.ts";

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
