// Runs one of the harness's command lines as Playwright's webServer does, and reads what it
// prints, for the CLI self-tests.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

export interface Cli {
  readonly stdout: string[];
  readonly stderr: () => string;
  /** The stdout line at `index`, once printed; throws when the CLI exits first. */
  line(index: number): Promise<string>;
  /** The exit code, once the CLI has exited and its output has been read. */
  exited(): Promise<number | null>;
  stop(): Promise<void>;
}

/**
 * Starts `script` with this Node. FIN_E2E_CLOCK and FIN_E2E_INGRESS_PROOF are cleared, so the
 * caller's shell cannot change what a test sees, unless `env` sets them.
 */
export function runCli(script: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Cli {
  const child: ChildProcess = spawn(process.execPath, [script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FIN_E2E_CLOCK: "", FIN_E2E_INGRESS_PROOF: "", ...env },
  });
  const stdout: string[] = [];
  let stderr = "";
  const waiters: Array<() => void> = [];
  createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (text) => {
    stdout.push(text);
    for (const wake of waiters.splice(0)) wake();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  // "close" comes after the output streams have ended, so stderr is complete by then.
  const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  return {
    stdout,
    stderr: () => stderr,
    async line(index) {
      while (stdout.length <= index) {
        if (child.exitCode !== null) throw new Error(`the CLI exited: ${stderr}`);
        await new Promise<void>((wake) => {
          waiters.push(wake);
          setTimeout(wake, 200);
        });
      }
      return stdout[index] as string;
    },
    async exited() {
      const [code] = await closed;
      return code;
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
    },
  };
}
