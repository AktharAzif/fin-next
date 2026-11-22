// Runs the CLI once in a process of its own, as main.ts does, and reports the CPU time its thread
// spent inside runCli: `node timed-cli.ts <command> [options]` prints one JSON object, the run's
// exit code, its output and `cpuMs`. A real run is one process, so a speed test that times its
// runs this way sees every run pay for what a module remembers or warms up, as a real run does.
// Importing this module does nothing.

import { runCli } from "../../src/cli.ts";
import { type CliRun, CONFIG_DIR } from "./cli.ts";

/** One run's result, as this script prints it. */
export interface TimedCliRun extends CliRun {
  cpuMs: number;
}

/** The CPU time this thread has used, in milliseconds. */
function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

if (import.meta.main) {
  let stdout = "";
  let stderr = "";
  const started = threadCpuMs();
  const code = await runCli({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    configDir: CONFIG_DIR,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  const cpuMs = threadCpuMs() - started;
  const run: TimedCliRun = { code, stdout, stderr, cpuMs };
  process.stdout.write(JSON.stringify(run));
}
