// Test helpers: a Fin process run as a child whose stdout's reader goes away, as when the
// container's log collector stops reading, and the guard that no process a test starts outlives
// its test. Imported only by *.test.ts files (here and in the apps built on @fin/server).
//
// Every child started here leads its own process group (`detached`), so what it starts in turn
// (the connector's cloudflared, say) is in that group too. A test file that starts children ends
// them with endTestProcesses() in afterEach and afterAll: SIGTERM to each whole group, SIGKILL to
// what is left after a short grace, whatever state the test ended in; then it fails, naming the
// pid, if a process the test started, or a script it wrote that recorded its pid, still runs. A
// runner killed outright runs neither hook, so every script a test writes also starts with
// exitWithParent(): it ends itself once its parent is gone.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

const POSIX = process.platform !== "win32";
/** How long a group has after SIGTERM before what is left of it is sent SIGKILL. */
const GROUP_GRACE_MS = 1_000;
/** How long an ended process has to be gone (reaped) before it counts as having outlived its test. */
const GONE_WITHIN_MS = 2_000;

/** The leaders of the process groups this file's tests started, not yet ended. */
const groups = new Set<number>();
/** The children this file's tests started, each of which must be gone after its test. */
const started = new Set<number>();
/** The directories in which scripts this file's tests wrote record their pids (recordPid). */
const pidDirs = new Set<string>();

function isPid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

/** Sends `name` to `target` (a pid, or a group as its negated leader); false when none is left. */
function send(target: number, name: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target, name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `pid` is a process still running: not gone, not a zombie waiting to be reaped (Linux
 * says which in /proc; elsewhere a zombie counts until it is reaped, which takes a moment), and
 * not a number since given to another user's process (EPERM), no longer the one a test started.
 */
export function isRunning(pid: number): boolean {
  if (!isPid(pid) || !send(pid, 0)) return false;
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
  } catch {
    return false;
  }
}

async function until(done: () => boolean, ms: number): Promise<void> {
  const end = performance.now() + ms;
  while (!done() && performance.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Records a child started with `detached: true`: endTestProcesses ends its whole group. */
export function trackGroup(pid: number | undefined): void {
  if (!isPid(pid)) return;
  groups.add(pid);
  started.add(pid);
}

/** Records a directory of recordPid's files: each must name a process gone after the test. */
export function watchPidDir(dir: string): void {
  pidDirs.add(dir);
}

/**
 * A statement for a script a test writes (CommonJS): it records the script's pid in `dir`, as an
 * empty file named by the pid, so a reader never sees half of one.
 */
export function recordPid(dir: string): string {
  const file = `require("node:path").join(${JSON.stringify(dir)}, String(process.pid))`;
  return `require("node:fs").writeFileSync(${file}, "");`;
}

/**
 * The first statement of every script a test writes: once its parent is gone it ends itself, and
 * the process group it leads if it leads one (SIGKILL, which nothing in them can delay), checked
 * every 250 ms by a timer that never holds the process open on its own. Given the parent's pid it
 * compares against that, so a parent that died while the script was still loading counts too;
 * without one it takes the parent it starts with and also counts being adopted by init (ppid 1).
 */
export function exitWithParent(parent?: number): string {
  const start = parent === undefined ? "const parent = process.ppid; " : "";
  const gone =
    parent === undefined
      ? "process.ppid !== parent || process.ppid === 1"
      : `process.ppid !== ${parent}`;
  const end = `try { process.kill(-process.pid, "SIGKILL"); } catch {} process.kill(process.pid, "SIGKILL");`;
  return `{ ${start}setInterval(() => { if (${gone}) { ${end} } }, 250).unref(); }`;
}

function pidsIn(dir: string): number[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => /^\d+$/.test(name)).map(Number);
}

/**
 * Ends every process group this file's tests started (SIGTERM to the group, SIGKILL after a short
 * grace), then fails naming each pid, ending it too, if a process a test started or a script it
 * wrote recorded still runs. For afterEach and afterAll.
 */
export async function endTestProcesses(): Promise<void> {
  const leaders = [...groups];
  groups.clear();
  const group = (pid: number): number => (POSIX ? -pid : pid);
  for (const pid of leaders) send(group(pid), "SIGTERM");
  await until(() => leaders.every((pid) => !send(group(pid), 0)), GROUP_GRACE_MS);
  for (const pid of leaders) send(group(pid), "SIGKILL");
  const pids = [...new Set([...started, ...[...pidDirs].flatMap(pidsIn)])].filter(isPid);
  started.clear();
  pidDirs.clear();
  await until(() => !pids.some(isRunning), GONE_WITHIN_MS);
  const outlived = pids.filter(isRunning);
  for (const pid of outlived) send(pid, "SIGKILL");
  if (outlived.length > 0) {
    throw new Error(`a process outlived its test: pid ${outlived.join(", ")}`);
  }
}

/**
 * Starts `node <script>` with only `env`, leading its own process group (trackGroup), waits for
 * its first line on stdout, then closes the pipe's read end, so every write the child makes to
 * stdout from then on fails (EPIPE).
 */
export async function spawnThenCloseStdout(
  script: string,
  env: Readonly<Record<string, string>>,
  firstLineMs = 15_000,
): Promise<ClosedStdoutChild> {
  const child = spawn(process.execPath, [script], {
    env: { ...env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: POSIX,
  });
  trackGroup(child.pid);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | NodeJS.Signals>((resolve) => {
    child.once("exit", (code, signal) => resolve(code ?? signal ?? "SIGKILL"));
  });
  // The child and whatever it started, at once.
  const killGroup = (): void => {
    if (child.pid === undefined || !send(POSIX ? -child.pid : child.pid, "SIGKILL")) {
      child.kill("SIGKILL");
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the child wrote no line")), firstLineMs);
      child.stdout.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
      void exited.then((end) => {
        clearTimeout(timer);
        reject(
          new Error(`the child ended (${end}) before its first line: ${stderr.slice(0, 500)}`),
        );
      });
    });
  } catch (error) {
    // A child that has not started as expected is not left running.
    killGroup();
    throw error;
  }
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
        killGroup();
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
