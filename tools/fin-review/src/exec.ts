// Starting external programs (spec 07 §2.1): spawn with shell: false, an argument array, a
// timeout and an output cap. Callers validate every value they place in an argument first.

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ProgramError } from "./errors.ts";

export interface RunOptions {
  /** The working directory. */
  readonly cwd: string;
  /** The whole environment of the child; nothing is inherited implicitly. */
  readonly env: Readonly<Record<string, string>>;
  /** Bytes written to the child's stdin, which is then closed. */
  readonly input?: Uint8Array;
  /** Kill the child (SIGKILL) after this many milliseconds. */
  readonly timeoutMs: number;
  /** Kill the child when stdout or stderr grows past this many bytes. */
  readonly maxOutputBytes: number;
}

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

const PROGRAM_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Runs `program` with `args` and resolves with its exit status and output. Rejects with a
 * ProgramError when it cannot start, times out or writes more than the cap.
 */
export function runProgram(program: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  if (!PROGRAM_RE.test(program)) return Promise.reject(new TypeError(`refusing to run program ${JSON.stringify(program)}`));
  for (const arg of args) {
    if (typeof arg !== "string" || arg.includes("\0")) {
      return Promise.reject(new TypeError("refusing an argument that is not a string or holds a NUL byte"));
    }
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(new TypeError("timeoutMs must be a positive integer"));
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(program, [...args], {
        cwd: options.cwd,
        env: { ...options.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(new ProgramError(program, `${program} could not start: ${(error as Error).message}`, null, ""));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: ProgramError | null = null;
    let settled = false;

    const fail = (error: ProgramError): void => {
      if (failure === null) failure = error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      fail(new ProgramError(program, `${program} ${args[0] ?? ""} timed out after ${options.timeoutMs} ms`, null, ""));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxOutputBytes) {
        fail(new ProgramError(program, `${program} ${args[0] ?? ""} wrote more than ${options.maxOutputBytes} bytes`, null, ""));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.maxOutputBytes) {
        fail(new ProgramError(program, `${program} ${args[0] ?? ""} wrote more than ${options.maxOutputBytes} bytes to stderr`, null, ""));
        return;
      }
      stderr.push(chunk);
    });
    child.stdin.on("error", () => {
      // The child may exit before reading all of its input; its exit status reports the failure.
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ProgramError(program, `${program} could not start: ${error.code ?? error.message}`, null, ""));
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure !== null) {
        reject(failure);
        return;
      }
      resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
