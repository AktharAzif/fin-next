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
// A signal is kept until someone acts on it. append() refuses while the log's end does not match
// the head file (records removed, the log or the head file deleted), since appending would chain
// past the gap and rewrite the head file to match, and the log would verify again; it also refuses
// while the last line is not the record before the one it would write (a torn line left by a crash
// or a short write, a last line without its newline even when it is a whole record, a line that is
// not a record, the wrong seq, a broken link), so a record is never joined onto a torn line and
// lost. verify() reports every one of these, so it never passes a log that append() refuses. A run
// refuses to start, and a lock break refuses, while the log does not verify at all (run.ts,
// breakLock()). The way on is `pnpm fin log restart <env> --reason "..."` (restart()): it keeps the
// broken files beside the log under new names and starts a new log whose first record,
// `log.restarted`, names the problems and the heads it found.
//
// Every record's fields pass through the masker before they are written (value by value, so the
// JSON stays valid whatever is registered): the log holds roles and placeholders, never a zone, a
// host or an ID, so it can move to the ops bucket unchanged once the vault exists.

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BusyError, ConfigError, EXIT, FinError, LogIntegrityError } from "./errors.ts";
import type { Masker } from "./mask.ts";

export const GENESIS = "genesis";
const HASH = /^[0-9a-f]{64}$/;
/** How many of the log's problems a refusal names (the rest are counted). */
const PROBLEMS_SHOWN = 3;

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

export interface Restarted {
  /** The new log's first record, `log.restarted`. */
  appended: Appended;
  /** What verify() found in the log that was set aside. */
  problems: readonly string[];
  /** The names the broken log and head file are kept under, beside the new log. */
  keptLog: string | undefined;
  keptHead: string | undefined;
  /** The set-aside log's head as its lines give it, and as its head file gave it. */
  previousHead: Head | undefined;
  previousHeadFile: Head | undefined;
}

/** Where an anchor (the head file's head, or one given) disagrees with the log's lines. */
function anchorProblem(
  anchor: Head,
  hashOf: (seq: number) => string | undefined,
  count: number,
  source: string,
): string | undefined {
  if (anchor.seq > count) {
    return `${source} names record ${anchor.seq}, but the log holds ${count}: records were removed`;
  }
  if (hashOf(anchor.seq) !== anchor.hash) {
    return `record ${anchor.seq} is not the record ${source} names: the log was changed`;
  }
  return undefined;
}

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

/**
 * The refusal for a run log that does not verify: names the first problems, counts the rest, and
 * points at the runbook. `what` says what does not happen (`no run starts`).
 */
export function integrityError(problems: readonly string[], what: string): LogIntegrityError {
  const shown = problems.slice(0, PROBLEMS_SHOWN).join("; ");
  const more =
    problems.length > PROBLEMS_SHOWN ? `; and ${problems.length - PROBLEMS_SHOWN} more` : "";
  return new LogIntegrityError(
    `the run log does not verify (${shown}${more}), so ${what}. This is an incident: ` +
      `check it with pnpm fin log verify <env>, then see the runbook ` +
      `(pnpm fin log restart <env> --reason "<why>" starts a new log and keeps this one)`,
  );
}

/** Writes all of the text, however many calls it takes (a write may be short). */
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function writeDurably(path: string, text: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeAll(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether a file is missing, empty or ends with a newline, so a line appended to it stands on its
 * own (only its last byte is read).
 */
export function endsLine(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return true;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * The problem with a log whose last line does not end with a newline, if it is one: a write that
 * did not finish (a crash, a short write, a full disk), even when what it left is a whole record.
 * verify() and append() both report it, so a log that refuses an append never verifies, and
 * `log restart` is always the way on. `count` is the number of lines the log holds.
 */
function unendedProblem(text: string, count: number): string | undefined {
  if (text === "" || text.endsWith("\n")) return undefined;
  return `the last line does not end with a newline (line ${count} is incomplete)`;
}

/** What is wrong with the last line as the record before a new one, if anything. */
function tailProblem(text: string, lines: readonly string[]): string | undefined {
  const unended = unendedProblem(text, lines.length);
  if (unended !== undefined) return unended;
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  const n = lines.length;
  let record: unknown;
  try {
    record = JSON.parse(last);
  } catch {
    record = undefined;
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return `line ${n} is not a JSON record`;
  }
  const r = record as Record<string, unknown>;
  if (r.seq !== n) return `line ${n} has the wrong seq`;
  const before = lines.at(-2);
  if (r.prev !== (before === undefined ? GENESIS : sha256(before))) {
    return `line ${n} does not chain to the line before`;
  }
  return undefined;
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

  /** The log's text and its lines (an empty log, or none, has neither). */
  #read(): { text: string; lines: string[] } {
    if (!existsSync(this.logPath)) return { text: "", lines: [] };
    const text = readFileSync(this.logPath, "utf8");
    return { text, lines: text.split("\n").filter((line) => line !== "") };
  }

  #lines(): string[] {
    return this.#read().lines;
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
   * What is wrong between the log's lines and the head file, if anything: the head file must name
   * a record the log holds, with that record's hash (the log may run past it, when writing the
   * head file failed once), and must exist once the log has a record.
   */
  #headProblem(lines: readonly string[]): string | undefined {
    if (!existsSync(this.headPath)) {
      return lines.length > 0 ? "the head file is missing" : undefined;
    }
    const head = this.readHead();
    if (head === undefined) return "the head file is not a valid head";
    const hashOf = (seq: number) => {
      const line = lines[seq - 1];
      return line === undefined ? undefined : sha256(line);
    };
    return anchorProblem(head, hashOf, lines.length, "the head file");
  }

  /**
   * Appends one record, chained to the line before it and synced to disk, then moves the head
   * file to it. Every field but the chain's own (seq, prev, at, runId, event) is masked first.
   * Refuses (LogIntegrityError, exit 1) while the log's end does not match the head file, so an
   * append never hides records removed from the end, or a log or head file that was deleted; and
   * while the last line is not a whole record that the new one can follow (a torn line, a last
   * line without its newline, a line that is not a record, the wrong seq, a broken link), so a
   * record is never joined onto a torn line. It checks the end only: a run and a lock break check
   * the whole log first (verify(), which reports all of these too).
   */
  append(at: Date, runId: string, event: string, fields: Record<string, unknown>): Appended {
    this.#ensureDir();
    const { text, lines } = this.#read();
    const problem = this.#headProblem(lines);
    if (problem !== undefined) {
      throw new LogIntegrityError(
        `the run log does not match its head file (${problem}); nothing is appended. ` +
          `This is an incident: check it with pnpm fin log verify <env>, then see the runbook ` +
          `(pnpm fin log restart <env> --reason "<why>" starts a new log and keeps this one)`,
      );
    }
    const tail = tailProblem(text, lines);
    if (tail !== undefined) {
      throw new LogIntegrityError(
        `the run log's end is not intact (${tail}); nothing is appended. ` +
          `This is an incident: check it with pnpm fin log verify <env>, then see the runbook ` +
          `(pnpm fin log restart <env> --reason "<why>" starts a new log and keeps this one)`,
      );
    }
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
      writeAll(fd, `${line}\n`);
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
   * Checks the chain, the end of the log, the head file and, when given, a head taken from a line
   * that left the machine. A line that is not JSON is reported, never thrown. It reports
   * everything append() refuses on (a last line without its newline included), so a log that
   * verifies always takes the next record, and one that does not can always be restarted.
   */
  verify(expected?: Head): Verification {
    const { text, lines } = this.#read();
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
    const unended = unendedProblem(text, lines.length);
    if (unended !== undefined) problems.push(unended);
    const count = lines.length;
    const last = hashes.at(-1);
    const head = last === undefined ? undefined : { seq: count, hash: last };

    const check = (anchor: Head, source: string) => {
      const problem = anchorProblem(anchor, (seq) => hashes[seq - 1], count, source);
      if (problem !== undefined) problems.push(problem);
      else if (anchor.seq < count) notes.push(`${source} names record ${anchor.seq} of ${count}`);
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

  /**
   * Starts a new log after an incident, when the log does not verify (undefined when it does:
   * nothing to restart). The broken log and head file are kept beside the new one, renamed with
   * this run's ID; the new log's first record, `log.restarted`, carries the reason, the operator,
   * the problems found and both heads of the log set aside, so the gap is itself on the record.
   */
  restart(at: Date, runId: string, reason: string, operator: string): Restarted | undefined {
    const before = this.verify();
    if (before.problems.length === 0) return undefined;
    const previousHeadFile = this.readHead();
    const keep = (path: string, name: string): string | undefined => {
      if (!existsSync(path)) return undefined;
      renameSync(path, join(this.dir, name));
      return name;
    };
    const keptLog = keep(this.logPath, `runs.broken-${runId}.jsonl`);
    const keptHead = keep(this.headPath, `head.broken-${runId}.json`);
    const appended = this.append(at, runId, "log.restarted", {
      reason,
      operator,
      problems: before.problems,
      previous: {
        log: keptLog ?? null,
        headFile: keptHead ?? null,
        records: before.count,
        head: before.head ?? null,
        headFileHead: previousHeadFile ?? null,
      },
    });
    return {
      appended,
      problems: before.problems,
      keptLog,
      keptHead,
      previousHead: before.head,
      previousHeadFile,
    };
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
      writeAll(fd, JSON.stringify(full));
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

  /**
   * Breaks a stale lock, logging who held it and why it was broken (the record comes first).
   * Refuses (LogIntegrityError, exit 1), leaving the lock and the log as they are, while the log
   * does not verify anywhere: a stale lock and a damaged log can come together (a crash during an
   * append), and the override must not write past the damage. `log restart` comes first then.
   */
  breakLock(
    at: Date,
    runId: string,
    reason: string,
    operator: string,
  ): { holder: LockHolder; appended: Appended } | undefined {
    const current = this.holder();
    if (current === undefined) return undefined;
    let problems: string[];
    try {
      problems = this.verify().problems;
    } catch {
      problems = ["the run log cannot be read"];
    }
    if (problems.length > 0) throw integrityError(problems, "the lock is not broken");
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
