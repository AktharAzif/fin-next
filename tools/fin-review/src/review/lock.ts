// One run per pull request per machine (spec 07 §4.9): state/locks/pr-<n>.lock, created with the
// `wx` flag, holding { pid, runId, head, startedAt }. A lock whose process is gone, or that is older
// than three hours, is broken with a review.lock_broken line; a held lock makes a direct command
// exit 75.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../clock.ts";
import { isJsonObject, parseJsonBytes } from "../json.ts";

export const LOCK_MAX_AGE_MS = 3 * 60 * 60 * 1000;

export class LockHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockHeldError";
  }
}

export interface Lock {
  release(): void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes the lock of pull request `pr`. `broken` is called with the stale lock's run ID when one is
 * removed. Throws LockHeldError when a live run holds it.
 */
export function acquireLock(
  home: string,
  pr: number,
  holder: { runId: string; head: string },
  clock: Clock,
  broken: (staleRunId: string, why: "process_gone" | "too_old" | "unreadable") => void,
): Lock {
  const dir = join(home, "state", "locks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `pr-${pr}.lock`);
  const body = `${JSON.stringify({ pid: process.pid, runId: holder.runId, head: holder.head, startedAt: new Date(clock.now()).toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, body, { flag: "wx", mode: 0o600 });
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let stale: "process_gone" | "too_old" | "unreadable" | null = null;
    let staleRunId = "unknown";
    try {
      const parsed = parseJsonBytes(readFileSync(path));
      if (!parsed.ok || !isJsonObject(parsed.value)) stale = "unreadable";
      else {
        const { pid, runId, startedAt } = parsed.value;
        if (typeof runId === "string") staleRunId = runId;
        const started = typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN;
        if (typeof pid !== "number" || !Number.isInteger(pid) || Number.isNaN(started)) stale = "unreadable";
        else if (!alive(pid)) stale = "process_gone";
        else if (clock.now() - started > LOCK_MAX_AGE_MS) stale = "too_old";
      }
    } catch {
      continue; // removed between the attempt and the read: try again
    }
    if (stale === null) throw new LockHeldError(`pull request ${pr} is being reviewed by run ${staleRunId}`);
    rmSync(path, { force: true });
    broken(staleRunId, stale);
  }
  throw new LockHeldError(`the lock of pull request ${pr} could not be taken`);
}
