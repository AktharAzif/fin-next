// The edge's two pieces of process memory besides the token buckets, on a clock the test moves:
// "last used" at most once a minute per key (BC-05, spec 05 §2.1 step 23), and the refused-key
// window as this replica counts it for refusals the negative filter answers (spec 05 §3.7, §4.7).
// Both are bounded, and neither ever lets a key through.
import { describe, expect, it } from "vitest";
import { LastUsed } from "./last-used.ts";
import { SHED_DEFAULTS, Shedder } from "./shed.ts";

function movingClock(start = Date.parse("2026-11-22T10:00:05.000Z")) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("last used", () => {
  it("is due once a minute per key, again in the next minute", () => {
    const clock = movingClock();
    const gate = new LastUsed(clock, 100);
    expect(gate.due("AAAAAAAAAA")).toBe(true);
    expect(gate.due("AAAAAAAAAA")).toBe(false);
    expect(gate.due("BBBBBBBBBB")).toBe(true);
    clock.advance(40_000);
    expect(gate.due("AAAAAAAAAA")).toBe(false);
    clock.advance(20_000);
    expect(gate.due("AAAAAAAAAA")).toBe(true);
    expect(gate.due("AAAAAAAAAA")).toBe(false);
  });

  it("keeps at most its bound, forgetting the oldest (which is then touched once more)", () => {
    const clock = movingClock();
    const gate = new LastUsed(clock, 2);
    expect(gate.due("AAAAAAAAAA")).toBe(true);
    expect(gate.due("BBBBBBBBBB")).toBe(true);
    expect(gate.due("CCCCCCCCCC")).toBe(true);
    expect(gate.size).toBe(2);
    expect(gate.due("BBBBBBBBBB")).toBe(false);
    expect(gate.due("AAAAAAAAAA")).toBe(true);
  });
});

describe("the refused-key window in memory", () => {
  it("counts the filter's refusals, never below the database's count, in a fixed minute", () => {
    const clock = movingClock(Date.parse("2026-11-22T10:00:45.000Z"));
    const shedder = new Shedder(SHED_DEFAULTS, clock);
    expect(shedder.refuse("4:8080808", 1)).toEqual({ count: 1, secondsLeft: 15 });
    for (let i = 2; i <= 30; i++) expect(shedder.refuse("4:8080808").count).toBe(i);
    expect(shedder.refuse("4:8080808").count).toBe(31);
    // A refusal that reached the database counts one more, or the database's count if larger.
    expect(shedder.refuse("4:8080808", 3).count).toBe(32);
    expect(shedder.refuse("4:8080808", 40).count).toBe(40);
    // Another address has its own window; a lookup's count lifts it without counting a refusal.
    shedder.seenRefused("6:20010db8", 12);
    expect(shedder.refuse("6:20010db8").count).toBe(13);
    // The next minute starts again.
    clock.advance(15_000);
    expect(shedder.refuse("4:8080808")).toEqual({ count: 1, secondsLeft: 60 });
  });

  it("keeps at most its bound of addresses", () => {
    const shedder = new Shedder({ ...SHED_DEFAULTS, maxEntries: 2 }, movingClock());
    shedder.refuse("4:1", 30);
    shedder.refuse("4:2", 30);
    shedder.refuse("4:3", 30);
    // The oldest was forgotten: it starts again from what it is told next.
    expect(shedder.refuse("4:1").count).toBe(1);
    expect(shedder.refuse("4:3").count).toBe(31);
  });
});
