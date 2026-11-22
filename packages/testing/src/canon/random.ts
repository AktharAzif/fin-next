// A seeded random generator for property tests and generated fixtures (spec 02 §20.1, L-SAT-08:
// "a seeded random generator for property tests (no new dependency)"). sfc32, seeded from the
// SHA-256 of the seed text, so the same seed gives the same sequence on every machine. Never use
// it for anything secret: keys, codes and secrets in tests come from node:crypto at run time.
import { createHash } from "node:crypto";

export interface SeededRandom {
  /** The seed text, to print beside a failing case so it can be replayed. */
  readonly seed: string;
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  bool(probability?: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** A new array in a random order (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[];
  /** `count` distinct items. */
  sample<T>(items: readonly T[], count: number): T[];
  bytes(length: number): Uint8Array;
  /** An independent generator for a named part of a test, stable whatever else is drawn. */
  fork(label: string): SeededRandom;
}

function state(seed: string): [number, number, number, number] {
  const digest = createHash("sha256").update(seed).digest();
  return [
    digest.readUInt32LE(0),
    digest.readUInt32LE(4),
    digest.readUInt32LE(8),
    digest.readUInt32LE(12),
  ];
}

export function seededRandom(seed: string | number): SeededRandom {
  const text = String(seed);
  let [a, b, c, d] = state(text);
  const nextUint32 = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  };
  // Discard the first outputs, as sfc32's authors advise.
  for (let i = 0; i < 12; i += 1) nextUint32();
  const random: SeededRandom = {
    seed: text,
    next: () => nextUint32() / 4294967296,
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new Error("int(min, max) takes integers with min <= max");
      }
      return min + Math.floor(random.next() * (max - min + 1));
    },
    bool: (probability = 0.5) => random.next() < probability,
    pick(items) {
      if (items.length === 0) throw new Error("pick needs at least one item");
      return items[random.int(0, items.length - 1)] as (typeof items)[number];
    },
    shuffle(items) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = random.int(0, i);
        [copy[i], copy[j]] = [copy[j] as (typeof copy)[number], copy[i] as (typeof copy)[number]];
      }
      return copy;
    },
    sample(items, count) {
      if (count > items.length) throw new Error("sample asks for more items than there are");
      return random.shuffle(items).slice(0, count);
    },
    bytes(length) {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) out[i] = nextUint32() & 0xff;
      return out;
    },
    fork: (label) => seededRandom(`${text}/${label}`),
  };
  return random;
}

/** The seed for a run: FIN_TEST_SEED when set (to replay a failure), else `fallback`. */
export function seedFromEnv(fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const given = env.FIN_TEST_SEED;
  return given !== undefined && given !== "" ? given : fallback;
}
