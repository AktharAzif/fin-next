// Starting external programs (spec 07 §2.1): spawn with shell: false, an argument array, a
// timeout and an output cap. Callers validate every value they place in an argument first.
//
// A program named without a path is looked up in the PATH of the environment it is given, in
// absolute directories only and never in or below the working directory, so a file planted in a
// reviewed tree cannot stand in for git (Windows would otherwise search the working directory
// before PATH). "In or below" is decided on the disk, not by spelling: by canonical paths (links
// resolved and, where the disk ignores case, its own spelling), and by device and inode up the
// directory's folders, so neither another case nor another path to the tree hides it. On POSIX
// systems each child leads its own process group: a timeout or the output
// cap kills the whole group, so a grandchild that inherited the output pipes (git's lazy fetch,
// say) can neither keep the call waiting nor outlive it, and the call settles once the child has
// exited. If the engine itself is interrupted while children run, their groups go with it.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
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
  /** Kill the child (SIGKILL, with its process group) after this many milliseconds. */
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
const WINDOWS = process.platform === "win32";
/** On POSIX systems a child leads its own process group, which a kill takes whole. */
const PROCESS_GROUPS = !WINDOWS;
/** After a kill, how long to wait for the child's exit before settling anyway. */
const KILL_GRACE_MS = 2_000;
/** The signals that, arriving while children run, take their process groups with the engine. */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The process groups of the children running now. */
const runningGroups = new Set<number>();
let handlersInstalled = false;

function killGroup(pid: number): boolean {
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    return false; // the group has no member left
  }
}

function killRunningGroups(): void {
  for (const pid of runningGroups) killGroup(pid);
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
function canonicalPath(path: string): string {
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

/** The working directory a program must not come from: its canonical path and its identity on the disk. */
interface Tree {
  readonly root: string;
  readonly identity: FileIdentity | null;
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
    if (
      identity !== null &&
      identity.dev === tree.identity.dev &&
      identity.ino === tree.identity.ino
    )
      return true;
    if (dirname(current) === current) return false;
  }
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
export function resolveProgram(
  program: string,
  env: Readonly<Record<string, string>>,
  cwd: string,
): string | null {
  if (isAbsolute(program)) return isExecutableFile(program) ? program : null;
  if (program.includes("/") || program.includes("\\")) return null;
  const root = canonicalPath(cwd);
  const tree: Tree = { root, identity: identityOf(root) };
  const names =
    WINDOWS && !/\.(?:exe|com)$/i.test(program) ? [`${program}.exe`, `${program}.com`] : [program];
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

/**
 * Runs `program` with `args` and resolves with its exit status and output. Rejects with a
 * ProgramError when it cannot start, times out or writes more than the cap; the call settles
 * within the timeout and a short grace period whatever the program's own children do.
 */
export function runProgram(
  program: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  if (!PROGRAM_RE.test(program))
    return Promise.reject(new TypeError(`refusing to run program ${JSON.stringify(program)}`));
  for (const arg of args) {
    if (typeof arg !== "string" || arg.includes("\0")) {
      return Promise.reject(
        new TypeError("refusing an argument that is not a string or holds a NUL byte"),
      );
    }
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(new TypeError("timeoutMs must be a positive integer"));
  }
  if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
    return Promise.reject(new TypeError("maxOutputBytes must be a positive integer"));
  }
  const executable = resolveProgram(program, options.env, options.cwd);
  if (executable === null) {
    return Promise.reject(
      new ProgramError(program, `${program} could not start: not found on PATH`, null, ""),
    );
  }
  return new Promise((resolvePromise, reject) => {
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
      reject(
        new ProgramError(
          program,
          `${program} could not start: ${(error as Error).message}`,
          null,
          "",
        ),
      );
      return;
    }
    const group = PROCESS_GROUPS && typeof child.pid === "number" ? child.pid : null;
    if (group !== null) trackGroup(group);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: ProgramError | null = null;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      if (group !== null) untrackGroup(group);
      // A grandchild may still hold the pipes' other ends; stop reading them.
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      if (failure !== null) reject(failure);
      else
        resolvePromise({
          code,
          signal,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
    };

    const fail = (error: ProgramError): void => {
      if (settled || failure !== null) return;
      failure = error;
      if (group === null || !killGroup(group)) child.kill("SIGKILL");
      if (child.exitCode !== null || child.signalCode !== null)
        settle(child.exitCode, child.signalCode);
      else graceTimer = setTimeout(() => settle(null, "SIGKILL"), KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      fail(
        new ProgramError(
          program,
          `${program} ${args[0] ?? ""} timed out after ${options.timeoutMs} ms`,
          null,
          "",
        ),
      );
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxOutputBytes) {
        fail(
          new ProgramError(
            program,
            `${program} ${args[0] ?? ""} wrote more than ${options.maxOutputBytes} bytes`,
            null,
            "",
          ),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.maxOutputBytes) {
        fail(
          new ProgramError(
            program,
            `${program} ${args[0] ?? ""} wrote more than ${options.maxOutputBytes} bytes to stderr`,
            null,
            "",
          ),
        );
        return;
      }
      stderr.push(chunk);
    });
    child.stdin.on("error", () => {
      // The child may exit before reading all of its input; its exit status reports the failure.
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled || failure !== null) return; // after a kill, the exit or the grace period settles
      failure = new ProgramError(
        program,
        `${program} could not start: ${error.code ?? error.message}`,
        null,
        "",
      );
      settle(null, null);
    });
    // After a kill the call settles on exit: the pipes may stay open in a grandchild that
    // escaped the group. Otherwise it waits for the pipes to close, so the output is complete.
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (failure !== null) settle(code, signal);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      settle(code, signal);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
