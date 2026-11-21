// Time and randomness (spec 07 §2.1): every reader of the clock, every wait and every random value
// goes through these, so tests freeze them. Nothing here runs at module scope.

import { randomBytes } from "node:crypto";

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms` milliseconds, or rejects with the signal's reason when it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The real clock. */
export const systemClock: Clock = Object.freeze({
  now: (): number => Date.now(),
  sleep: (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
});

/** Random bytes, from node:crypto. */
export type RandomSource = (bytes: number) => Buffer;

export const systemRandom: RandomSource = (bytes: number): Buffer => randomBytes(bytes);

/** `YYYYMMDDTHHMMSSZ` for a time in milliseconds. */
export function compactUtc(ms: number): string {
  const iso = new Date(ms).toISOString(); // 2026-11-21T10:15:30.123Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}
