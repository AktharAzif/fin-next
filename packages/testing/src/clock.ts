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

/** How a journey run tells the time (`e2eClock`): its stand-ins, its browsers and its tests. */
export interface RunClock {
  /** "wall", or the ISO time the clock stands at. */
  readonly setting: string;
  /** Milliseconds since the epoch. */
  now(): number;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The run's clock, from FIN_E2E_CLOCK: what the stand-ins sign, stamp and check with, and where
 * the fixtures start the browser clock and the Node-side clock (`journeyClock`). So the Access
 * stand-in's `iat`, `nbf` and `exp` agree with the clock the API halves' test servers check them
 * against (spec 01 §7.7), and a page's `Date.now()` with the servers' timestamps. Unset, "" or
 * "canon": stopped at CANON_TIME, where the servers' controllable clock starts; an ISO 8601 time
 * with its offset: stopped there; "wall": the system clock, for servers that check against wall
 * time. Anything else throws.
 */
export function e2eClock(value: string | undefined = process.env.FIN_E2E_CLOCK): RunClock {
  const given = value?.trim() ?? "";
  if (given === "wall") return { setting: "wall", now: () => Date.now() };
  const iso = given === "" || given === "canon" ? CANON_TIME : given;
  const ms = ISO_TIME.test(iso) ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new Error(
      "FIN_E2E_CLOCK is canon, wall, or an ISO 8601 time such as 2026-11-16T10:00:00Z",
    );
  }
  return { setting: new Date(ms).toISOString(), now: () => ms };
}

/** Where a journey's browser clock starts, and how it runs (the fixtures' clock defaults). */
export interface JourneyClock {
  /** "fixed" pins Date at `time`; "off" leaves the browser on the system clock. */
  readonly mode: "fixed" | "off";
  /** ISO 8601: where the run's clock stands when the test starts. */
  readonly time: string;
}

/**
 * A journey's clock from the run's clock, so the browser and the Node-side clock agree with the
 * stand-ins and the servers, which read the same FIN_E2E_CLOCK. A stopped run clock (canon, or an
 * ISO time) pins the browser there; "wall" leaves the browser on the system clock, which the
 * servers and the stand-ins read too, and `time` is the moment the test started.
 */
export function journeyClock(run: RunClock = e2eClock()): JourneyClock {
  return {
    mode: run.setting === "wall" ? "off" : "fixed",
    time: new Date(run.now()).toISOString(),
  };
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
