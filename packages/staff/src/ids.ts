// IDs are `<prefix>_<26 Crockford base32 characters>`, time-ordered (ARCHITECTURE §6.2): 10
// characters of milliseconds from the injected clock, then 16 of randomness (80 bits), in the
// lower-case alphabet the database checks. The prefixes this package makes; the catalogue belongs
// to packages/core/src/ids.ts (P0-D), which lists every one of them.
import type { Clock } from "./ports.ts";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export type StaffIdPrefix = "stf" | "enc" | "aud" | "jrn" | "eml" | "sti" | "req";

const SHAPE = /^[a-z]{3}_[0-9a-hjkmnp-tv-z]{26}$/;

export function newId(prefix: StaffIdPrefix, clock: Clock): string {
  let rest = clock.now().getTime();
  if (!Number.isSafeInteger(rest) || rest < 0) throw new RangeError("newId: bad clock");
  let time = "";
  for (let i = 0; i < 10; i += 1) {
    time = ALPHABET[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let random = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      random += ALPHABET[(buffer >> bits) & 31];
    }
  }
  return `${prefix}_${time}${random}`;
}

/** Whether `value` is an ID of the given prefix (a malformed ID in a path is a 404, never a 500). */
export function isIdOf(value: unknown, prefix: string): value is string {
  return typeof value === "string" && SHAPE.test(value) && value.startsWith(`${prefix}_`);
}
