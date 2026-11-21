// Registered runs and the run lock (spec 01 §10, ARCHITECTURE §6.10), in their interim form.
//
// The plan keeps run registrations in the R2 ops bucket (locked a year) and the run lock in the
// state bucket (`If-None-Match: *`). The vault does not exist yet (BD-14: no escrow recipient on
// Saturday), so until `pnpm fin vault create` lands both live on the operator's machine, outside
// the repository, under FIN_STATE_DIR (default ~/.local/state/fin-next/<env>):
//
//   runs.jsonl  an append-only log, one JSON record per line, each carrying the SHA-256 of the line
//               before it, so an edited or removed line breaks the chain (`pnpm fin log verify`);
//   lock.json   the run lock, created with O_EXCL so two runs never both hold it; it is never
//               broken by age, only by `pnpm fin lock break <env> --reason "..."`, which is logged.
//
// Every record passes through the masker first: the log holds roles and placeholders, never a
// zone, a host or an ID, so it can move to the ops bucket unchanged once the vault exists.

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BusyError, ConfigError, FinError } from "./errors.ts";
import type { Masker } from "./mask.ts";

export const GENESIS = "genesis";

export interface RunRecord {
  seq: number;
  prev: string;
  at: string;
  runId: string;
  event: string;
  [field: string]: unknown;
}

export interface LockHolder {
  runId: string;
  command: string;
  pid: number;
  host: string;
  startedAt: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class RunLog {
  readonly dir: string;
  readonly #masker: Masker;

  constructor(dir: string, masker: Masker) {
    this.dir = dir;
    this.#masker = masker;
  }

  get logPath(): string {
    return join(this.dir, "runs.jsonl");
  }

  get lockPath(): string {
    return join(this.dir, "lock.json");
  }

  #ensureDir(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch {
      throw new ConfigError("the run log directory (FIN_STATE_DIR) cannot be created");
    }
  }

  /** The records so far, in order (an empty log has none). */
  records(): RunRecord[] {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as RunRecord);
  }

  /** Appends one record, masked, chained to the line before it, and synced to disk. */
  append(at: Date, runId: string, event: string, fields: Record<string, unknown>): RunRecord {
    this.#ensureDir();
    let prev = GENESIS;
    let seq = 1;
    if (existsSync(this.logPath)) {
      const lines = readFileSync(this.logPath, "utf8")
        .split("\n")
        .filter((l) => l !== "");
      const last = lines.at(-1);
      if (last !== undefined) {
        prev = sha256(last);
        seq = lines.length + 1;
      }
    }
    const record: RunRecord = { seq, prev, at: at.toISOString(), runId, event, ...fields };
    const line = this.#masker.mask(JSON.stringify(record));
    const fd = openSync(this.logPath, "a", 0o600);
    try {
      writeSync(fd, `${line}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return JSON.parse(line) as RunRecord;
  }

  /** Checks the chain. Returns the problems found (none for an intact log). */
  verify(): string[] {
    if (!existsSync(this.logPath)) return [];
    const lines = readFileSync(this.logPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const problems: string[] = [];
    let prev = GENESIS;
    lines.forEach((line, index) => {
      let record: RunRecord;
      try {
        record = JSON.parse(line) as RunRecord;
      } catch {
        problems.push(`line ${index + 1} is not JSON`);
        prev = sha256(line);
        return;
      }
      if (record.seq !== index + 1) problems.push(`line ${index + 1} has seq ${record.seq}`);
      if (record.prev !== prev)
        problems.push(`line ${index + 1} does not chain to the line before`);
      prev = sha256(line);
    });
    return problems;
  }

  /** The current holder of the lock, if any. */
  holder(): LockHolder | undefined {
    if (!existsSync(this.lockPath)) return undefined;
    try {
      return JSON.parse(readFileSync(this.lockPath, "utf8")) as LockHolder;
    } catch {
      return {
        runId: "unknown",
        command: "unknown",
        pid: 0,
        host: "unknown",
        startedAt: "unknown",
      };
    }
  }

  /** Takes the lock, or throws BusyError naming the run that holds it. */
  lock(holder: Omit<LockHolder, "host" | "pid">): void {
    this.#ensureDir();
    let fd: number;
    try {
      fd = openSync(this.lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const current = this.holder();
        throw new BusyError(
          `the run lock is held by ${current?.runId ?? "another run"} (${current?.command ?? "?"}, ` +
            `since ${current?.startedAt ?? "?"}); if that run is gone, ` +
            `run: pnpm fin lock break <env> --reason "<why>"`,
        );
      }
      throw new ConfigError("the run lock cannot be created in FIN_STATE_DIR");
    }
    try {
      const full: LockHolder = { ...holder, pid: process.pid, host: hostname() };
      writeSync(fd, this.#masker.mask(JSON.stringify(full)));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Releases the lock if this run holds it. */
  unlock(runId: string): void {
    const current = this.holder();
    if (current === undefined) return;
    if (current.runId !== runId) {
      throw new FinError(`the run lock is held by ${current.runId}, not by ${runId}`, 70);
    }
    unlinkSync(this.lockPath);
  }

  /** Breaks a stale lock, logging who held it and why it was broken. */
  breakLock(at: Date, runId: string, reason: string, operator: string): LockHolder | undefined {
    const current = this.holder();
    if (current === undefined) return undefined;
    this.append(at, runId, "lock.broken", { holder: current, reason, operator });
    unlinkSync(this.lockPath);
    return current;
  }
}
