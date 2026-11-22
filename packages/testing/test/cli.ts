// Runs one of the harness's command lines as Playwright's webServer does, and reads what it
// prints, for the CLI self-tests.
//
// A command line here is a server, so it must not outlive its test: stop() ends it (SIGTERM, then
// SIGKILL should it not have exited within a grace), each self-test stops every one it started in
// afterAll, and every one is started with a preloaded script that ends it once the test process
// is gone (a runner killed outright runs no afterAll).
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** How long a stopped command line has to exit after SIGTERM before it is sent SIGKILL. */
const STOP_GRACE_MS = 5_000;

export interface Cli {
  readonly stdout: string[];
  readonly stderr: () => string;
  /** The stdout line at `index`, once printed; throws when the CLI exits first. */
  line(index: number): Promise<string>;
  /** The exit code, once the CLI has exited and its output has been read. */
  exited(): Promise<number | null>;
  stop(): Promise<void>;
}

let guard: string | undefined;

/**
 * The script preloaded into every command line: it ends the process (SIGKILL, which nothing in it
 * can delay) once its parent, this test process, is gone, checked every 250 ms by a timer that
 * never holds it open. Written once per test process.
 */
function exitWithParentScript(): string {
  if (guard === undefined) {
    guard = join(mkdtempSync(join(tmpdir(), "fin-testing-cli-guard-")), "exit-with-parent.cjs");
    writeFileSync(
      guard,
      `const parent = ${process.pid};\nsetInterval(() => { if (process.ppid !== parent) process.kill(process.pid, "SIGKILL"); }, 250).unref();\n`,
    );
  }
  return guard;
}

/**
 * Starts `script` with this Node. FIN_E2E_CLOCK and FIN_E2E_INGRESS_PROOF are cleared, so the
 * caller's shell cannot change what a test sees, unless `env` sets them.
 */
export function runCli(script: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Cli {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--require", exitWithParentScript(), script, ...args],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FIN_E2E_CLOCK: "", FIN_E2E_INGRESS_PROOF: "", ...env },
    },
  );
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
  const running = (): boolean => child.exitCode === null && child.signalCode === null;
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
      if (running()) child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<"running">((resolve) => {
        timer = setTimeout(() => resolve("running"), STOP_GRACE_MS);
      });
      const end = await Promise.race([closed, grace]);
      clearTimeout(timer);
      if (end === "running") {
        child.kill("SIGKILL");
        await closed;
      }
    },
  };
}
