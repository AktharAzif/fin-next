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
  /** Stop the child after this many milliseconds. */
  readonly timeoutMs: number;
  /** Kill the child when stdout or stderr grows past this many bytes. */
  readonly maxOutputBytes: number;
  /**
   * On timeout or abort, send SIGTERM and wait this long before SIGKILL (spec 07 §4.1: 10 s for a
   * session). Absent or 0: SIGKILL at once.
   */
  readonly killGraceMs?: number;
  /** Aborting stops the child the same way a timeout does. */
  readonly signal?: AbortSignal;
}

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

/** How a run ended, for callers that tell a timeout from a failed exit (the session runner). */
export type RunOutcome =
  | ({ readonly kind: "exited" } & RunResult)
  | { readonly kind: "timeout"; readonly stdout: Buffer; readonly stderr: Buffer }
  | { readonly kind: "aborted"; readonly stdout: Buffer; readonly stderr: Buffer }
  | { readonly kind: "output"; readonly stream: "stdout" | "stderr" }
  | { readonly kind: "start"; readonly message: string };

const PROGRAM_RE = /^[A-Za-z0-9._/-]+$/;

function checkRequest(program: string, args: readonly string[], options: RunOptions): TypeError | null {
  if (!PROGRAM_RE.test(program)) return new TypeError(`refusing to run program ${JSON.stringify(program)}`);
  for (const arg of args) {
    if (typeof arg !== "string" || arg.includes("\0")) {
      return new TypeError("refusing an argument that is not a string or holds a NUL byte");
    }
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) return new TypeError("timeoutMs must be a positive integer");
  const grace = options.killGraceMs ?? 0;
  if (!Number.isInteger(grace) || grace < 0) return new TypeError("killGraceMs must be a non-negative integer");
  return null;
}

/**
 * Runs `program` with `args` and resolves with how it ended. Never rejects for the program's own
 * behaviour; rejects with TypeError only for a request it refuses.
 */
export function runProgramSettled(program: string, args: readonly string[], options: RunOptions): Promise<RunOutcome> {
  const refused = checkRequest(program, args, options);
  if (refused !== null) return Promise.reject(refused);
  return new Promise((resolve) => {
    if (options.signal?.aborted === true) {
      resolve({ kind: "aborted", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      return;
    }
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
      resolve({ kind: "start", message: (error as Error).message });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stopped: "timeout" | "aborted" | "stdout" | "stderr" | null = null;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const grace = options.killGraceMs ?? 0;

    const stop = (why: "timeout" | "aborted" | "stdout" | "stderr"): void => {
      if (stopped !== null) return;
      stopped = why;
      if (why === "stdout" || why === "stderr" || grace === 0) {
        child.kill("SIGKILL");
        return;
      }
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), grace);
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    const onAbort = (): void => stop("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxOutputBytes) {
        stop("stdout");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.maxOutputBytes) {
        stop("stderr");
        return;
      }
      stderr.push(chunk);
    });
    child.stdin.on("error", () => {
      // The child may exit before reading all of its input; its exit status reports the failure.
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ kind: "start", message: error.code ?? error.message });
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      if (stopped === "stdout" || stopped === "stderr") finish({ kind: "output", stream: stopped });
      else if (stopped === "timeout") finish({ kind: "timeout", stdout: out, stderr: err });
      else if (stopped === "aborted") finish({ kind: "aborted", stdout: out, stderr: err });
      else finish({ kind: "exited", code, signal, stdout: out, stderr: err });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/**
 * Runs `program` with `args` and resolves with its exit status and output. Rejects with a
 * ProgramError when it cannot start, times out, is aborted or writes more than the cap.
 */
export async function runProgram(program: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const outcome = await runProgramSettled(program, args, options);
  const what = `${program} ${args[0] ?? ""}`;
  switch (outcome.kind) {
    case "exited":
      return { code: outcome.code, signal: outcome.signal, stdout: outcome.stdout, stderr: outcome.stderr };
    case "start":
      throw new ProgramError(program, `${program} could not start: ${outcome.message}`, null, "");
    case "timeout":
      throw new ProgramError(program, `${what} timed out after ${options.timeoutMs} ms`, null, "");
    case "aborted":
      throw new ProgramError(program, `${what} was cancelled`, null, "");
    case "output":
      throw new ProgramError(
        program,
        `${what} wrote more than ${options.maxOutputBytes} bytes${outcome.stream === "stderr" ? " to stderr" : ""}`,
        null,
        "",
      );
    default: {
      const unreachable: never = outcome;
      throw new TypeError(`unknown run outcome ${JSON.stringify(unreachable)}`);
    }
  }
}
