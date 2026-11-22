// Password hashing for the developer realm (spec 02 §5.7, [SA-07]): argon2id through Node's
// built-in `crypto.argon2` with m = 19,456 KiB, t = 2, p = 1 and a 32-byte tag, as PHC strings
// (@fin/crypto's implementation, which bounds every parameter a stored string may ask for). The
// library calls `hash` and `verify` through `emailAndPassword.password`; Fin's sign-up calls the
// same hasher, so every hash in the realm is made one way.
//
// Load shedding (ARCHITECTURE §3.5): a few hashes run at once and a short queue waits for a slot;
// past either, the request is answered `503 unavailable` with `Retry-After`. The slots are two per
// vCPU, and never more than the process can spare (hashSlots()):
//   - libuv's thread pool, where `crypto.argon2` runs: hashes never take its last two threads, so
//     a sign-in flood cannot starve the DNS lookups that `pg` and `fetch` need;
//   - the database pool: a request holds one of its clients while it waits for a slot and while it
//     hashes (the hash runs inside its unit of work, S2-04), so the slots and the queue together
//     never hold the pool's last two clients, and a flood is answered 503 before the pool runs dry.
// This is the one thing in process memory that decides about a request, and it decides only about
// load.
import { availableParallelism } from "node:os";
import { hashPassword, verifyPassword } from "@fin/crypto";
import { DEFAULT_THREAD_POOL_SIZE } from "../config.ts";
import { AuthRefusal } from "../errors.ts";
import type { LineSink } from "../ports/log.ts";

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(input: { hash: string; password: string }): Promise<boolean>;
  /** Hashes running and waiting now (for tests and the health line). */
  load(): { running: number; waiting: number };
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
  /** Requests that may wait for a slot; more are refused at once. */
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
/** Clients of the database pool that waiting and hashing requests never hold, for other routes. */
export const CLIENTS_KEPT_FREE = 2;

/** The queue a number of slots may have: four per slot, within the clients hashing may hold. */
function queueFor(limits: HashingLimits, concurrency: number): number {
  const clients = limits.databasePoolSize - CLIENTS_KEPT_FREE;
  return Math.max(0, Math.min(4 * concurrency, clients - concurrency));
}

/**
 * The slots and the queue a process can spare (ARCHITECTURE §3.5): two hashes per vCPU, but never
 * more than libuv's thread pool less THREADS_KEPT_FREE, and never so many that the requests hashing
 * and waiting hold more than the database pool less CLIENTS_KEPT_FREE. Always at least one slot,
 * so passwords keep working on the smallest process.
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
  let running = 0;
  const waiting: Waiter[] = [];

  const busy = (reason: "queue_full" | "queue_wait"): AuthRefusal => {
    options.lines.write("auth.password_hash_busy", "warn", { reason });
    return new AuthRefusal("unavailable", "passwords.busy", { retry_after: retryAfter });
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
    load: () => ({ running, waiting: waiting.length }),
    slots: { concurrency, queueLimit },
  };
}
