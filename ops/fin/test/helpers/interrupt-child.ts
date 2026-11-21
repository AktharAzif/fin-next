// A child process for the real-process stop tests (apply.test.ts). It runs stub mutating commands
// through main(), so the real runtime and its process guards are what is tested:
//
//   stub wait <env>   one change, which prints "waiting" and then takes a second and a half (less
//                     than the time a stop gives the change in flight to settle);
//   stub steps <env>  five changes 300 ms apart; each appends its name to the file
//                     FIN_TEST_COUNTER_FILE names when it is sent, and prints its `done:` line
//                     through the output, as every command does.

import { appendFileSync } from "node:fs";
import type { Command } from "../../src/command.ts";
import { main } from "../../src/main.ts";

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
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    });
  },
};

const steps: Command = {
  words: ["stub", "steps"],
  summary: "five changes, 300 ms apart",
  positionals: [],
  flags: [],
  overlay: false,
  mutating: true,
  runbook: "pnpm-fin.md",
  async run(ctx) {
    const changes = ["c1", "c2", "c3", "c4", "c5"].map((name) => ({
      kind: "dns",
      name,
      action: "create" as const,
    }));
    return ctx.applyPlan("stub", changes, async (change) => {
      appendFileSync(process.env.FIN_TEST_COUNTER_FILE ?? "", `${change.name}\n`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
  },
};

await main(process.argv.slice(2), [wait, steps]);
