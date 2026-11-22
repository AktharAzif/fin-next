import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createManualClock } from "./clock.ts";
import { ID_PREFIXES, type IdPrefix, idAt, idTime, isId, newId, type RandomFill } from "./ids.ts";

const T = Date.UTC(2026, 10, 21, 8, 0, 0, 123);

describe("newId", () => {
  it("makes <prefix>_<26 lower-case Crockford characters> from the clock", () => {
    const id = newId("req", createManualClock(T));
    expect(id).toMatch(/^req_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(idTime(id)).toBe(T);
    expect(isId(id, "req")).toBe(true);
    expect(isId(id, "job")).toBe(false);
  });

  it("takes its randomness from the fill it is given", () => {
    const zeros = newId("job", createManualClock(T), (b) => b.fill(0));
    expect(zeros).toBe(idAt("job", T));
    const ones = newId("job", createManualClock(T), (b) => b.fill(255));
    expect(ones.endsWith("z".repeat(16))).toBe(true);
  });

  it("orders by time", () => {
    const clock = createManualClock(T);
    const first = newId("evt", clock);
    clock.advance(1);
    const second = newId("evt", clock);
    expect(second > first).toBe(true);
    expect(second >= idAt("evt", T + 1)).toBe(true);
    expect(first < idAt("evt", T + 1)).toBe(true);
  });

  it("refuses a time outside 48 bits", () => {
    expect(() => newId("req", createManualClock(-1))).toThrow(RangeError);
    expect(() => newId("req", createManualClock(2 ** 48))).toThrow(RangeError);
    expect(() => newId("req", createManualClock(1.5))).toThrow(RangeError);
  });
});

// CI's Postgres (postgres:18.7-trixie) sorts text in en_US.utf8 under glibc, which passes over
// punctuation at the first level and sorts upper case beside lower; macOS sorts the same locale by
// bytes. An `ORDER BY id`, a `created_at, id` tie-break or an `id >= idAt(...)` window agrees with
// a sort in code on every server only because an ID's shape keeps it out of that difference: three
// lower-case letters, `_` always fourth, then 26 symbols of one case. This models glibc's order with
// ICU's, punctuation ignored, so the check holds whatever collation the test database has.
describe("IDs under a punctuation-blind collation", () => {
  const glibcLike = new Intl.Collator("en-US", { usage: "sort", ignorePunctuation: true });
  const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const both = (items: readonly string[]) => ({
    codePoint: [...items].sort(byCodePoint),
    glibcLike: [...items].sort(glibcLike.compare),
  });

  it("is a model that reorders what CI's Postgres reordered, and what an ID's shape rules out", () => {
    // The audit registry's two names that a Linux run swapped against the compiled order.
    expect(both(["backup_codes.regenerated", "backup_code.used"])).toEqual({
      codePoint: ["backup_code.used", "backup_codes.regenerated"],
      glibcLike: ["backup_codes.regenerated", "backup_code.used"],
    });
    // Upper case, or a separator that is not in the same place in every ID, would differ too.
    expect(both(["mem_0a", "mem_0B"])).toEqual({
      codePoint: ["mem_0B", "mem_0a"],
      glibcLike: ["mem_0a", "mem_0B"],
    });
    expect(both(["mem_ab", "mem_a-z"])).toEqual({
      codePoint: ["mem_a-z", "mem_ab"],
      glibcLike: ["mem_ab", "mem_a-z"],
    });
  });

  it("orders IDs, and IDs against idAt's bounds, by code point and under the model alike", () => {
    // A fixed 32-bit linear congruential sequence, so every run checks the same IDs.
    let state = 7;
    const fill: RandomFill = (bytes) => {
      for (let i = 0; i < bytes.length; i++) {
        state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
        bytes[i] = state >>> 24;
      }
      return bytes;
    };
    const times = [0, 1, 31, 32, 1023, 1024, 32 ** 5, T, 2 ** 48 - 1];
    const ids: string[] = [];
    for (const prefix of ["job", "mem", "stf"] as const) {
      for (const ms of times) {
        for (let i = 0; i < 8; i++) ids.push(newId(prefix, createManualClock(ms), fill));
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids.flatMap((id) => [...id.slice(4)])).size).toBe(32);
    const sorted = both(ids);
    expect(sorted.glibcLike).toEqual(sorted.codePoint);
    for (const id of ids) {
      for (const ms of times) {
        const bound = idAt(id.slice(0, 3) as IdPrefix, ms);
        expect(Math.sign(glibcLike.compare(id, bound)), `${id} ${bound}`).toBe(
          Math.sign(byCodePoint(id, bound)),
        );
      }
    }
  });
});

describe("isId", () => {
  it("refuses every other shape", () => {
    const good = newId("cus", createManualClock(T));
    for (const bad of [
      "",
      good.toUpperCase(),
      `${good}x`,
      good.slice(0, -1),
      good.replace("_", "-"),
      `xyz_${good.slice(4)}`,
      `${good.slice(0, 10)}i${good.slice(11)}`,
      `cus_8${good.slice(5)}`,
      42,
      null,
    ]) {
      expect(isId(bad)).toBe(false);
    }
    expect(idTime("nope")).toBeUndefined();
  });
});

describe("the prefix catalogue", () => {
  it("has three lower-case letters per prefix and no duplicate meaning", () => {
    const prefixes = Object.keys(ID_PREFIXES);
    for (const prefix of prefixes) expect(prefix).toMatch(/^[a-z]{3}$/);
    const meanings = Object.values(ID_PREFIXES);
    expect(new Set(meanings).size).toBe(meanings.length);
  });

  it("lists every prefix this package's siblings pass to newId or idAt", () => {
    const packages = join(import.meta.dirname, "..", "..");
    const used = new Set<string>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) {
          for (const m of readFileSync(path, "utf8").matchAll(/\b(?:newId|idAt)\(\s*"([a-z]+)"/g)) {
            if (m[1] !== undefined) used.add(m[1]);
          }
        }
      }
    };
    walk(packages);
    expect(used.size).toBeGreaterThan(0);
    for (const prefix of used) expect(Object.hasOwn(ID_PREFIXES, prefix), prefix).toBe(true);
  });

  it("refuses a duplicate prefix in the catalogue's source", () => {
    const source = readFileSync(join(import.meta.dirname, "ids.ts"), "utf8");
    const block = source.slice(source.indexOf("ID_PREFIXES = {"), source.indexOf("} as const"));
    const keys = [...block.matchAll(/^\s{2}([a-z]{3}):/gm)].map((m) => m[1] as IdPrefix);
    expect(keys.length).toBe(Object.keys(ID_PREFIXES).length);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
