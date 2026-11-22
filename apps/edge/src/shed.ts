// Load shedding (spec 05 §2.1 step 5 and step 14, §3.7; ARCHITECTURE §7.7; [SA-19]), before any
// database work: a per-replica token bucket for the caller's address (IPv6 by its /64) and one for
// the replica in all, and a negative filter of key IDs found not to exist in the last 60 seconds.
// Shedding decides nothing about a person: it lives in process memory (the one exception to
// ARCHITECTURE principle 14) and every replica keeps its own. Rates and bursts are settings from the
// private overlay ([OB-13]); the defaults below are for development and tests.
//
// The negative filter only repeats what Postgres has decided. Whether a refused key gets 401 or 429
// is the address's `refused_keys` window (spec 05 §3.7), which lives in Postgres and counts every
// refusal that reaches it, from every replica. Once a count answers past the limit, every refused
// key from that address is 429 until the window ends, and nothing changes that sooner. So the
// replica remembers that answer, per address, until a time it takes from the answer that is never
// past the window's real end; and only while it does, the filter refuses a key ID found not to exist
// with that 429, without a statement. Otherwise such an ID goes on to the statement like any other
// key and Postgres counts its refusal. An ID with no row therefore reaches the 429 after exactly as
// many refusals as one with a row, however many replicas share the address's requests (§4.7,
// T05-08), and is told to wait as long (the filter's end is early by at most the count's round
// trip); and a flood of a key ID found not to exist stops reaching Postgres once its address's
// window is full (T05-10). The filter never answers a 401 and never lets a key through.
import type { Clock } from "@fin/core";
import { ConfigError } from "@fin/core";
import { parseAddress, REFUSED_KEYS_LIMIT, type WindowCount } from "@fin/keys";

export interface ShedSettings {
  /** Tokens a second for one address, and its bucket's size. */
  addressRate: number;
  addressBurst: number;
  /** Tokens a second for the replica in all, and its bucket's size. */
  totalRate: number;
  totalBurst: number;
  /**
   * How long a key ID found not to exist is remembered: refused without a lookup, in that time,
   * from an address whose refused-key window this replica knows is full.
   */
  negativeTtlMs: number;
  /** The most addresses and unknown key IDs kept; the oldest go first. */
  maxEntries: number;
}

export const SHED_DEFAULTS: ShedSettings = {
  addressRate: 50,
  addressBurst: 100,
  totalRate: 2000,
  totalBurst: 4000,
  negativeTtlMs: 60_000,
  maxEntries: 50_000,
};

const SETTINGS: readonly [keyof ShedSettings, string][] = [
  ["addressRate", "FIN_EDGE_SHED_ADDRESS_RATE"],
  ["addressBurst", "FIN_EDGE_SHED_ADDRESS_BURST"],
  ["totalRate", "FIN_EDGE_SHED_TOTAL_RATE"],
  ["totalBurst", "FIN_EDGE_SHED_TOTAL_BURST"],
];

/** Reads the overlay's settings, each a positive integer; a malformed one refuses to start. */
export function shedSettings(env: Readonly<Record<string, string | undefined>>): ShedSettings {
  const out: ShedSettings = { ...SHED_DEFAULTS };
  for (const [field, variable] of SETTINGS) {
    const raw = env[variable];
    if (raw === undefined || raw === "") continue;
    if (!/^[1-9][0-9]{0,6}$/.test(raw)) throw new ConfigError(variable, "malformed");
    out[field] = Number(raw);
  }
  return out;
}

/** The address a bucket is kept for: an IPv4 address, or an IPv6 address's /64. */
export function addressKey(clientIp: string | undefined): string {
  if (clientIp === undefined) return "unknown";
  const address = parseAddress(clientIp);
  if (address === null) return "unknown";
  if (address.family === 4) return `4:${address.value.toString(16)}`;
  if (address.value >> 32n === 0xffffn) return `4:${(address.value & 0xffffffffn).toString(16)}`;
  return `6:${(address.value >> 64n).toString(16)}`;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class Shedder {
  readonly #settings: ShedSettings;
  readonly #clock: Clock;
  readonly #buckets = new Map<string, Bucket>();
  readonly #total: Bucket;
  readonly #unknown = new Map<string, number>();
  /** Address to the time (this replica's clock) until which Postgres's refused-key window is full. */
  readonly #full = new Map<string, number>();
  shed = 0;

  constructor(settings: ShedSettings, clock: Clock) {
    this.#settings = settings;
    this.#clock = clock;
    this.#total = { tokens: settings.totalBurst, at: clock.now() };
  }

  #take(bucket: Bucket, rate: number, burst: number, now: number): boolean {
    bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * rate);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Whether the request may go on: false sheds it (429, `Retry-After: 1`). */
  admit(address: string): boolean {
    const now = this.#clock.now();
    const s = this.#settings;
    let bucket = this.#buckets.get(address);
    if (bucket === undefined) {
      if (this.#buckets.size >= s.maxEntries) {
        const oldest = this.#buckets.keys().next().value;
        if (oldest !== undefined) this.#buckets.delete(oldest);
      }
      bucket = { tokens: s.addressBurst, at: now };
      this.#buckets.set(address, bucket);
    }
    const ok =
      this.#take(bucket, s.addressRate, s.addressBurst, now) &&
      this.#take(this.#total, s.totalRate, s.totalBurst, now);
    if (!ok) this.shed += 1;
    return ok;
  }

  /** A key ID found not to exist, remembered for the next 60 seconds (`negativeTtlMs`). */
  rememberUnknown(keyId: string): void {
    if (this.#unknown.size >= this.#settings.maxEntries) {
      const oldest = this.#unknown.keys().next().value;
      if (oldest !== undefined) this.#unknown.delete(oldest);
    }
    this.#unknown.delete(keyId);
    this.#unknown.set(keyId, this.#clock.now() + this.#settings.negativeTtlMs);
  }

  knownUnknown(keyId: string): boolean {
    const until = this.#unknown.get(keyId);
    if (until === undefined) return false;
    if (until > this.#clock.now()) return true;
    this.#unknown.delete(keyId);
    return false;
  }

  /**
   * Runs the count of the address's refused-key window (`count`, its statement) and keeps what
   * Postgres answers. Past the limit, the window is full until it ends: the time read just before the
   * statement was sent, plus the milliseconds Postgres had left (rounded down), is never later than
   * that end, whatever the offset between this replica's clock and the database's. At or under the
   * limit, the replica forgets any window it kept for the address: Postgres's latest answer wins (a
   * window can be reset, as the unlogged windows are when the database restarts), and forgetting
   * costs at most one more statement. A statement that fails changes nothing.
   */
  async countRefused(address: string, count: () => Promise<WindowCount>): Promise<WindowCount> {
    const sentAt = this.#clock.now();
    const counted = await count();
    this.#full.delete(address);
    if (counted.count > REFUSED_KEYS_LIMIT) {
      if (this.#full.size >= this.#settings.maxEntries) {
        const oldest = this.#full.keys().next().value;
        if (oldest !== undefined) this.#full.delete(oldest);
      }
      this.#full.set(address, sentAt + counted.msLeft);
    }
    return counted;
  }

  /**
   * While this replica knows Postgres's refused-key window for the address is full, the seconds
   * left in it (at least 1, rounded up as Postgres's own count answers them); otherwise null.
   */
  refusedFull(address: string): number | null {
    const until = this.#full.get(address);
    if (until === undefined) return null;
    const left = until - this.#clock.now();
    if (left > 0) return Math.ceil(left / 1000);
    this.#full.delete(address);
    return null;
  }
}
