import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANON_TIME,
  type ClockOwner,
  durationMs,
  e2eClock,
  FrozenClock,
  freezeBrowserClock,
  type JourneyClock,
  journeyClock,
  resolveTestClock,
} from "./clock.ts";

describe("FrozenClock", () => {
  it("starts at the canon's time and stays there", () => {
    const clock = new FrozenClock();
    expect(clock.now().toISOString()).toBe(CANON_TIME);
    expect(clock.now().getTime()).toBe(clock.epochMs());
  });

  it("hands out copies, so a caller cannot move it", () => {
    const clock = new FrozenClock();
    clock.now().setFullYear(2000);
    expect(clock.now().toISOString()).toBe(CANON_TIME);
  });

  it("moves forward when told, and only forward", () => {
    const clock = new FrozenClock("2026-11-16T10:00:00Z");
    expect(clock.advance({ minutes: 10, seconds: 1 }).toISOString()).toBe(
      "2026-11-16T10:10:01.000Z",
    );
    expect(clock.advance(999).toISOString()).toBe("2026-11-16T10:10:01.999Z");
    expect(() => clock.advance(-1)).toThrow("forward only");
    clock.set(0);
    expect(clock.epochMs()).toBe(0);
  });

  it("refuses an invalid time", () => {
    expect(() => new FrozenClock("not a date")).toThrow("not a valid time");
  });

  it("adds durations", () => {
    expect(durationMs({ days: 1, hours: 1, minutes: 1, seconds: 1, ms: 1 })).toBe(90_061_001);
    expect(durationMs(5)).toBe(5);
  });
});

describe("e2eClock (FIN_E2E_CLOCK)", () => {
  it("stands at the canon's time unless told otherwise, where the servers' clock starts", () => {
    for (const value of [undefined, "", "canon", "  canon "]) {
      const clock = e2eClock(value);
      expect(clock.setting).toBe(CANON_TIME);
      expect(clock.now()).toBe(Date.parse(CANON_TIME));
    }
  });

  it("stands at a given ISO time, or follows the system clock for 'wall'", () => {
    const given = e2eClock("2026-11-18T09:30:00+05:45");
    expect(given.setting).toBe("2026-11-18T03:45:00.000Z");
    expect(given.now()).toBe(Date.parse("2026-11-18T03:45:00Z"));
    const wall = e2eClock("wall");
    expect(wall.setting).toBe("wall");
    expect(Math.abs(wall.now() - Date.now())).toBeLessThan(1000);
  });

  it("refuses anything else, rather than signing at a time nobody chose", () => {
    for (const value of [
      "now",
      "2026-11-16",
      "1731751200000",
      "2026-13-40T99:00:00Z",
      "16 Nov 2026",
    ]) {
      expect(() => e2eClock(value)).toThrow("FIN_E2E_CLOCK");
    }
  });
});

describe("journeyClock (the fixtures' browser and Node clock)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins the browser where a stopped run clock stands", () => {
    expect(journeyClock(e2eClock("canon"))).toEqual({ mode: "fixed", time: CANON_TIME });
    expect(journeyClock(e2eClock("2026-11-18T09:00:00-07:00"))).toEqual({
      mode: "fixed",
      time: "2026-11-18T16:00:00.000Z",
    });
  });

  it("leaves the browser on the system clock for 'wall', starting where it stands", () => {
    const before = Date.now();
    const clock = journeyClock(e2eClock("wall"));
    expect(clock.mode).toBe("off");
    expect(Date.parse(clock.time)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(clock.time)).toBeLessThanOrEqual(Date.now());
  });

  it("reads FIN_E2E_CLOCK as it is called, as the stand-ins do", () => {
    vi.stubEnv("FIN_E2E_CLOCK", "2026-11-18T09:00:00Z");
    expect(journeyClock()).toEqual({ mode: "fixed", time: "2026-11-18T09:00:00.000Z" });
    vi.stubEnv("FIN_E2E_CLOCK", "");
    expect(journeyClock()).toEqual({ mode: "fixed", time: CANON_TIME });
    vi.stubEnv("FIN_E2E_CLOCK", "wall");
    expect(journeyClock().mode).toBe("off");
    vi.stubEnv("FIN_E2E_CLOCK", "yesterday");
    expect(() => journeyClock()).toThrow("FIN_E2E_CLOCK");
  });
});

describe("resolveTestClock (a test's clock options and the run's, together)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const SCENE = "2026-12-01T00:00:00.000Z";
  const wallRun = (): JourneyClock => ({ mode: "off", time: "2026-11-21T08:00:00.000Z" });
  const canonRun = (): JourneyClock => ({ mode: "fixed", time: CANON_TIME });

  it("pins the browser at the test's own clockTime, in a wall run too, and the Node clock with it", () => {
    for (const run of [wallRun, canonRun]) {
      expect(resolveTestClock({ clockTime: SCENE }, run)).toEqual({ mode: "fixed", time: SCENE });
    }
    vi.stubEnv("FIN_E2E_CLOCK", "wall");
    expect(resolveTestClock({ clockTime: SCENE })).toEqual({ mode: "fixed", time: SCENE });
  });

  it("keeps the test's own clockMode beside its clockTime", () => {
    for (const clockMode of ["fixed", "paused", "off"] as const) {
      expect(resolveTestClock({ clockMode, clockTime: SCENE }, wallRun)).toEqual({
        mode: clockMode,
        time: SCENE,
      });
    }
  });

  it("follows the run's clock when the test sets no clockTime, its clockMode over the run's", () => {
    expect(resolveTestClock({}, wallRun)).toEqual(wallRun());
    expect(resolveTestClock({ clockMode: undefined, clockTime: undefined }, canonRun)).toEqual(
      canonRun(),
    );
    expect(resolveTestClock({ clockMode: "paused" }, wallRun)).toEqual({
      mode: "paused",
      time: wallRun().time,
    });
    vi.stubEnv("FIN_E2E_CLOCK", "2026-11-18T09:00:00-07:00");
    expect(resolveTestClock({})).toEqual({ mode: "fixed", time: "2026-11-18T16:00:00.000Z" });
  });

  it("reads the run's clock only when the test leaves clockTime unset", () => {
    let reads = 0;
    const counted = () => {
      reads += 1;
      return wallRun();
    };
    resolveTestClock({ clockTime: SCENE }, counted);
    resolveTestClock({ clockMode: "paused", clockTime: SCENE }, counted);
    expect(reads).toBe(0);
    resolveTestClock({ clockMode: "fixed" }, counted);
    expect(reads).toBe(1);
  });

  it("gives the time in UTC, and refuses a clockTime that is not a time", () => {
    expect(resolveTestClock({ clockTime: "2026-11-30T17:00:00-07:00" }, wallRun).time).toBe(SCENE);
    expect(() => resolveTestClock({ clockTime: "soon" }, wallRun)).toThrow(
      "clockTime is not a valid time",
    );
  });
});

describe("freezeBrowserClock", () => {
  function owner() {
    const calls: string[] = [];
    const clock: ClockOwner["clock"] = {
      setFixedTime: async (t) => void calls.push(`fixed ${String(t)}`),
      install: async (o) => void calls.push(`install ${String(o?.time)}`),
      pauseAt: async (t) => void calls.push(`pause ${String(t)}`),
    };
    return { calls, owner: { clock } };
  }

  it("pins Date by default", async () => {
    const { calls, owner: o } = owner();
    await freezeBrowserClock(o);
    expect(calls).toEqual([`fixed ${Date.parse(CANON_TIME)}`]);
  });

  it("installs and pauses fake timers when asked", async () => {
    const { calls, owner: o } = owner();
    await freezeBrowserClock(o, "2026-11-16T10:00:00Z", "paused");
    const at = Date.parse("2026-11-16T10:00:00Z");
    expect(calls).toEqual([`install ${at}`, `pause ${at}`]);
  });
});
