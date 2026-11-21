// Entry point: `node ops/fin/src/main.ts <command> <env> ...` (the root's `pnpm fin`).
// Importing this module does nothing; running it as the main module runs the CLI.

import { fileURLToPath } from "node:url";
import { runCli } from "./cli.ts";
import { EXIT } from "./core/errors.ts";
import { processRuntime } from "./core/runtime.ts";

export async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  try {
    process.exitCode = await runCli(process.argv.slice(2), processRuntime(repoRoot));
  } catch {
    // runCli never rejects; if it ever did, its error is not printed, since it has not been
    // through the masker.
    process.stderr.write("error: internal error\n");
    process.exitCode = EXIT.internal;
  }
}

if (import.meta.main) await main();
