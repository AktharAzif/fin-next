// Entry point: `node tools/fin-review/src/main.ts <command> [options]` (spec 07 §2.1).
// Importing this module does nothing; running it as the main module runs the CLI.

import { fileURLToPath } from "node:url";
import { runCli } from "./cli.ts";

/** Runs the CLI against this process and sets its exit code. */
export async function main(): Promise<void> {
  process.exitCode = await runCli({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    configDir: fileURLToPath(new URL("../config/", import.meta.url)),
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  });
}

if (import.meta.main) await main();
