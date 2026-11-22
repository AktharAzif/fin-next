// Keyed hashes under FIN_LIMIT_KEY_<n> (ARCHITECTURE §7.8, spec 02 §2.4 and §5.6). Addresses,
// browser tokens and network keys are stored and counted only as HMAC-SHA256 values, so a
// table read leaks neither an address nor a cookie. The newest key signs; every configured key
// is tried on lookup, so a key can be rotated without forgetting live rows.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type HashPurpose =
  | "email"
  | "browser"
  | "known_browser"
  | "trusted_browser"
  | "sign_up_browser"
  | "network"
  | "person"
  | "limit";

export interface LimitKey {
  version: number;
  key: Uint8Array;
}

export class KeyedHasher {
  readonly #keys: readonly LimitKey[];

  constructor(keys: readonly LimitKey[]) {
    if (keys.length === 0) throw new Error("KeyedHasher needs at least one key");
    for (const k of keys) {
      if (k.key.byteLength < 32)
        throw new Error(`FIN_LIMIT_KEY_${k.version} is shorter than 32 bytes`);
    }
    this.#keys = [...keys].sort((a, b) => b.version - a.version);
  }

  /** The hash under the newest key. */
  hash(purpose: HashPurpose, value: string): Buffer {
    return this.#mac(this.#keys[0] as LimitKey, purpose, value);
  }

  /** The hashes under every configured key, newest first (for lookups). */
  hashes(purpose: HashPurpose, value: string): Buffer[] {
    return this.#keys.map((k) => this.#mac(k, purpose, value));
  }

  /** A short, stable key for limit buckets (hex of the newest-key hash). */
  bucket(purpose: HashPurpose, value: string): string {
    return this.hash(purpose, value).subarray(0, 16).toString("hex");
  }

  #mac(key: LimitKey, purpose: HashPurpose, value: string): Buffer {
    return createHmac("sha256", key.key).update(`${purpose}\u0000${value}`).digest();
  }
}

/** A browser token: 32 random bytes, base64url (spec 02 §2.4). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
