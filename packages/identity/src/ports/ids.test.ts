// The ID encoder pinned to known values. The expected bodies were derived apart from this module:
// the number's radix-32 digits (0-9, a-v) mapped to the Crockford symbol of the same value, which
// leaves out i, l, o and u. The random bytes are fixed by stubbing crypto.getRandomValues, so each
// case is the clock's milliseconds and ten chosen bytes in, one exact ID out.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "./clock.ts";
import { ID_PREFIXES, type IdPrefix, isId, newId } from "./ids.ts";

const MAX_MS = 2 ** 50 - 1;

/** Makes the next random draws return `bytes`. */
function fixRandom(bytes: readonly number[]): void {
  vi.spyOn(crypto, "getRandomValues").mockImplementation(
    <T extends ArrayBufferView | null>(target: T): T => {
      if (target instanceof Uint8Array) target.set(bytes);
      return target;
    },
  );
}

/** The ID `newId` makes at `ms` with the random bytes `bytes`. */
function idFrom(ms: number, bytes: readonly number[], prefix: IdPrefix = "usr"): string {
  fixRandom(bytes);
  return newId(prefix, new ManualClock(new Date(ms)));
}

const zeros = new Array<number>(10).fill(0);
const ones = new Array<number>(10).fill(0xff);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("newId's encoder", () => {
  it.each([
    ["all zero", 0, zeros, "usr_00000000000000000000000000"],
    ["random bits all set", 0, ones, "usr_0000000000zzzzzzzzzzzzzzzz"],
    ["the last millisecond 10 symbols hold", MAX_MS, ones, "usr_zzzzzzzzzzzzzzzzzzzzzzzzzz"],
    ["one millisecond", 1, zeros, "usr_00000000010000000000000000"],
    ["31 milliseconds, the largest single symbol", 31, zeros, "usr_000000000z0000000000000000"],
    ["32 milliseconds, the first carry", 32, zeros, "usr_00000000100000000000000000"],
    [
      "a real time and mixed bytes",
      Date.parse("2026-11-21T10:00:00Z"),
      [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc],
      "usr_01m7yrrt8004hmasw9nf6yzzpw",
    ],
    [
      "another time and counting bytes",
      1_234_567_890_123,
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      "usr_013xrzp16b000g40r40m30e209",
    ],
    [
      "the first random byte's top bit",
      0,
      [0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      "usr_0000000000g000000000000000",
    ],
    [
      "the last byte's low five bits",
      0,
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0x1f],
      "usr_0000000000000000000000000z",
    ],
    [
      "the last byte's sixth bit",
      0,
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0x20],
      "usr_00000000000000000000000010",
    ],
  ])("writes %s exactly", (_name, ms, bytes, expected) => {
    expect(idFrom(ms, bytes)).toBe(expected);
  });

  it("spells each of the 32 values with its own Crockford symbol", () => {
    const symbols = "0123456789abcdefghjkmnpqrstvwxyz";
    for (let value = 0; value < 32; value++) {
      // The value in the last symbol: the low five bits of the last random byte.
      const id = idFrom(0, [0, 0, 0, 0, 0, 0, 0, 0, 0, value]);
      expect(id.at(-1)).toBe(symbols[value]);
      expect(id.slice(4, -1)).toBe("0".repeat(25));
    }
  });

  it("keeps the time in the first 10 symbols and the randomness in the last 16", () => {
    const ms = Date.parse("2026-11-21T10:00:00Z");
    const a = idFrom(ms, zeros).slice(4);
    const b = idFrom(ms, ones).slice(4);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    expect(a.slice(10)).toBe("0".repeat(16));
    expect(b.slice(10)).toBe("z".repeat(16));
  });

  it("puts the prefix in front unchanged, for every prefix in the table", () => {
    for (const prefix of Object.values(ID_PREFIXES)) {
      const id = idFrom(0, zeros, prefix);
      expect(id).toBe(`${prefix}_${"0".repeat(26)}`);
      expect(isId(id, prefix)).toBe(true);
    }
  });

  it("orders IDs as text in the order of their times, across every carry", () => {
    const times = [0, 1, 31, 32, 33, 1023, 1024, 32 ** 5 - 1, 32 ** 5, 1_795_255_200_000, MAX_MS];
    const ids = times.map((ms, i) => idFrom(ms, i % 2 === 0 ? ones : zeros));
    expect([...ids].sort()).toEqual(ids);
  });

  it("orders IDs from the same millisecond by their random bytes", () => {
    const ms = 1_795_255_200_000;
    const low = idFrom(ms, [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const high = idFrom(ms, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(low < high).toBe(true);
  });

  it("takes its time from the given clock and its randomness from crypto", () => {
    const clock = new ManualClock("2026-11-21T10:00:00Z");
    const spy = vi.spyOn(crypto, "getRandomValues");
    const id = newId("ses", clock);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(id.slice(4, 14)).toBe("01m7yrrt80");
    expect(isId(id, "ses")).toBe(true);
  });

  it("never writes a letter Crockford leaves out", () => {
    const clock = new ManualClock("2026-11-21T10:00:00Z");
    for (let i = 0; i < 200; i++) {
      clock.advance(7_919);
      expect(newId("req", clock)).toMatch(/^req_[0-9a-hjkmnp-tv-z]{26}$/);
    }
  });

  it("refuses a time it cannot write instead of cutting it short", () => {
    expect(() => idFrom(MAX_MS + 1, zeros)).toThrow(RangeError);
    expect(() => idFrom(-1, zeros)).toThrow(RangeError);
    expect(() => newId("usr", new ManualClock("not a date"))).toThrow(RangeError);
  });
});
