// Entry point: `node ops/fin/src/main.ts <command> <env> ...` (the root's `pnpm fin`).
// Importing this module does nothing; running it as the main module runs the CLI.
//
// The process guards are installed here (core/runtime.ts): a standard output or error that closes
// under the command (EPIPE, when the reader went away), an uncaught exception and an unhandled
// rejection stop printing to the closed stream, close a run that holds the lock as failed (run.done,
// the lock released), and exit 70 with a fixed message, instead of Node's own stack trace and exit 1.

import { fileURLToPath } from "node:url";
import { COMMANDS, runCli } from "./cli.ts";
import type { Command } from "./command.ts";
import { EXIT } from "./core/errors.ts";
import { processRuntime } from "./core/runtime.ts";

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  commands: readonly Command[] = COMMANDS,
): Promise<void> {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const runtime = processRuntime(repoRoot, { guardProcess: true });
  try {
    process.exitCode = await runCli(argv, runtime, commands);
  } catch {
    // runCli never rejects; if it ever did, its error is not printed, since it has not been
    // through the masker.
    runtime.stderr("error: internal error\n");
    process.exitCode = EXIT.internal;
  }
}

if (import.meta.main) await main();
