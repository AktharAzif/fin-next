// Entry point: `node ops/fin/src/main.ts <command> <env> ...` (the root's `pnpm fin`).
// Importing this module does nothing; running it as the main module runs the CLI.

import { fileURLToPath } from "node:url";
import { runCli } from "./cli.ts";
import { processRuntime } from "./core/runtime.ts";

export async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  process.exitCode = await runCli(process.argv.slice(2), processRuntime(repoRoot));
}

if (import.meta.main) await main();
