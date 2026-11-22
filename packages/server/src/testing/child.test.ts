// The guard that no process a test starts outlives its test (child.ts): the group kill after each
// test, the check that fails naming a pid that still runs, and the exit with the parent.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  endTestProcesses,
  exitWithParent,
  isRunning,
  recordPid,
  trackGroup,
  watchPidDir,
} from "./child.ts";

afterEach(() => endTestProcesses());

function pidsDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "fin-child-guard-")), "pids");
  mkdirSync(dir);
  return dir;
}

/** The pids recorded in `dir`, once there are `count` of them (within 10 s). */
async function recorded(dir: string, count: number): Promise<number[]> {
  const end = performance.now() + 10_000;
  let pids: number[] = [];
  while (pids.length < count && performance.now() < end) {
    pids = readdirSync(dir).map(Number);
    if (pids.length < count) await new Promise((r) => setTimeout(r, 10));
  }
  return pids;
}

function ended(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

describe("endTestProcesses", () => {
  it("ends a tracked group whole, though each of its processes ignores SIGTERM", async () => {
    const dir = pidsDir();
    watchPidDir(dir);
    const deaf = `process.on("SIGTERM", () => {});`;
    const member = `${exitWithParent()} ${deaf} ${recordPid(dir)} setInterval(() => {}, 1000);`;
    const leader = spawn(
      process.execPath,
      [
        "-e",
        `${exitWithParent(process.pid)} ${deaf} require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(member)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`,
      ],
      { stdio: "ignore", detached: true },
    );
    trackGroup(leader.pid);
    const [pid = 0] = await recorded(dir, 1);
    expect(pid).toBeGreaterThan(1);
    await endTestProcesses();
    expect(isRunning(pid)).toBe(false);
    expect(leader.pid !== undefined && isRunning(leader.pid)).toBe(false);
  }, 20_000);

  it("fails naming the pid of a recorded process that escaped every group it tracked, and ends it", async () => {
    const dir = pidsDir();
    watchPidDir(dir);
    // Its own group, never tracked: as a grandchild that left the group of the child a test started.
    const escaped = spawn(
      process.execPath,
      ["-e", `${exitWithParent(process.pid)} ${recordPid(dir)} setInterval(() => {}, 1000);`],
      { stdio: "ignore", detached: true },
    );
    const gone = ended(escaped);
    const [pid = 0] = await recorded(dir, 1);
    expect(pid).toBe(escaped.pid);
    await expect(endTestProcesses()).rejects.toThrow(`a process outlived its test: pid ${pid}`);
    await gone;
    expect(isRunning(pid)).toBe(false);
  }, 20_000);
});

describe("exitWithParent", () => {
  it("ends a script within 5 s once its parent dies without ending it", async () => {
    const dir = pidsDir();
    watchPidDir(dir);
    const orphan = `${exitWithParent()} ${recordPid(dir)} setInterval(() => {}, 1000);`;
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `${exitWithParent(process.pid)} require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(orphan)}], { stdio: "ignore", detached: true }); setInterval(() => {}, 1000);`,
      ],
      { stdio: "ignore", detached: true },
    );
    trackGroup(parent.pid);
    const gone = ended(parent);
    const [pid = 0] = await recorded(dir, 1);
    expect(pid).toBeGreaterThan(1);
    // The orphan leads its own group, so only its own check can end it here.
    parent.kill("SIGKILL");
    await gone;
    const end = performance.now() + 5000;
    while (isRunning(pid) && performance.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(isRunning(pid), `pid ${pid} outlived its parent`).toBe(false);
  }, 20_000);
});
