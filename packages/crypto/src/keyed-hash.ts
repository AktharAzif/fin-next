// Keyed hashes for lookups (ARCHITECTURE §6.6). HMAC-SHA256 throughout:
//   - index hashes (`FIN_INDEX_KEY_<n>`): a subkey per use, organisation and mode, HKDF info
//     `<use>-index:<organization>:<mode>`, so equal emails in two organisations or two modes hash
//     differently and a leak of one subkey reveals nothing about another;
//   - beneficiary fingerprints (`FIN_MONEY_INDEX_KEY_<n>`): HKDF info
//     `fingerprint:beneficiary:<organization>` over `<routing>:<account>`;
//   - limit keys (`FIN_LIMIT_KEY_<n>`) and cursor MACs (`FIN_CURSOR_KEY_<n>`): the family key itself.
// The caller normalises the input (email, phone) before hashing; this module hashes bytes.
import { createHmac } from "node:crypto";
import { utf8 } from "./bytes.ts";
import { constantTimeEqualBytes } from "./compare.ts";
import { hkdfSha256 } from "./hkdf.ts";
import type { Keyring } from "./keyring.ts";

export type IndexUse = "email" | "phone" | "name";
export type Mode = "sandbox" | "live";

const ORGANIZATION = /^[A-Za-z0-9_]{1,64}$/;
const INDEX_SALT = "fin-index-v1";

export function hmacSha256(key: Uint8Array, data: Uint8Array | string): Uint8Array {
  return new Uint8Array(
    createHmac("sha256", key)
      .update(typeof data === "string" ? utf8(data) : data)
      .digest(),
  );
}

function requireKey(keyring: Keyring, version: number): Uint8Array {
  const key = keyring.key(version);
  if (key === undefined) throw new Error(`${keyring.family} version ${version} is not present`);
  return key;
}

function checkOrganization(organization: string): void {
  if (!ORGANIZATION.test(organization)) throw new TypeError("invalid organization");
}

export interface IndexScope {
  use: IndexUse;
  organization: string;
  mode: Mode;
}

/** The index subkey of one version; exported for the known-answer tests. */
export function indexSubkey(key: Uint8Array, scope: IndexScope): Uint8Array {
  checkOrganization(scope.organization);
  return hkdfSha256(key, INDEX_SALT, `${scope.use}-index:${scope.organization}:${scope.mode}`, 32);
}

export interface IndexHash {
  version: number;
  hash: Uint8Array;
}

/**
 * The index hashes a writer stores: one per version in the family's `WRITE` list, so a rotation can
 * dual-write before it switches searches over (spec 08 §6.4).
 */
export function indexHashesForWrite(
  keyring: Keyring,
  scope: IndexScope,
  normalised: string,
): IndexHash[] {
  return keyring.writeVersions.map((version) => ({
    version,
    hash: hmacSha256(indexSubkey(requireKey(keyring, version), scope), normalised),
  }));
}

/** The hash a search uses: under the `IN_USE` version only. */
export function indexHashForSearch(
  keyring: Keyring,
  scope: IndexScope,
  normalised: string,
): IndexHash {
  const version = keyring.inUse;
  return {
    version,
    hash: hmacSha256(indexSubkey(requireKey(keyring, version), scope), normalised),
  };
}

/** A beneficiary fingerprint (payments only), to refuse duplicates without opening sealed numbers. */
export function beneficiaryFingerprint(
  keyring: Keyring,
  organization: string,
  routing: string,
  account: string,
  version: number = keyring.inUse,
): IndexHash {
  checkOrganization(organization);
  if (routing.includes(":")) throw new TypeError("a routing number holds no colon");
  const subkey = hkdfSha256(
    requireKey(keyring, version),
    INDEX_SALT,
    `fingerprint:beneficiary:${organization}`,
    32,
  );
  return { version, hash: hmacSha256(subkey, `${routing}:${account}`) };
}

/** A keyed hash of an address for sending and request limits (`FIN_LIMIT_KEY`). */
export function limitKeyHash(
  keyring: Keyring,
  value: string,
  version: number = keyring.inUse,
): IndexHash {
  return { version, hash: hmacSha256(requireKey(keyring, version), value) };
}

const CURSOR_MAC_BYTES = 16;

/** A truncated MAC over a pagination cursor (`FIN_CURSOR_KEY`). */
export function cursorMac(
  keyring: Keyring,
  data: Uint8Array | string,
  version: number = keyring.inUse,
): Uint8Array {
  return hmacSha256(requireKey(keyring, version), data).subarray(0, CURSOR_MAC_BYTES);
}

/** Checks a cursor MAC in constant time against every version present. */
export function verifyCursorMac(
  keyring: Keyring,
  data: Uint8Array | string,
  mac: Uint8Array,
): boolean {
  let ok = false;
  for (const version of keyring.versions) {
    // Every version is tried, so the time does not say which one matched.
    if (constantTimeEqualBytes(cursorMac(keyring, data, version), mac)) ok = true;
  }
  return ok;
}
