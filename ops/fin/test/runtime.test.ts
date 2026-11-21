import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXIT } from "../src/core/errors.ts";
import {
  INTERRUPT_SIGNALS,
  processRuntime,
  STOP_EXIT,
  stopDescription,
} from "../src/core/runtime.ts";
import { tempDir } from "./helpers/fixtures.ts";

describe("the process runtime", () => {
  it("stops on SIGINT, SIGTERM and SIGHUP with 128 + the signal's number, and on a closed output or an uncaught error with 70", () => {
    assert.deepEqual([...INTERRUPT_SIGNALS].sort(), ["SIGHUP", "SIGINT", "SIGTERM"]);
    assert.deepEqual(STOP_EXIT, {
      SIGHUP: 129,
      SIGINT: 130,
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
    };
    const runtime = processRuntime(tempDir());
    assert.equal(process.listenerCount("uncaughtException"), before.uncaught);
    assert.equal(process.listenerCount("unhandledRejection"), before.rejection);
    assert.equal(process.stdout.listenerCount("error"), before.stdout);
    const untrap = runtime.trap(async () => {});
    assert.equal(process.listenerCount("SIGHUP"), before.hup + 1);
    untrap();
    assert.equal(process.listenerCount("SIGHUP"), before.hup);
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
