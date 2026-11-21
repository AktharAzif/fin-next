// Test helpers: a Fin process run as a child whose stdout's reader goes away, as when the
// container's log collector stops reading. Imported only by *.test.ts files (here and in the apps
// built on @fin/server).
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createServer } from "node:net";
import type { Readable, Writable } from "node:stream";

export type ChildEnd = number | NodeJS.Signals | "running";

export interface ClosedStdoutChild {
  readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  /** Waits up to `ms` for the child to exit; past that it is killed and the answer is "running". */
  exit(ms: number): Promise<ChildEnd>;
  /** What the child wrote to stderr (nothing, for a Fin process). */
  stderr(): string;
}

/**
 * Starts `node <script>` with only `env`, waits for its first line on stdout, then closes the
 * pipe's read end, so every write the child makes to stdout from then on fails (EPIPE).
 */
export async function spawnThenCloseStdout(
  script: string,
  env: Readonly<Record<string, string>>,
  firstLineMs = 15_000,
): Promise<ClosedStdoutChild> {
  const child = spawn(process.execPath, [script], {
    env: { ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | NodeJS.Signals>((resolve) => {
    child.once("exit", (code, signal) => resolve(code ?? signal ?? "SIGKILL"));
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the child wrote no line")), firstLineMs);
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    void exited.then((end) => {
      clearTimeout(timer);
      reject(new Error(`the child ended (${end}) before its first line: ${stderr.slice(0, 500)}`));
    });
  });
  child.stdout.destroy();
  return {
    child,
    stderr: () => stderr,
    exit: async (ms) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"running">((resolve) => {
        timer = setTimeout(() => resolve("running"), ms);
      });
      const end = await Promise.race([exited, deadline]);
      clearTimeout(timer);
      if (end === "running") {
        child.kill("SIGKILL");
        await exited;
      }
      return end;
    },
  };
}

/** A TCP port free on loopback a moment ago. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
