// The injected clock (ARCHITECTURE §1 principle 14): nothing in this package reads the time at
// module scope or calls Date.now() directly; every decision takes its time from a Clock.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock whose time only moves when a test moves it. */
export class ManualClock implements Clock {
  #ms: number;
  constructor(start: Date | string) {
    this.#ms = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.#ms);
  }
  advance(ms: number): void {
    this.#ms += ms;
  }
  set(at: Date | string): void {
    this.#ms = new Date(at).getTime();
  }
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function addMs(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms);
}
