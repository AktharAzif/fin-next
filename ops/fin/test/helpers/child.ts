// Runs ops/fin's main() with the stub commands of interrupt-child.ts in a real process, for the
// real-process stop tests (apply.test.ts, runtime.test.ts): the real runtime, its process guards
// and its signal handling are what is tested.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Masker } from "../../src/core/mask.ts";
import { RunLog } from "../../src/core/runlog.ts";
import { tempDir } from "./fixtures.ts";

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface Child {
  process: ChildProcessWithoutNullStreams;
  /** The environment's state directory (the run log, the lock and lines.jsonl). */
  logDir: string;
  /** Resolves once the stream has shown the text; rejects if the child exits first. */
  waitFor(text: string, stream?: "stdout" | "stderr"): Promise<void>;
  /** The exit code (null when a signal killed the child). */
  exit(): Promise<number | null>;
  /** The exit code and the signal that killed the child, if one did. */
  ended(): Promise<Exit>;
  out(): string;
  errors(): string;
  /** The changes the child sent (the counter file the stub commands append to). */
  sent(): string[];
  log(): RunLog;
}

export interface ChildOptions {
  env?: Record<string, string>;
  /** Runs before the child starts, with the environment's state directory (created). */
  before?: (logDir: string) => void;
}

export function spawnChild(argv: readonly string[], options: ChildOptions = {}): Child {
  const dir = tempDir();
  const stateDir = join(dir, "state");
  const logDir = join(stateDir, "staging");
  const counter = join(dir, "sent.txt");
  if (options.before !== undefined) {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    options.before(logDir);
  }
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./interrupt-child.ts", import.meta.url)), ...argv],
    {
      env: {
        PATH: process.env.PATH ?? "",
        FIN_STATE_DIR: stateDir,
        FIN_TEST_COUNTER_FILE: counter,
        ...options.env,
      },
    },
  );
  let out = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  // A destroyed stream is the test's own doing; its error is not the test's failure.
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  const ended = once(child, "exit").then(([code, signal]) => ({ code, signal }) as Exit);
  return {
    process: child,
    logDir,
    waitFor: (text, stream = "stdout") =>
      new Promise<void>((resolve, reject) => {
        const seen = () => (stream === "stdout" ? out : errors);
        if (seen().includes(text)) {
          resolve();
          return;
        }
        child[stream].on("data", () => {
          if (seen().includes(text)) resolve();
        });
        void ended.then(({ code, signal }) =>
          reject(new Error(`the child exited early (${code ?? signal}): ${errors}`)),
        );
      }),
    exit: () => ended.then(({ code }) => code),
    ended: () => ended,
    out: () => out,
    errors: () => errors,
    sent: () =>
      existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").filter(Boolean) : [],
    log: () => new RunLog(logDir, new Masker()),
  };
}
