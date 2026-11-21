// Registered runs and the run lock (spec 01 §10, ARCHITECTURE §6.10), in their interim form.
//
// The plan keeps run registrations in the R2 ops bucket (locked a year) and the run lock in the
// state bucket (`If-None-Match: *`). The vault does not exist yet (BD-14: no escrow recipient on
// Saturday), so until `pnpm fin vault create` lands both live on the operator's machine, outside
// the repository, under FIN_STATE_DIR (default ~/.local/state/fin-next/<env>):
//
//   runs.jsonl  an append-only log, one JSON record per line, each carrying the SHA-256 of the line
//               before it (`pnpm fin log verify`);
//   head.json   the log's head: the last record's seq and the SHA-256 of its line, rewritten after
//               every append. The same head travels on every run.registered, run.done and
//               lock.broken telemetry line (printed in Actions, shipped to Better Stack), so it
//               also exists off this machine;
//   lock.json   the run lock, created with O_EXCL so two runs never both hold it; it is never
//               broken by age, only by `pnpm fin lock break <env> --reason "..."`, which is logged.
//
// What the chain catches: an edited or removed line anywhere but the end (the next line no longer
// chains); with the head file, records removed from the end or the whole log removed; with a head
// taken from a shipped line (`log verify --head <seq>:<sha256>`), any change up to that record,
// even one that rewrote the log and the head file together. What it cannot catch on its own: a
// rewrite of everything after the last head that left the machine. The chain is unkeyed: it is an
// interim tamper signal, not the year-locked bucket it stands in for.
//
// Every record's fields pass through the masker before they are written (value by value, so the
// JSON stays valid whatever is registered): the log holds roles and placeholders, never a zone, a
// host or an ID, so it can move to the ops bucket unchanged once the vault exists.

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BusyError, ConfigError, EXIT, FinError } from "./errors.ts";
import type { Masker } from "./mask.ts";

export const GENESIS = "genesis";
const HASH = /^[0-9a-f]{64}$/;

export interface RunRecord {
  seq: number;
  prev: string;
  at: string;
  runId: string;
  event: string;
  [field: string]: unknown;
}

/** The last record of the log: its seq and the SHA-256 of its line. */
export interface Head {
  seq: number;
  hash: string;
}

export interface Appended {
  record: RunRecord;
  /** The SHA-256 of the record's line: the log's new head. */
  hash: string;
}

export interface Verification {
  /** How many lines the log holds (unparsable ones included). */
  count: number;
  /** The log's head as the lines give it, or undefined for an empty log. */
  head: Head | undefined;
  /** What is wrong; empty for an intact log. */
  problems: string[];
  /** What is worth knowing but not wrong. */
  notes: string[];
}

export interface LockHolder {
  runId: string;
  command: string;
  pid: number;
  host: string;
  startedAt: string;
}

export type ReleaseOutcome = "released" | "free" | "held-by-another";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Parses `<seq>:<sha256>`, the form `log verify --head` takes. */
export function parseHead(text: string): Head | undefined {
  const match = /^(\d{1,9}):([0-9a-f]{64})$/.exec(text.trim());
  if (match === null) return undefined;
  const seq = Number(match[1]);
  return seq >= 1 ? { seq, hash: match[2] ?? "" } : undefined;
}

function isHead(value: unknown): value is Head {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.seq === "number" &&
    Number.isInteger(v.seq) &&
    v.seq >= 1 &&
    typeof v.hash === "string" &&
    HASH.test(v.hash)
  );
}

function writeDurably(path: string, text: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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

  get headPath(): string {
    return join(this.dir, "head.json");
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

  #lines(): string[] {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, "utf8")
      .split("\n")
      .filter((line) => line !== "");
  }

  /**
   * The records so far, in order (an empty log has none). A line that is not a record is skipped;
   * verify() reports it.
   */
  records(): RunRecord[] {
    const records: RunRecord[] = [];
    for (const line of this.#lines()) {
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          records.push(value as RunRecord);
        }
      } catch {
        // Not a record: verify() reports it.
      }
    }
    return records;
  }

  /** The head file's head, if there is a valid one. */
  readHead(): Head | undefined {
    if (!existsSync(this.headPath)) return undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(this.headPath, "utf8"));
      return isHead(value) ? { seq: value.seq, hash: value.hash } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Appends one record, chained to the line before it and synced to disk, then moves the head
   * file to it. Every field but the chain's own (seq, prev, at, runId, event) is masked first.
   */
  append(at: Date, runId: string, event: string, fields: Record<string, unknown>): Appended {
    this.#ensureDir();
    const lines = this.#lines();
    const last = lines.at(-1);
    const record: RunRecord = {
      seq: lines.length + 1,
      prev: last === undefined ? GENESIS : sha256(last),
      at: at.toISOString(),
      runId,
      event,
    };
    const masked = this.#masker.maskValue(fields);
    if (typeof masked === "object" && masked !== null && !Array.isArray(masked)) {
      for (const [key, value] of Object.entries(masked)) {
        if (Object.hasOwn(record, key)) continue;
        Object.defineProperty(record, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    const line = JSON.stringify(record);
    const fd = openSync(this.logPath, "a", 0o600);
    try {
      writeSync(fd, `${line}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const hash = sha256(line);
    this.#writeHead({ seq: record.seq, hash });
    return { record, hash };
  }

  /** The head file is a convenience next to the chain: a failure to write it never fails a run. */
  #writeHead(head: Head): void {
    const temporary = `${this.headPath}.${process.pid}.tmp`;
    try {
      writeDurably(temporary, `${JSON.stringify(head)}\n`);
      renameSync(temporary, this.headPath);
    } catch {
      try {
        unlinkSync(temporary);
      } catch {
        // Nothing to clean up.
      }
    }
  }

  /**
   * Checks the chain, the head file and, when given, a head taken from a line that left the
   * machine. A line that is not JSON is reported, never thrown.
   */
  verify(expected?: Head): Verification {
    const lines = this.#lines();
    const problems: string[] = [];
    const notes: string[] = [];
    const hashes: string[] = [];
    let prev = GENESIS;
    lines.forEach((line, index) => {
      const n = index + 1;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        record = undefined;
      }
      if (typeof record !== "object" || record === null || Array.isArray(record)) {
        problems.push(`line ${n} is not a JSON record`);
      } else {
        const r = record as Record<string, unknown>;
        if (r.seq !== n) problems.push(`line ${n} has the wrong seq`);
        if (r.prev !== prev) problems.push(`line ${n} does not chain to the line before`);
      }
      prev = sha256(line);
      hashes.push(prev);
    });
    const count = lines.length;
    const last = hashes.at(-1);
    const head = last === undefined ? undefined : { seq: count, hash: last };

    const check = (anchor: Head, source: string) => {
      if (anchor.seq > count) {
        problems.push(
          `${source} names record ${anchor.seq}, but the log holds ${count}: records were removed`,
        );
      } else if (hashes[anchor.seq - 1] !== anchor.hash) {
        problems.push(
          `record ${anchor.seq} is not the record ${source} names: the log was changed`,
        );
      } else if (anchor.seq < count) {
        notes.push(`${source} names record ${anchor.seq} of ${count}`);
      }
    };
    if (existsSync(this.headPath)) {
      const file = this.readHead();
      if (file === undefined) problems.push("the head file is not a valid head");
      else check(file, "the head file");
    } else if (count > 0) {
      problems.push("the head file is missing");
    }
    if (expected !== undefined) check(expected, "the head given");
    return { count, head, problems, notes };
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
      const full: LockHolder = {
        runId: holder.runId,
        command: this.#masker.mask(holder.command),
        pid: process.pid,
        host: this.#masker.mask(hostname()),
        startedAt: holder.startedAt,
      };
      writeSync(fd, JSON.stringify(full));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Releases the lock if this run holds it; never throws for a lock another run holds. */
  release(runId: string): ReleaseOutcome {
    const current = this.holder();
    if (current === undefined) return "free";
    if (current.runId !== runId) return "held-by-another";
    unlinkSync(this.lockPath);
    return "released";
  }

  /** Releases the lock if this run holds it, and refuses when another run holds it. */
  unlock(runId: string): void {
    if (this.release(runId) === "held-by-another") {
      throw new FinError(
        `the run lock is held by ${this.holder()?.runId ?? "another run"}, not by ${runId}`,
        EXIT.internal,
      );
    }
  }

  /** Breaks a stale lock, logging who held it and why it was broken (the record comes first). */
  breakLock(
    at: Date,
    runId: string,
    reason: string,
    operator: string,
  ): { holder: LockHolder; appended: Appended } | undefined {
    const current = this.holder();
    if (current === undefined) return undefined;
    const appended = this.append(at, runId, "lock.broken", { holder: current, reason, operator });
    try {
      unlinkSync(this.lockPath);
    } catch (error) {
      // Already gone (its run ended meanwhile): the lock is free either way.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { holder: current, appended };
  }
}
