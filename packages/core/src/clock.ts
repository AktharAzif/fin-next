// The injected Clock (ARCHITECTURE §1 principle 14, §3.5). Domain code never reads the time itself:
// it takes the Clock it is given, so tests control time and nothing at module scope reads it.

/** A source of wall-clock time in milliseconds since the Unix epoch. */
export interface Clock {
  now(): number;
}

/** The process clock. Reading it is the caller's choice, at call time, never at module scope. */
export const systemClock: Clock = Object.freeze({ now: (): number => Date.now() });

/** RFC 3339 UTC with milliseconds and `Z`, as every line's `dt` and every API time is written. */
export function rfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

/** A clock a test moves by hand. */
export interface ManualClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

/** Makes a clock that starts at `startMs` and moves only when told to. */
export function createManualClock(startMs: number): ManualClock {
  let current = startMs;
  return {
    now: () => current,
    set: (ms) => {
      current = ms;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}
