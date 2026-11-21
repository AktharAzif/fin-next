// Crockford's base32 in upper case (spec 05 §4.1): the alphabet of an API key's 10-character ID,
// which leaves out I, L, O and U so a key read aloud or retyped is not mistaken. Browser-safe: this
// file imports nothing.

/** Crockford's base32 alphabet, upper case: 0-9, A-H, J, K, M, N, P-T, V-Z. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The key ID's length in characters (50 bits). */
export const KEY_ID_LENGTH = 10;

const KEY_ID = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/** Whether `value` is a key ID's shape: 10 upper-case Crockford characters, nothing else. */
export function isKeyId(value: unknown): value is string {
  return typeof value === "string" && KEY_ID.test(value);
}

/**
 * Encodes random bytes as Crockford characters, five bits a character, so every character of the
 * alphabet is equally likely. `bytes` must hold at least `ceil(length * 5 / 8)` bytes.
 */
export function crockfordFromBytes(bytes: Uint8Array, length: number): string {
  if (bytes.length * 8 < length * 5) throw new RangeError("not enough random bytes");
  let out = "";
  let buffer = 0;
  let bits = 0;
  let index = 0;
  while (out.length < length) {
    if (bits < 5) {
      buffer = ((buffer << 8) | (bytes[index] as number)) & 0xffff;
      index += 1;
      bits += 8;
    }
    bits -= 5;
    out += CROCKFORD_ALPHABET[(buffer >> bits) & 31];
  }
  return out;
}
