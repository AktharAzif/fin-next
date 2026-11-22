// The edge's two pieces of process memory besides the token buckets, on a clock the test moves:
// "last used" at most once a minute per key (BC-05, spec 05 §2.1 step 23), and a refused-key window
// Postgres answered full, which the negative filter repeats until no later than the window's end
// (spec 05 §3.7, §4.7). Both are bounded, and neither ever lets a key through.
import type { WindowCount } from "@fin/keys";
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

describe("a refused-key window Postgres answered full", () => {
  /** The count statement as Postgres answers it, taking `tookMs` on the test's clock. */
  const statement =
    (clock: ReturnType<typeof movingClock>, count: number, msLeft: number, tookMs = 0) =>
    async (): Promise<WindowCount> => {
      clock.advance(tookMs);
      return { count, secondsLeft: Math.max(1, Math.ceil(msLeft / 1000)), msLeft };
    };

  it("is kept from just before the statement for the time Postgres had left, never past the window's end", async () => {
    // The replica's clock reads 10:00:45.000; Postgres runs the count 200 ms later, at 10:00:45.200
    // by the same clock, with 14.8 s left in its window, which ends at 10:01:00.000.
    const clock = movingClock(Date.parse("2026-11-22T10:00:45.000Z"));
    const shedder = new Shedder(SHED_DEFAULTS, clock);
    const counted = await shedder.countRefused("4:8080808", statement(clock, 31, 14_800, 200));
    expect(counted).toEqual({ count: 31, secondsLeft: 15, msLeft: 14_800 });
    // Kept until 10:00:59.800, 200 ms before the window's end: so a Retry-After as Postgres gives.
    expect(shedder.refusedFull("4:8080808")).toBe(15);
    clock.advance(14_000);
    expect(shedder.refusedFull("4:8080808")).toBe(1);
    clock.advance(599);
    expect(shedder.refusedFull("4:8080808")).toBe(1);
    clock.advance(1);
    expect(shedder.refusedFull("4:8080808")).toBeNull();
    // Another address was never full.
    expect(shedder.refusedFull("6:20010db8")).toBeNull();
  });

  it("is kept only past the limit, and forgotten when Postgres answers the window under it", async () => {
    const clock = movingClock();
    const shedder = new Shedder(SHED_DEFAULTS, clock);
    await shedder.countRefused("4:1", statement(clock, 30, 50_000));
    expect(shedder.refusedFull("4:1")).toBeNull();
    await shedder.countRefused("4:1", statement(clock, 31, 50_000));
    expect(shedder.refusedFull("4:1")).toBe(50);
    // A count under the limit in the same minute means the window was reset (the database's
    // unlogged windows restarted): the replica follows Postgres at once.
    await shedder.countRefused("4:1", statement(clock, 1, 49_000));
    expect(shedder.refusedFull("4:1")).toBeNull();
  });

  it("changes nothing when the statement fails", async () => {
    const clock = movingClock();
    const shedder = new Shedder(SHED_DEFAULTS, clock);
    await shedder.countRefused("4:1", statement(clock, 31, 30_000));
    const failing = async (): Promise<WindowCount> => {
      throw new Error("down");
    };
    await expect(shedder.countRefused("4:1", failing)).rejects.toThrow("down");
    await expect(shedder.countRefused("4:2", failing)).rejects.toThrow("down");
    expect(shedder.refusedFull("4:1")).toBe(30);
    expect(shedder.refusedFull("4:2")).toBeNull();
  });

  it("keeps at most its bound of addresses", async () => {
    const clock = movingClock();
    const shedder = new Shedder({ ...SHED_DEFAULTS, maxEntries: 2 }, clock);
    for (const address of ["4:1", "4:2", "4:3"]) {
      await shedder.countRefused(address, statement(clock, 31, 30_000));
    }
    // The oldest was forgotten: its next refusal goes to Postgres again, which answers it.
    expect(shedder.refusedFull("4:1")).toBeNull();
    expect(shedder.refusedFull("4:2")).toBe(30);
    expect(shedder.refusedFull("4:3")).toBe(30);
  });
});
