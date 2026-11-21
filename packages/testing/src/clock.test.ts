import { describe, expect, it } from "vitest";
import {
  CANON_TIME,
  type ClockOwner,
  durationMs,
  FrozenClock,
  freezeBrowserClock,
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
