// A child process for the interrupt test (apply.test.ts): runs a stub mutating command through the
// real runtime, prints "waiting" from inside its first change, and waits there until the parent
// sends a signal.

import { runCli } from "../../src/cli.ts";
import type { Command } from "../../src/command.ts";
import { processRuntime } from "../../src/core/runtime.ts";
import { REPO_ROOT } from "./fixtures.ts";

const wait: Command = {
  words: ["stub", "wait"],
  summary: "waits inside its first change",
  positionals: [],
  flags: [],
  overlay: false,
  mutating: true,
  runbook: "pnpm-fin.md",
  async run(ctx) {
    return ctx.applyPlan("stub", [{ kind: "dns", name: "console", action: "create" }], async () => {
      process.stdout.write("waiting\n");
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    });
  },
};

process.exitCode = await runCli(process.argv.slice(2), processRuntime(REPO_ROOT), [wait]);
