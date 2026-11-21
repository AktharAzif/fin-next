// A child process for the real-process stop tests (helpers/child.ts). It runs stub commands through
// main(), so the real runtime and its process guards are what is tested:
//
//   stub wait <env>    one change, which prints "waiting" and then takes a second and a half (less
//                      than the time a stop gives the change in flight to settle);
//   stub hang <env>    one change, which prints "waiting" and then takes ten seconds (more than a
//                      stop waits for it);
//   stub steps <env>   five changes 300 ms apart; each appends its name to the file
//                      FIN_TEST_COUNTER_FILE names when it is sent, and prints its `done:` line
//                      through the output, as every command does;
//   stub warn <env>    the same five changes, each announced first on standard error;
//   stub throw <env>   one change, which prints "waiting", throws from a timer 100 ms later (an
//                      uncaught exception), and would otherwise take a second and a half;
//   stub reject <env>  the same, with a promise rejected and never handled instead;
//   probe throw <env>  a read-only command that throws from a timer (no run, no lock).
//
// The thrown text is FIN_TEST_MARKER, which must never be printed. With FIN_TEST_HANG_SHIPPING=1,
// shipping a batch of lines answers the first time and then never answers (holding the process
// open, as a stuck connection does), so the clean-up after a stop hangs.

import { appendFileSync } from "node:fs";
import type { Command } from "../../src/command.ts";
import type { Context } from "../../src/core/context.ts";
import { main } from "../../src/main.ts";

const marker = process.env.FIN_TEST_MARKER ?? "the thrown text";

if (process.env.FIN_TEST_HANG_SHIPPING === "1") {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response("{}", { status: 202 });
    return new Promise<Response>(() => {
      setInterval(() => {}, 1_000);
    });
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mutating(name: string, summary: string, run: (ctx: Context) => Promise<number>): Command {
  return {
    words: ["stub", name],
    summary,
    positionals: [],
    flags: [],
    overlay: false,
    mutating: true,
    runbook: "pnpm-fin.md",
    run,
  };
}

function oneChange(ctx: Context, inside: () => Promise<void>): Promise<number> {
  return ctx.applyPlan("stub", [{ kind: "dns", name: "console", action: "create" }], async () => {
    process.stdout.write("waiting\n");
    await inside();
  });
}

function fiveChanges(ctx: Context, announce: boolean): Promise<number> {
  const changes = ["c1", "c2", "c3", "c4", "c5"].map((name) => ({
    kind: "dns",
    name,
    action: "create" as const,
  }));
  return ctx.applyPlan("stub", changes, async (change) => {
    if (announce) ctx.out.warn(`sending ${change.name}`);
    appendFileSync(process.env.FIN_TEST_COUNTER_FILE ?? "", `${change.name}\n`);
    await sleep(300);
  });
}

const commands: Command[] = [
  mutating("wait", "waits inside its first change", (ctx) => oneChange(ctx, () => sleep(1_500))),
  mutating("hang", "waits ten seconds inside its first change", (ctx) =>
    oneChange(ctx, () => sleep(10_000)),
  ),
  mutating("steps", "five changes, 300 ms apart", (ctx) => fiveChanges(ctx, false)),
  mutating("warn", "five changes, each announced on standard error", (ctx) =>
    fiveChanges(ctx, true),
  ),
  mutating("throw", "throws from a timer inside its change", (ctx) =>
    oneChange(ctx, async () => {
      setTimeout(() => {
        throw new Error(marker);
      }, 100);
      await sleep(1_500);
    }),
  ),
  mutating("reject", "leaves a rejected promise inside its change", (ctx) =>
    oneChange(ctx, async () => {
      setTimeout(() => {
        void Promise.reject(new Error(marker));
      }, 100);
      await sleep(1_500);
    }),
  ),
  {
    words: ["probe", "throw"],
    summary: "a read-only command that throws from a timer",
    positionals: [],
    flags: [],
    overlay: false,
    mutating: false,
    runbook: "pnpm-fin.md",
    async run() {
      setTimeout(() => {
        throw new Error(marker);
      }, 50);
      await sleep(1_500);
      return 0;
    },
  },
];

await main(process.argv.slice(2), commands);
