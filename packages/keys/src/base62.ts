// Base62 (spec 05 §4.1): the alphabet of an API key's secret and checksum, in this order, digits
// first, then upper case, then lower case. Browser-safe: this file imports nothing.

export const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A non-negative integer (up to 2^53 - 1) in base62, most significant digit first, left-padded
 * with "0" to `width` characters. A value that needs more than `width` characters is refused.
 */
export function base62(value: number, width: number): string {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("base62 takes a safe integer");
  let rest = value;
  let out = "";
  do {
    out = BASE62_ALPHABET[rest % 62] + out;
    rest = Math.floor(rest / 62);
  } while (rest > 0);
  if (out.length > width) throw new RangeError("the value does not fit the width");
  return out.padStart(width, "0");
}

/**
 * Draws `length` base62 characters from a source of random bytes by rejection sampling: a byte is
 * used only when it is below 248 (62 * 4), so `byte % 62` has no bias toward the first characters.
 * `random(n)` fills n fresh random bytes (crypto.getRandomValues in the caller).
 */
export function base62Random(length: number, random: (n: number) => Uint8Array): string {
  let out = "";
  while (out.length < length) {
    const bytes = random(Math.max(16, (length - out.length) * 2));
    for (const byte of bytes) {
      if (byte >= 248) continue;
      out += BASE62_ALPHABET[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}
