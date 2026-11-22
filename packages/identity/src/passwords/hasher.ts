// Password hashing for the developer realm (spec 02 §5.7, [SA-07]): argon2id through Node's
// built-in `crypto.argon2` with m = 19,456 KiB, t = 2, p = 1 and a 32-byte tag, as PHC strings
// (@fin/crypto's implementation, which bounds every parameter a stored string may ask for). The
// library calls `hash` and `verify` through `emailAndPassword.password`; Fin's sign-up calls the
// same hasher, so every hash in the realm is made one way.
//
// Load shedding (ARCHITECTURE §3.5), in two steps:
//   - Admission. A request that may hash (a password sign-in, reset or change, a sign-up with a
//     password) is admitted before its unit of work opens, and stays admitted until the unit ends;
//     a hash for a request that was not admitted fails closed (passwords/flows.ts). All that time
//     it holds one of the database pool's clients (the hash runs inside the unit, S2-04), also
//     while it waits on a row another admitted request holds across its hash (its network's
//     password count, its address's password turn). So at most `concurrency + queueLimit`
//     requests are admitted at once, and the rest are answered `503 unavailable` with
//     `Retry-After` before they take a client.
//   - Slots. Among the admitted, a few hashes run at once and the others wait for a slot, for at
//     most a second; past that wait (or a full queue), they too are answered 503.
// The bound holds for the pool only because an admitted request holds across its hash no row that
// a request which is never admitted waits on: a sign-up hashes before it takes its limits and the
// address's code lock (sign-up.ts); a sign-in holds its address's password turn, never its code
// lock (codes.ts); a reset waits for that turn before its network's code count (hooks/before.ts).
// What is left: a change holds the person's own rows (their session, their `method_add` count),
// which only that person's requests take; and a reset whose code was right holds its network's
// `code_sign_in` count and its address's code lock across its one hash, which only someone with
// the code emailed to the address can make happen.
// The sizes are what the process can spare (hashSlots()): two hashes per vCPU, but never
//   - more than libuv's thread pool less two threads, where `crypto.argon2` runs, so a sign-in
//     flood cannot starve the DNS lookups that `pg` and `fetch` need;
//   - so many admitted that they hold the database pool's last two clients, so a flood is answered
//     503 before the pool runs dry and every other route keeps two clients.
// This is the one thing in process memory that decides about a request, and it decides only about
// load.
import { availableParallelism } from "node:os";
import { hashPassword, verifyPassword } from "@fin/crypto";
import { DEFAULT_THREAD_POOL_SIZE } from "../config.ts";
import { AuthRefusal } from "../errors.ts";
import type { LineSink } from "../ports/log.ts";

/**
 * Why a password request was turned away for load: no room left among the admitted requests (or in
 * the queue for a slot), a wait for a slot that ran out, or another sign-in of the same address
 * being checked (passwords/flows.ts).
 */
export type BusyReason = "queue_full" | "queue_wait" | "address_busy";

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(input: { hash: string; password: string }): Promise<boolean>;
  /**
   * Admits a request that may hash, before its unit of work opens. Returns the release, to call
   * once the unit has ended (a second call does nothing). Refuses with `503 unavailable` and
   * `Retry-After` when the requests admitted already hold every client hashing may hold.
   */
  admit(): () => void;
  /** The `503 unavailable` for a password request turned away for load; writes its line. */
  busy(reason: BusyReason): AuthRefusal;
  /** Hashes running and waiting, and the requests admitted, now (for tests and the health line). */
  load(): { running: number; waiting: number; admitted: number };
  /** The slots and the queue this hasher has (for tests and the health line). */
  readonly slots: HashSlots;
}

/** What a process can spare for hashing (ARCHITECTURE §3.5). */
export interface HashingLimits {
  /** libuv's thread pool size: UV_THREADPOOL_SIZE, read with the realm's settings. */
  threadPoolSize: number;
  /** The database pool's size: every unit of work holds one of its clients. */
  databasePoolSize: number;
}

export interface HashSlots {
  /** Hashes at once. */
  concurrency: number;
  /**
   * Requests that may wait for a slot; more are refused at once. Admission lets in at most
   * `concurrency + queueLimit` requests that may hash.
   */
  queueLimit: number;
}

export interface PasswordHasherOptions {
  lines: LineSink;
  /** What sizes the slots and the queue (hashSlots()); libuv's and node-postgres's defaults. */
  limits?: HashingLimits;
  /** Hashes at once; hashSlots() by default. */
  concurrency?: number;
  /** Requests that may wait for a slot; hashSlots() by default. */
  queueLimit?: number;
  /** How long a request waits for a slot before it is refused. */
  queueWaitMs?: number;
  /** The seconds a refused request is told to wait (`Retry-After`). */
  retryAfterSeconds?: number;
  /** Tests replace the work itself; production uses @fin/crypto's argon2id. */
  work?: {
    hash(password: string): Promise<string>;
    verify(hash: string, password: string): Promise<boolean>;
  };
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const DEFAULT_QUEUE_WAIT_MS = 1_000;
/** node-postgres's pool size when none is given. */
export const DEFAULT_DATABASE_POOL_SIZE = 10;
/** Threads of libuv's pool that hashes never take: DNS lookups and file reads run there too. */
export const THREADS_KEPT_FREE = 2;
/** Clients of the database pool that admitted requests never hold, for every other route. */
export const CLIENTS_KEPT_FREE = 2;

/** The queue a number of slots may have: four per slot, within the clients hashing may hold. */
function queueFor(limits: HashingLimits, concurrency: number): number {
  const clients = limits.databasePoolSize - CLIENTS_KEPT_FREE;
  return Math.max(0, Math.min(4 * concurrency, clients - concurrency));
}

/**
 * The slots and the queue a process can spare (ARCHITECTURE §3.5): two hashes per vCPU, but never
 * more than libuv's thread pool less THREADS_KEPT_FREE, and never so many that the requests
 * admitted (the slots plus the queue) hold more than the database pool less CLIENTS_KEPT_FREE.
 * Always at least one slot, so passwords keep working on the smallest process.
 */
export function hashSlots(limits: HashingLimits, cpus: number = availableParallelism()): HashSlots {
  const concurrency = Math.max(
    1,
    Math.min(
      2 * Math.max(1, cpus),
      limits.threadPoolSize - THREADS_KEPT_FREE,
      limits.databasePoolSize - CLIENTS_KEPT_FREE,
    ),
  );
  return { concurrency, queueLimit: queueFor(limits, concurrency) };
}

export function createPasswordHasher(options: PasswordHasherOptions): PasswordHasher {
  const limits = options.limits ?? {
    threadPoolSize: DEFAULT_THREAD_POOL_SIZE,
    databasePoolSize: DEFAULT_DATABASE_POOL_SIZE,
  };
  const concurrency = options.concurrency ?? hashSlots(limits).concurrency;
  const queueLimit = options.queueLimit ?? queueFor(limits, concurrency);
  const queueWaitMs = options.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS;
  const retryAfter = options.retryAfterSeconds ?? 2;
  const work = options.work ?? {
    hash: (password: string) => hashPassword(password),
    verify: (hash: string, password: string) => verifyPassword(hash, password),
  };
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("password hashing needs at least one slot");
  }
  if (!Number.isInteger(queueLimit) || queueLimit < 0) {
    throw new Error("password hashing's queue cannot be negative");
  }
  /** The requests that may hash at once, each holding a database client from start to end. */
  const admissionLimit = concurrency + queueLimit;
  let admitted = 0;
  let running = 0;
  const waiting: Waiter[] = [];

  const busy = (reason: BusyReason): AuthRefusal => {
    options.lines.write("auth.password_hash_busy", "warn", { reason });
    return new AuthRefusal(
      "unavailable",
      reason === "address_busy" ? "passwords.address_busy" : "passwords.busy",
      { retry_after: retryAfter },
    );
  };

  const admit = (): (() => void) => {
    if (admitted >= admissionLimit) throw busy("queue_full");
    admitted += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      admitted -= 1;
    };
  };

  const acquire = (): Promise<void> => {
    if (running < concurrency) {
      running += 1;
      return Promise.resolve();
    }
    if (waiting.length >= queueLimit) return Promise.reject(busy("queue_full"));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const at = waiting.indexOf(waiter);
          if (at >= 0) waiting.splice(at, 1);
          reject(busy("queue_wait"));
        }, queueWaitMs),
      };
      waiting.push(waiter);
    });
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) {
      running -= 1;
      return;
    }
    // The slot passes straight to the next waiter, so `running` stays as it is.
    clearTimeout(next.timer);
    next.resolve();
  };

  const withSlot = async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };

  return {
    hash: (password) => withSlot(() => work.hash(password)),
    verify: ({ hash, password }) => withSlot(() => work.verify(hash, password)),
    admit,
    busy,
    load: () => ({ running, waiting: waiting.length, admitted }),
    slots: { concurrency, queueLimit },
  };
}
