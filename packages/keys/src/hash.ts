// The stored hash and its pepper chain (spec 05 §4.2, D05-09; spec 08 §6). A key is stored as
// HMAC-SHA256(pepper_v, UTF-8 bytes of its body): the whole body, so the mode, kind and ID are bound
// to the secret. A key moved to a newer pepper without its secret stores HMAC(pepper_w, stored), and
// `pepper_versions` lists the chain oldest first ([1, 2]). Peppers are `API_KEY_PEPPER_<n>` (32
// bytes, base64url) on the edge (verify), the console (create) and the worker (re-hash) only;
// `API_KEY_PEPPER_IN_USE` names the one new keys use. Node only (node:crypto through @fin/crypto).
import { constantTimeEqualBytes, hmacSha256, type Keyring } from "@fin/crypto";

export const HASH_BYTES = 32;

/** The pepper a chain names that the keyring does not hold (`pepper-missing`, spec 05 §10.2). */
export class PepperMissingError extends Error {
  override readonly name = "PepperMissingError";
  readonly version: number;
  constructor(version: number) {
    super(`API_KEY_PEPPER_${version} is not present`);
    this.version = version;
  }
}

function pepper(keyring: Keyring, version: number): Uint8Array {
  const key = keyring.key(version);
  if (key === undefined) throw new PepperMissingError(version);
  return key;
}

/** The hash a new key is stored with, under the pepper in use, and its one-entry chain. */
export function hashForStorage(
  keyring: Keyring,
  body: string,
): { hash: Uint8Array; pepperVersions: number[] } {
  const version = keyring.inUse;
  return { hash: hmacSha256(pepper(keyring, version), body), pepperVersions: [version] };
}

/** Applies a chain to a body: the first pepper over the body, each later one over the result. */
export function chainHash(
  keyring: Keyring,
  body: string,
  pepperVersions: readonly number[],
): Uint8Array {
  if (pepperVersions.length === 0) throw new PepperMissingError(0);
  let hash = hmacSha256(pepper(keyring, pepperVersions[0] as number), body);
  for (const version of pepperVersions.slice(1)) hash = hmacSha256(pepper(keyring, version), hash);
  return hash;
}

/** Moves a stored hash onto a newer pepper without the secret (the worker's `keys.rehash`). */
export function rehash(
  keyring: Keyring,
  stored: Uint8Array,
  pepperVersions: readonly number[],
  to: number = keyring.inUse,
): { hash: Uint8Array; pepperVersions: number[] } {
  if (pepperVersions.includes(to)) return { hash: stored, pepperVersions: [...pepperVersions] };
  return { hash: hmacSha256(pepper(keyring, to), stored), pepperVersions: [...pepperVersions, to] };
}

/**
 * Whether the body matches the stored hash under its chain, in constant time. A chain naming a
 * pepper the keyring lacks throws PepperMissingError (the edge refuses the key and alerts).
 */
export function matchesStored(
  keyring: Keyring,
  body: string,
  stored: Uint8Array,
  pepperVersions: readonly number[],
): boolean {
  const computed = chainHash(keyring, body, pepperVersions);
  return stored.byteLength === HASH_BYTES && constantTimeEqualBytes(computed, stored);
}

/**
 * Work equal to one comparison under the pepper in use, for a key with no record: the timing of an
 * unknown key stays close to a wrong one's (spec 05 §4.7).
 */
export function decoyCompare(keyring: Keyring, body: string): void {
  const computed = hmacSha256(pepper(keyring, keyring.inUse), body);
  constantTimeEqualBytes(computed, new Uint8Array(HASH_BYTES));
}
