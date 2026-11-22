// What a run gets from the outside world, injected so tests replace every part (AGENTS.md §2: no
// module-scope clock, randomness or connection). main.ts builds the real one.

import { execFileSync, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { Env } from "./credentials.ts";
import { EXIT, type ExitCode } from "./errors.ts";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The signals that stop a run: Ctrl-C (SIGINT), a polite kill such as a CI cancel (SIGTERM), a
 * closed terminal, a dropped SSH session or a killed tmux pane (SIGHUP), and Ctrl-\ (SIGQUIT), which
 * asks to quit at once.
 */
export type InterruptSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT";

export const INTERRUPT_SIGNALS: readonly InterruptSignal[] = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGQUIT",
];

/**
 * What stops a run from outside: a signal, its standard output or error closing under it (a
 * reader that went away, as `| head` does), or an error nothing caught.
 */
export type StopCause = InterruptSignal | "output-closed" | "uncaught-error";

/** The exit code a run ends with when it was stopped: 128 + the signal's number, or 70. */
export const STOP_EXIT: Readonly<Record<StopCause, ExitCode>> = {
  SIGHUP: EXIT.hangup,
  SIGINT: EXIT.interrupted,
  SIGQUIT: EXIT.quit,
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

/**
 * How long the clean-up after a stop may take; then the run is closed at once (closeNow) and the
 * process exits.
 */
export const INTERRUPT_DEADLINE_MS = 5_000;

/**
 * A signal repeated within this time of the first stop is part of that stop, and is ignored: a
 * closing terminal can deliver SIGHUP more than once, and Ctrl-C pressed twice is a reflex.
 */
export const REPEAT_GRACE_MS = 1_000;

/**
 * Why a run is closed at once, without waiting for the change in flight: a signal that insists (a
 * SIGINT or SIGTERM after REPEAT_GRACE_MS, or SIGQUIT at any time), or the clean-up's deadline.
 */
export type ForcedClose = InterruptSignal | "deadline";

/** What a trapped run does when something stops it. */
export interface StopHandlers {
  /**
   * Closes the run after a stop (it may wait for the change in flight to settle); the process
   * exits once it settles, or at INTERRUPT_DEADLINE_MS.
   */
  readonly stop: (cause: StopCause) => Promise<void>;
  /**
   * Closes the run at once, synchronously (run.done naming the change in flight, the lock
   * released), just before the process exits without waiting. What it throws is ignored.
   */
  readonly closeNow: (why: ForcedClose) => void;
}

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
   * Runs one of the repository's own Node programs as a child process, with an IPC channel and
   * nothing else: no argument, an empty environment, no inherited Node flags. Whatever it needs
   * comes over the channel, so nothing private is ever in its argv or its environment.
   */
  readonly node: (script: string, events: NodeChildEvents) => NodeChild;
  /**
   * Calls the handlers when something stops the run (SIGINT, SIGTERM, SIGHUP or SIGQUIT; with the
   * process guards, a closed standard output or error, or an uncaught error), until the returned
   * function is called. The real runtime calls stop() and exits with STOP_EXIT once it has
   * settled. It calls closeNow() and exits at once on SIGQUIT, on a SIGINT or SIGTERM that comes
   * REPEAT_GRACE_MS or more after the first stop, and at INTERRUPT_DEADLINE_MS. It ignores a
   * repeated SIGHUP, any signal repeated within REPEAT_GRACE_MS, and a second closed stream or
   * uncaught error.
   */
  readonly trap: (handlers: StopHandlers) => () => void;
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

/** What a Node child process tells its parent. */
export interface NodeChildEvents {
  /** One message over the IPC channel. */
  message(message: unknown): void;
  /** Text the child wrote to its standard output or error (it should write none). */
  output(stream: "stdout" | "stderr", text: string): void;
}

export interface NodeExit {
  code: number | null;
  signal: string | null;
}

export interface NodeChild {
  /** Sends one message over the IPC channel; false once the channel is closed. */
  send(message: unknown): boolean;
  /** Ends the child (SIGTERM) while it runs. */
  kill(): void;
  /** Settles once the child has exited and its output has been read; never rejects. */
  readonly exited: Promise<NodeExit>;
}

/**
 * The real runtime's `node`: `script` run by this Node (fork), with standard input closed, its
 * output read as text, the IPC channel in JSON, an empty environment and no inherited Node flags.
 */
export function runNodeChild(script: string, events: NodeChildEvents): NodeChild {
  const child = fork(script, [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {},
    execArgv: [],
    serialization: "json",
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (text: string) => events.output("stdout", text));
  child.stderr?.on("data", (text: string) => events.output("stderr", text));
  child.on("message", (message) => events.message(message));
  // A child that could not start reports an error and then closes.
  child.on("error", () => undefined);
  const closed = new Promise<NodeExit>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  // Every message is delivered before the channel closes: wait for both.
  const disconnected = new Promise<void>((resolve) => {
    if (!child.connected) resolve();
    else child.once("disconnect", () => resolve());
  });
  const exited = Promise.all([closed, disconnected]).then(([exit]) => exit);
  return {
    send: (message) => {
      if (!child.connected) return false;
      try {
        return child.send(message as Parameters<typeof child.send>[0], () => undefined);
      } catch {
        return false;
      }
    },
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
    exited,
  };
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
    node: runNodeChild,
    trap: (handlers) => {
      // When the first stop came (a monotonic clock, for the repeat rule), once one did.
      let firstAt: number | undefined;
      let exiting = false;
      const exit = (code: ExitCode): void => {
        if (exiting) return;
        exiting = true;
        process.exit(code);
      };
      // Closes the run synchronously, then exits at once: the record and the lock come first.
      const exitNow = (why: ForcedClose, code: ExitCode): void => {
        if (exiting) return;
        try {
          handlers.closeNow(why);
        } catch {
          // The exit stays immediate.
        }
        exit(code);
      };
      const stop = (cause: StopCause): void => {
        const code = STOP_EXIT[cause];
        if (firstAt !== undefined) {
          // A repeat while the run is being closed. A hangup is often delivered more than once,
          // and a signal within the grace is a reflex: both are part of the first stop. A second
          // error (a closed stream written to again) waits for it too. A later Ctrl-C or SIGTERM,
          // and SIGQUIT, insist.
          if (cause === "SIGQUIT") exitNow(cause, code);
          else if (
            (cause === "SIGINT" || cause === "SIGTERM") &&
            performance.now() - firstAt >= REPEAT_GRACE_MS
          ) {
            exitNow(cause, code);
          }
          return;
        }
        firstAt = performance.now();
        if (cause === "SIGQUIT") {
          exitNow(cause, code);
          return;
        }
        // Not unref'd: the deadline holds the process open until it fires or the stop settles.
        const deadline = setTimeout(() => exitNow("deadline", code), INTERRUPT_DEADLINE_MS);
        Promise.resolve()
          .then(() => handlers.stop(cause))
          .catch(() => undefined)
          .finally(() => {
            clearTimeout(deadline);
            exit(code);
          });
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
