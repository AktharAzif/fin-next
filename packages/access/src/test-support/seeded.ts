// A small seeded random generator for the property tests (spec 02 §20.1: no new dependency).
// Tests only. Mulberry32: 32 bits of state, the same sequence for the same seed on every engine.
// Set FIN_PROPERTY_SEED to replay or widen a run; every failure message names its seed.

export interface Seeded {
  readonly seed: number;
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, max). */
  int(max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** Each element kept with probability `p`, in order. */
  subset<T>(items: readonly T[], p: number): T[];
}

export function seeded(seed: number): Seeded {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number): number => {
    if (!Number.isInteger(max) || max <= 0) throw new RangeError("max must be a positive integer");
    return Math.floor(next() * max);
  };
  return {
    seed: seed >>> 0,
    next,
    int,
    chance: (p) => next() < p,
    pick<T>(items: readonly T[]): T {
      const item = items[int(items.length)];
      if (item === undefined) throw new RangeError("pick needs a non-empty list");
      return item;
    },
    subset: (items, p) => items.filter(() => next() < p),
  };
}

/** The seeds a property test runs with: FIN_PROPERTY_SEED's, or the fixed defaults. */
export function propertySeeds(defaults: readonly number[] = [1, 20261121, 0xf1_00_ac]): number[] {
  const raw = process.env.FIN_PROPERTY_SEED;
  if (raw === undefined || raw.trim() === "") return [...defaults];
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed)) throw new RangeError("FIN_PROPERTY_SEED must be an integer");
  return [seed];
}

/** How many cases each seed runs: FIN_PROPERTY_RUNS, or `fallback`. */
export function propertyRuns(fallback: number): number {
  const raw = process.env.FIN_PROPERTY_RUNS;
  if (raw === undefined || raw.trim() === "") return fallback;
  const runs = Number(raw);
  if (!Number.isSafeInteger(runs) || runs <= 0) {
    throw new RangeError("FIN_PROPERTY_RUNS must be a positive integer");
  }
  return runs;
}
