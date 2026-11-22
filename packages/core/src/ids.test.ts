import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createManualClock } from "./clock.ts";
import { ID_PREFIXES, type IdPrefix, idAt, idTime, isId, newId } from "./ids.ts";

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
