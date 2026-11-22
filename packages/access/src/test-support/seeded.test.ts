// The property tests' generator: deterministic per seed, in range, and roughly uniform.
import { afterEach, describe, expect, it } from "vitest";
import { propertyRuns, propertySeeds, seeded } from "./seeded.ts";

describe("seeded", () => {
  it("repeats the same sequence for the same seed, and another for another", () => {
    const a = seeded(7);
    const b = seeded(7);
    const c = seeded(8);
    const first = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(first);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(first);
  });

  it("gives floats in [0, 1) and integers in range, roughly uniform", () => {
    const rng = seeded(20261121);
    const counts = [0, 0, 0, 0, 0];
    for (let i = 0; i < 10_000; i += 1) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      const n = rng.int(5);
      counts[n] = (counts[n] ?? 0) + 1;
    }
    for (const count of counts) expect(count).toBeGreaterThan(1_700);
  });

  it("picks, subsets and refuses what it cannot do", () => {
    const rng = seeded(1);
    expect(["a", "b", "c"]).toContain(rng.pick(["a", "b", "c"]));
    expect(rng.subset([1, 2, 3], 0)).toEqual([]);
    expect(rng.subset([1, 2, 3], 1)).toEqual([1, 2, 3]);
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
    expect(() => rng.pick([])).toThrow(RangeError);
    expect(() => rng.int(0)).toThrow(RangeError);
    expect(() => rng.int(1.5)).toThrow(RangeError);
  });
});

describe("the property settings", () => {
  const saved = { seed: process.env.FIN_PROPERTY_SEED, runs: process.env.FIN_PROPERTY_RUNS };
  afterEach(() => {
    for (const [name, value] of [
      ["FIN_PROPERTY_SEED", saved.seed],
      ["FIN_PROPERTY_RUNS", saved.runs],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("use the fixed seeds and the default runs unless told otherwise", () => {
    delete process.env.FIN_PROPERTY_SEED;
    delete process.env.FIN_PROPERTY_RUNS;
    expect(propertySeeds()).toEqual([1, 20261121, 0xf100ac]);
    expect(propertyRuns(25)).toBe(25);
  });

  it("replay one seed, or widen the runs, from the environment", () => {
    process.env.FIN_PROPERTY_SEED = "12345";
    process.env.FIN_PROPERTY_RUNS = "9";
    expect(propertySeeds()).toEqual([12345]);
    expect(propertyRuns(25)).toBe(9);
    process.env.FIN_PROPERTY_SEED = "nope";
    expect(() => propertySeeds()).toThrow(RangeError);
    process.env.FIN_PROPERTY_RUNS = "0";
    expect(() => propertyRuns(25)).toThrow(RangeError);
  });
});
