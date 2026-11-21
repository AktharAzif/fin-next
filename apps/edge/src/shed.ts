// Load shedding (spec 05 §2.1 step 5 and step 14, §3.7; ARCHITECTURE §7.7; [SA-19]), before any
// database work: a per-replica token bucket for the caller's address (IPv6 by its /64) and one for
// the replica in all, and a negative filter of key IDs found not to exist in the last 60 seconds, so
// a flood of well-formed unknown keys (the salt is public) never reaches Postgres. Shedding decides
// nothing about a person: it lives in process memory (the one exception to ARCHITECTURE principle
// 14) and every replica keeps its own. Rates and bursts are settings from the private overlay
// ([OB-13]); the defaults below are for development and tests.
import type { Clock } from "@fin/core";
import { ConfigError } from "@fin/core";
import { parseAddress } from "@fin/keys";

export interface ShedSettings {
  /** Tokens a second for one address, and its bucket's size. */
  addressRate: number;
  addressBurst: number;
  /** Tokens a second for the replica in all, and its bucket's size. */
  totalRate: number;
  totalBurst: number;
  /** How long a key ID found not to exist is refused without a lookup. */
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

  /** A key ID found not to exist: refused without a lookup for the next 60 seconds. */
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
}
