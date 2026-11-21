// The frozen clock (ARCHITECTURE §11.4: the canon's story runs with the clock frozen at the
// canon's time). Code under test takes the Clock it is given (ARCHITECTURE principle 14); this one
// moves only when a test moves it.

/** The canon's moment: Monday 16 Nov 2026, 10:00 UTC (fin-next's fixture time, not a real event). */
export const CANON_TIME = "2026-11-16T10:00:00.000Z";

/** What Fin's code reads the time from; @fin/core's `Clock` has this shape. */
export interface Clock {
  now(): Date;
}

export interface Duration {
  readonly ms?: number;
  readonly seconds?: number;
  readonly minutes?: number;
  readonly hours?: number;
  readonly days?: number;
}

/** A duration in milliseconds. */
export function durationMs(duration: Duration | number): number {
  if (typeof duration === "number") return duration;
  return (
    (duration.ms ?? 0) +
    (duration.seconds ?? 0) * 1000 +
    (duration.minutes ?? 0) * 60_000 +
    (duration.hours ?? 0) * 3_600_000 +
    (duration.days ?? 0) * 86_400_000
  );
}

function toMs(at: Date | string | number): number {
  const ms = at instanceof Date ? at.getTime() : typeof at === "string" ? Date.parse(at) : at;
  if (!Number.isFinite(ms)) throw new Error("not a valid time");
  return ms;
}

export class FrozenClock implements Clock {
  #ms: number;

  constructor(at: Date | string | number = CANON_TIME) {
    this.#ms = toMs(at);
  }

  /** A new Date each call, so a caller cannot move the clock by mutating it. */
  now(): Date {
    return new Date(this.#ms);
  }

  epochMs(): number {
    return this.#ms;
  }

  set(at: Date | string | number): void {
    this.#ms = toMs(at);
  }

  /** Moves forward; a clock never runs backwards (use `set` to start a scene again). */
  advance(by: Duration | number): Date {
    const ms = durationMs(by);
    if (ms < 0) throw new Error("the frozen clock moves forward only");
    this.#ms += ms;
    return this.now();
  }
}

/** The part of Playwright's BrowserContext (or Page) this needs. */
export interface ClockOwner {
  readonly clock: {
    setFixedTime(time: number | string | Date): Promise<void>;
    install(options?: { time?: number | string | Date }): Promise<void>;
    pauseAt(time: number | string | Date): Promise<void>;
  };
}

/**
 * Freezes a browser context's clock at `at`. "fixed" pins `Date` and leaves timers running (the
 * default for journeys: stable dates, a live page); "paused" installs Playwright's fake timers and
 * pauses them, so a test of a countdown or an expiry moves time itself with `clock.runFor`.
 */
export async function freezeBrowserClock(
  owner: ClockOwner,
  at: Date | string | number = CANON_TIME,
  mode: "fixed" | "paused" = "fixed",
): Promise<void> {
  const time = toMs(at);
  if (mode === "fixed") {
    await owner.clock.setFixedTime(time);
    return;
  }
  await owner.clock.install({ time });
  await owner.clock.pauseAt(time);
}
