// Password hashing for the developer realm (spec 02 §5.7, [SA-07]): argon2id through Node's
// built-in `crypto.argon2` with m = 19,456 KiB, t = 2, p = 1 and a 32-byte tag, as PHC strings
// (@fin/crypto's implementation, which bounds every parameter a stored string may ask for). The
// library calls `hash` and `verify` through `emailAndPassword.password`; Fin's sign-up calls the
// same hasher, so every hash in the realm is made one way.
//
// Load shedding (ARCHITECTURE §3.5): at most two hashes per vCPU run at once, and a short queue
// waits for a slot; past either, the request is answered `503 unavailable` with `Retry-After`,
// so a sign-in flood cannot starve the thread pool that `pg` and DNS lookups share. This is the one
// thing in process memory that decides about a request, and it decides only about load.
import { availableParallelism } from "node:os";
import { hashPassword, verifyPassword } from "@fin/crypto";
import { AuthRefusal } from "../errors.ts";
import type { LineSink } from "../ports/log.ts";

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(input: { hash: string; password: string }): Promise<boolean>;
  /** Hashes running and waiting now (for tests and the health line). */
  load(): { running: number; waiting: number };
}

export interface PasswordHasherOptions {
  lines: LineSink;
  /** Hashes at once; two per vCPU by default. */
  concurrency?: number;
  /** Requests that may wait for a slot; more are refused at once. */
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

/** Two hashes per vCPU (ARCHITECTURE §3.5). */
export function defaultHashConcurrency(): number {
  return Math.max(1, availableParallelism()) * 2;
}

export function createPasswordHasher(options: PasswordHasherOptions): PasswordHasher {
  const concurrency = options.concurrency ?? defaultHashConcurrency();
  const queueLimit = options.queueLimit ?? concurrency * 4;
  const queueWaitMs = options.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS;
  const retryAfter = options.retryAfterSeconds ?? 2;
  const work = options.work ?? {
    hash: (password: string) => hashPassword(password),
    verify: (hash: string, password: string) => verifyPassword(hash, password),
  };
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("password hashing needs at least one slot");
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
  };
}
