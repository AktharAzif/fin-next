// Running the CLI from tests: in-process through runCli, or as a real process through main.ts,
// optionally from a copy of the engine whose configuration a test changes.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../../src/cli.ts";

export const TOOL_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CONFIG_DIR = join(TOOL_ROOT, "config");
export const MAIN = join(TOOL_ROOT, "src", "main.ts");

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  configDir?: string;
}

/** Runs the CLI in this process with a clean environment unless one is given. */
export async function cli(argv: string[], options: CliOptions = {}): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const code = await runCli({
    argv,
    env: options.env ?? { PATH: process.env["PATH"] },
    cwd: options.cwd ?? process.cwd(),
    configDir: options.configDir ?? CONFIG_DIR,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

/** Runs `node <main> ...argv` as a real process. */
export function spawnCli(argv: string[], options: CliOptions & { main?: string } = {}): CliRun {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.env ?? { PATH: process.env["PATH"] })) {
    if (value !== undefined) env[name] = value;
  }
  const result = spawnSync(process.execPath, [options.main ?? MAIN, ...argv], {
    cwd: options.cwd ?? process.cwd(),
    env,
    shell: false,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return { code: result.status ?? -1, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
}

/** A copy of the engine (src and config) in a temporary directory, for configuration tests. */
export function copyEngine(): { root: string; configDir: string; main: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fin-review-engine-"));
  const root = join(dir, "tools", "fin-review");
  cpSync(join(TOOL_ROOT, "src"), join(root, "src"), { recursive: true });
  cpSync(join(TOOL_ROOT, "config"), join(root, "config"), { recursive: true });
  cpSync(join(TOOL_ROOT, "package.json"), join(root, "package.json"));
  return {
    root,
    configDir: join(root, "config"),
    main: join(root, "src", "main.ts"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
