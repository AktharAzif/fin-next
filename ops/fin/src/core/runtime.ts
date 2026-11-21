// What a run gets from the outside world, injected so tests replace every part (AGENTS.md §2: no
// module-scope clock, randomness or connection). main.ts builds the real one.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { Env } from "./credentials.ts";
import { EXIT, type ExitCode } from "./errors.ts";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The signals that stop a run: Ctrl-C (SIGINT), a polite kill such as a CI cancel (SIGTERM), and a
 * closed terminal, a dropped SSH session or a killed tmux pane (SIGHUP).
 */
export type InterruptSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export const INTERRUPT_SIGNALS: readonly InterruptSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * What stops a run from outside: a signal, its standard output or error closing under it (a
 * reader that went away, as `| head` does), or an error nothing caught.
 */
export type StopCause = InterruptSignal | "output-closed" | "uncaught-error";

/** The exit code a run ends with when it was stopped: 128 + the signal's number, or 70. */
export const STOP_EXIT: Readonly<Record<StopCause, ExitCode>> = {
  SIGHUP: EXIT.hangup,
  SIGINT: EXIT.interrupted,
  SIGTERM: EXIT.terminated,
  "output-closed": EXIT.internal,
  "uncaught-error": EXIT.internal,
};

/** What a stop is called in messages and in run.done's `error`. */
export function stopDescription(cause: StopCause): string {
  if (cause === "output-closed") return "standard output or error closed";
  if (cause === "uncaught-error") return "an uncaught error";
  return `interrupted by ${cause}`;
}

/** How long the clean-up after a stop may take before the process exits anyway. */
export const INTERRUPT_DEADLINE_MS = 5_000;

/**
 * How long a stop waits for the change in flight to settle before it closes the run without it
 * (leaving time within INTERRUPT_DEADLINE_MS to write run.done and ship the lines).
 */
export const INTERRUPT_SETTLE_MS = 3_000;

export interface Runtime {
  readonly env: Env;
  /** The repository's root (ops/environments, docs/runbooks and the apps live under it). */
  readonly repoRoot: string;
  readonly now: () => Date;
  readonly random: (bytes: number) => Uint8Array;
  readonly fetch: FetchFn;
  readonly sleep: (ms: number) => Promise<void>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** The OS user running the command (written to the local run log only). */
  readonly operator: () => string;
  /** The commit the running code came from, or undefined outside a git checkout. */
  readonly commit: () => string | undefined;
  /**
   * Whether the checkout has local changes (tracked or untracked files that differ from the
   * commit), so the commit alone does not say what ran; undefined outside a git checkout.
   */
  readonly dirty: () => boolean | undefined;
  /** Runs a program with arguments (no shell) and returns its exit status and output. */
  readonly exec: (program: string, args: readonly string[]) => ExecResult;
  /**
   * Calls the handler when something stops the run (SIGINT, SIGTERM or SIGHUP; with the process
   * guards, a closed standard output or error, or an uncaught error), until the returned function
   * is called. The real runtime then exits with STOP_EXIT once the handler has settled, or after
   * INTERRUPT_DEADLINE_MS; a second signal exits at once.
   */
  readonly trap: (handler: (cause: StopCause) => Promise<void>) => () => void;
}

export interface ProcessRuntimeOptions {
  /**
   * Install the process-wide guards (main.ts does): an error on standard output or error (EPIPE
   * when the reader went away), an uncaught exception and an unhandled rejection stop printing to
   * a closed stream and stop the run like a signal (the trap's handler closes it), then exit 70
   * with a fixed message. Outside a trapped run they print the fixed message and exit 70.
   */
  guardProcess?: boolean;
}

const FATAL_MESSAGES: Readonly<Record<"output-closed" | "uncaught-error", string>> = {
  "output-closed": "error: standard output or error closed; the command stopped\n",
  "uncaught-error":
    "error: internal error (an uncaught error; its text is not printed, since it has not been through the masker)\n",
};

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The directory that holds the local run log and the run lock (until the R2 vault exists). */
export function stateDir(env: Env): string {
  const explicit = env.FIN_STATE_DIR;
  if (explicit !== undefined && explicit !== "") return explicit;
  const base = env.XDG_STATE_HOME;
  return join(
    base !== undefined && base !== "" ? base : join(homedir(), ".local", "state"),
    "fin-next",
  );
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** The real runtime, for main.ts (which passes guardProcess). */
export function processRuntime(repoRoot: string, options: ProcessRuntimeOptions = {}): Runtime {
  const streams = { stdout: process.stdout, stderr: process.stderr };
  const closed = { stdout: false, stderr: false };
  // The trapped run's stop, while a run holds the lock; the guards call it.
  let stopRun: ((cause: StopCause) => void) | undefined;
  function fatal(cause: "output-closed" | "uncaught-error"): void {
    if (stopRun !== undefined) {
      stopRun(cause);
      return;
    }
    write("stderr", FATAL_MESSAGES[cause]);
    process.exit(STOP_EXIT[cause]);
  }
  // Nothing is written to a stream that has closed: the run goes on being closed without it.
  function write(stream: "stdout" | "stderr", text: string): void {
    if (closed[stream]) return;
    try {
      streams[stream].write(text);
    } catch {
      closed[stream] = true;
      fatal("output-closed");
    }
  }
  if (options.guardProcess === true) {
    for (const stream of ["stdout", "stderr"] as const) {
      streams[stream].on("error", () => {
        if (closed[stream]) return;
        closed[stream] = true;
        fatal("output-closed");
      });
    }
    process.on("uncaughtException", () => fatal("uncaught-error"));
    process.on("unhandledRejection", () => fatal("uncaught-error"));
  }
  return {
    env: process.env,
    repoRoot,
    now: () => new Date(),
    random: (bytes) => new Uint8Array(randomBytes(bytes)),
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stdout: (text) => write("stdout", text),
    stderr: (text) => write("stderr", text),
    operator: () => {
      try {
        return userInfo().username;
      } catch {
        return "unknown";
      }
    },
    commit: () => {
      try {
        const sha = git(repoRoot, ["rev-parse", "HEAD"]).trim();
        return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
      } catch {
        return undefined;
      }
    },
    dirty: () => {
      try {
        return git(repoRoot, ["status", "--porcelain", "--untracked-files=normal"]).trim() !== "";
      } catch {
        return undefined;
      }
    },
    exec: (program, args) => {
      try {
        const stdout = execFileSync(program, [...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 16 * 1024 * 1024,
        });
        return { status: 0, stdout, stderr: "" };
      } catch (error) {
        const e = error as { status?: number | null; stdout?: string; stderr?: string };
        return { status: e.status ?? null, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    },
    trap: (handler) => {
      let stopping = false;
      const stop = (cause: StopCause): void => {
        const code = STOP_EXIT[cause];
        if (stopping) {
          // A second signal while the run is being closed: the operator insists. A second error
          // (a closed stream written to again) waits for the first stop to finish.
          if (isSignal(cause)) process.exit(code);
          return;
        }
        stopping = true;
        const deadline = new Promise<void>((resolve) => {
          setTimeout(resolve, INTERRUPT_DEADLINE_MS).unref();
        });
        const closing = Promise.resolve()
          .then(() => handler(cause))
          .catch(() => undefined);
        Promise.race([closing, deadline]).finally(() => process.exit(code));
      };
      const onSignal = (signal: NodeJS.Signals): void => {
        if (isSignal(signal)) stop(signal);
      };
      for (const signal of INTERRUPT_SIGNALS) process.on(signal, onSignal);
      stopRun = stop;
      return () => {
        for (const signal of INTERRUPT_SIGNALS) process.off(signal, onSignal);
        if (stopRun === stop) stopRun = undefined;
      };
    },
  };
}

function isSignal(cause: string): cause is InterruptSignal {
  return (INTERRUPT_SIGNALS as readonly string[]).includes(cause);
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** A sortable run ID, `run_` and 26 Crockford base32 characters (spec 08 §7.2's `run_...`). */
export function newRunId(runtime: Pick<Runtime, "now" | "random">): string {
  let time = runtime.now().getTime();
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = (CROCKFORD[time % 32] ?? "0") + head;
    time = Math.floor(time / 32);
  }
  const bytes = runtime.random(16);
  let tail = "";
  for (let i = 0; i < 16; i++) tail += CROCKFORD[(bytes[i] ?? 0) % 32];
  return `run_${head}${tail}`;
}
