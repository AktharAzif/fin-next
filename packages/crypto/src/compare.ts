// Constant-time comparisons (ARCHITECTURE §7). `timingSafeEqual` needs equal lengths and leaks the
// length through its refusal, so values of any length are first reduced to SHA-256 digests, which
// are always 32 bytes: the time taken then depends on neither the content nor where they differ.
import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: Uint8Array | string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Equal-length byte arrays compared in constant time; arrays of different length are unequal. */
export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    // Still do the same amount of work, so a caller cannot time the length check alone.
    timingSafeEqual(digest(a), digest(a));
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Compares two secrets (strings or bytes) of any length without leaking where they differ or, for
 * values up to the hash block size, how long they are. Use this for codes, tokens and MACs.
 */
export function constantTimeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const left = typeof a === "string" ? Buffer.from(a, "utf8") : a;
  const right = typeof b === "string" ? Buffer.from(b, "utf8") : b;
  const same = timingSafeEqual(digest(left), digest(right));
  // A digest collision is not a concern for SHA-256; the length check makes equality exact.
  return same && left.byteLength === right.byteLength;
}
