// Starting external programs (spec 07 §2.1): spawn with shell: false, an argument array, a
// timeout and an output cap. Callers validate every value they place in an argument first.
//
// A program named without a path is looked up in the PATH of the environment it is given, in
// absolute directories only and never in or below the working directory, so a file planted in a
// reviewed tree cannot stand in for git (Windows would otherwise search the working directory
// before PATH). "In or below" is decided on the disk, not by spelling: by canonical paths (links
// resolved and, where the disk ignores case, its own spelling), and by device and inode up the
// directory's folders, so neither another case nor another path to the tree hides it.
//
// On POSIX systems each child leads its own process group. A timeout, an abort or the output cap
// stops the whole group: SIGTERM first when the caller gives a grace period (a session gets 10 s,
// spec 07 §4.1), then SIGKILL. A grandchild that inherited the output pipes (git's lazy fetch, say)
// can neither keep the call waiting nor outlive it: once stopped, the call settles on the child's
// exit, or a short while after the SIGKILL if even that never comes, and whatever is left of the
// group is killed. If the engine itself is interrupted while children run, their groups go with it.

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { ProgramError } from "./errors.ts";

export interface RunOptions {
  /** The working directory. It is never searched for the program. */
  readonly cwd: string;
  /** The whole environment of the child; nothing is inherited implicitly. */
  readonly env: Readonly<Record<string, string>>;
  /** Bytes written to the child's stdin, which is then closed. */
  readonly input?: Uint8Array;
  /** Stop the child, with its process group, after this many milliseconds. */
  readonly timeoutMs: number;
  /** Kill the child when stdout or stderr grows past this many bytes. */
  readonly maxOutputBytes: number;
  /**
   * On timeout or abort, send SIGTERM and wait this long before SIGKILL (spec 07 §4.1: 10 s for a
   * session). Absent or 0: SIGKILL at once. The output cap always kills at once.
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
const WINDOWS = process.platform === "win32";
/** On POSIX systems a child leads its own process group, which a kill takes whole. */
const PROCESS_GROUPS = !WINDOWS;
/** After the SIGKILL, how long to wait for the child's exit before settling anyway. */
const SETTLE_GRACE_MS = 2_000;
/** The signals that, arriving while children run, take their process groups with the engine. */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The process groups of the children running now. */
const runningGroups = new Set<number>();
let handlersInstalled = false;

/** Sends `signal` to the process group `pid` leads; false when the group has no member left. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function killRunningGroups(): void {
  for (const pid of runningGroups) signalGroup(pid, "SIGKILL");
  runningGroups.clear();
}

function onEngineSignal(signal: NodeJS.Signals): void {
  killRunningGroups();
  removeHandlers();
  // With no other listener left, the signal's default action ends the process, as it would have
  // had no handler been installed; a host with its own listener handles the signal itself.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const signal of FORWARDED_SIGNALS) process.on(signal, onEngineSignal);
  process.on("exit", killRunningGroups);
}

function removeHandlers(): void {
  if (!handlersInstalled) return;
  handlersInstalled = false;
  for (const signal of FORWARDED_SIGNALS) process.removeListener(signal, onEngineSignal);
  process.removeListener("exit", killRunningGroups);
}

function trackGroup(pid: number): void {
  runningGroups.add(pid);
  installHandlers();
}

function untrackGroup(pid: number): void {
  runningGroups.delete(pid);
  if (runningGroups.size === 0) removeHandlers();
}

/**
 * `path` with every link resolved and, on a disk that ignores case, in the disk's own spelling
 * (the native realpath reports it; Node's own does not); resolved by name when it does not exist.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  }
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** The device and inode of `path`, or null when it cannot be read or has no usable inode. */
function identityOf(path: string): FileIdentity | null {
  try {
    const stats = statSync(path, { bigint: true });
    return stats.ino === 0n ? null : { dev: stats.dev, ino: stats.ino };
  } catch {
    return null;
  }
}

/** A directory a path must not lie in or below: its canonical path and its identity on the disk. */
interface Tree {
  readonly root: string;
  readonly identity: FileIdentity | null;
}

function treeOf(dir: string): Tree {
  const root = canonicalPath(dir);
  return { root, identity: identityOf(root) };
}

/** True when `dir` is the tree or a folder below it. */
function insideTree(dir: string, tree: Tree): boolean {
  const real = canonicalPath(dir);
  const below = tree.root.endsWith(sep) ? tree.root : `${tree.root}${sep}`;
  if (real === tree.root || real.startsWith(below)) return true;
  if (tree.identity === null) return false;
  // `real` has no link left in it, so its folders are the directory's own ancestors.
  for (let current = real; ; current = dirname(current)) {
    const identity = identityOf(current);
    if (identity !== null && identity.dev === tree.identity.dev && identity.ino === tree.identity.ino) return true;
    if (dirname(current) === current) return false;
  }
}

/**
 * True when the existing directory `dir` is `root` or lies below it, decided on the disk as for the
 * program lookup: canonical paths first, then device and inode up `dir`'s folders, so neither
 * another spelling of a case-insensitive disk nor a link hides it.
 */
export function isInsideOnDisk(dir: string, root: string): boolean {
  return insideTree(dir, treeOf(root));
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (!WINDOWS) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathVariable(env: Readonly<Record<string, string>>): string {
  if (!WINDOWS) return env["PATH"] ?? "";
  for (const [name, value] of Object.entries(env)) if (name.toUpperCase() === "PATH") return value;
  return "";
}

/**
 * The absolute file `program` runs from, or null when there is none. An absolute program is used
 * as given; a bare name is looked up in the PATH of `env`, skipping every entry that is not an
 * absolute directory and every directory that is `cwd` or lies below it, however either is
 * spelled; a relative path is refused, because it would resolve against `cwd`.
 */
export function resolveProgram(program: string, env: Readonly<Record<string, string>>, cwd: string): string | null {
  if (isAbsolute(program)) return isExecutableFile(program) ? program : null;
  if (program.includes("/") || program.includes("\\")) return null;
  const tree = treeOf(cwd);
  const names = WINDOWS && !/\.(?:exe|com)$/i.test(program) ? [`${program}.exe`, `${program}.com`] : [program];
  for (const dir of pathVariable(env).split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (!isExecutableFile(candidate)) continue;
      if (insideTree(dir, tree)) break;
      return candidate;
    }
  }
  return null;
}

function checkRequest(program: string, args: readonly string[], options: RunOptions): TypeError | null {
  if (!PROGRAM_RE.test(program)) return new TypeError(`refusing to run program ${JSON.stringify(program)}`);
  for (const arg of args) {
    if (typeof arg !== "string" || arg.includes("\0")) return new TypeError("refusing an argument that is not a string or holds a NUL byte");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) return new TypeError("timeoutMs must be a positive integer");
  if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) return new TypeError("maxOutputBytes must be a positive integer");
  const grace = options.killGraceMs ?? 0;
  if (!Number.isInteger(grace) || grace < 0) return new TypeError("killGraceMs must be a non-negative integer");
  return null;
}

type StopReason = "timeout" | "aborted" | "stdout" | "stderr";

/**
 * Runs `program` with `args` and resolves with how it ended. Never rejects for the program's own
 * behaviour (one that cannot be found or started resolves as `start`); rejects with TypeError only
 * for a request it refuses. The call settles within the timeout, the grace period and a short wait
 * after the SIGKILL, whatever the program's own children do.
 */
export function runProgramSettled(program: string, args: readonly string[], options: RunOptions): Promise<RunOutcome> {
  const refused = checkRequest(program, args, options);
  if (refused !== null) return Promise.reject(refused);
  const executable = resolveProgram(program, options.env, options.cwd);
  if (executable === null) {
    return Promise.resolve({ kind: "start", message: isAbsolute(program) ? "not an executable file" : "not found on PATH" });
  }
  return new Promise((resolvePromise) => {
    if (options.signal?.aborted === true) {
      resolvePromise({ kind: "aborted", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: { ...options.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: PROCESS_GROUPS,
      });
    } catch (error) {
      resolvePromise({ kind: "start", message: (error as Error).message });
      return;
    }
    const group = PROCESS_GROUPS && typeof child.pid === "number" ? child.pid : null;
    if (group !== null) trackGroup(group);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stopped: StopReason | null = null;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const grace = options.killGraceMs ?? 0;

    const signalChild = (signal: NodeJS.Signals): void => {
      if (group !== null && signalGroup(group, signal)) return;
      child.kill(signal);
    };
    const outcomeOf = (code: number | null, signal: NodeJS.Signals | null): RunOutcome => {
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      if (stopped === "stdout" || stopped === "stderr") return { kind: "output", stream: stopped };
      if (stopped === "timeout") return { kind: "timeout", stdout: out, stderr: err };
      if (stopped === "aborted") return { kind: "aborted", stdout: out, stderr: err };
      return { kind: "exited", code, signal, stdout: out, stderr: err };
    };
    const finish = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (settleTimer !== null) clearTimeout(settleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (group !== null) {
        // A stopped child's group goes with the call, even a member that survived its SIGTERM.
        if (stopped !== null) signalGroup(group, "SIGKILL");
        untrackGroup(group);
      }
      // A grandchild may still hold the pipes' other ends; stop reading them.
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      resolvePromise(outcome);
    };
    const kill = (): void => {
      signalChild("SIGKILL");
      if (child.exitCode !== null || child.signalCode !== null) finish(outcomeOf(child.exitCode, child.signalCode));
      else settleTimer = setTimeout(() => finish(outcomeOf(null, "SIGKILL")), SETTLE_GRACE_MS);
    };
    const stop = (why: StopReason): void => {
      if (settled || stopped !== null) return;
      stopped = why;
      if (why === "stdout" || why === "stderr" || grace === 0) {
        kill();
        return;
      }
      signalChild("SIGTERM");
      killTimer = setTimeout(kill, grace);
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    const onAbort = (): void => stop("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });

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
      if (settled || stopped !== null) return; // after a stop, the exit or the settle timer ends the call
      finish({ kind: "start", message: error.code ?? error.message });
    });
    // After a stop the call settles on exit: the pipes may stay open in a grandchild that escaped
    // the group. Otherwise it waits for the pipes to close, so the output is complete.
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (stopped !== null) finish(outcomeOf(code, signal));
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      finish(outcomeOf(code, signal));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/**
 * Runs `program` with `args` and resolves with its exit status and output. Rejects with a
 * ProgramError when it cannot be found or started, times out, is aborted or writes more than the
 * cap; the call settles within the timeout and a short grace period whatever the program's own
 * children do.
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
      throw new ProgramError(program, `${what} wrote more than ${options.maxOutputBytes} bytes${outcome.stream === "stderr" ? " to stderr" : ""}`, null, "");
    default: {
      const unreachable: never = outcome;
      throw new TypeError(`unknown run outcome ${JSON.stringify(unreachable)}`);
    }
  }
}
