// Fin's IDs: `<prefix>_<26 Crockford base32 characters>`, time-ordered (DECISIONS DA-02, ARCHITECTURE
// §6.2): 10 characters of milliseconds from the unit's Clock, then 16 of randomness from node:crypto,
// lower case, without i, l, o or u. The catalogue of prefixes is packages/core's (P0-D); the database
// checks every ID it stores against the same alphabet, so this module and core's must agree, which
// the shape test pins.
import { randomBytes } from "node:crypto";
import type { Clock } from "./context.ts";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const MAX_TIME = 2 ** 48 - 1;

export const ID_BODY = /^[0-9a-hjkmnp-tv-z]{26}$/;

export function idPattern(prefix: string): RegExp {
  if (!/^[a-z]{2,4}$/.test(prefix))
    throw new TypeError("an ID prefix is 2 to 4 lower-case letters");
  return new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`);
}

export function isId(prefix: string, value: unknown): value is string {
  return typeof value === "string" && idPattern(prefix).test(value);
}

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) throw new RangeError("time out of range");
  let out = "";
  let rest = ms;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = (ALPHABET[rest % 32] ?? "0") + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 16 characters carry 80 bits: take 10 bytes, 5 bits at a time.
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes.subarray(0, 10)) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31] ?? "0";
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

export interface IdSource {
  newId(prefix: string): string;
}

export function createIdSource(
  clock: Clock,
  random: (size: number) => Uint8Array = (size) => new Uint8Array(randomBytes(size)),
): IdSource {
  return {
    newId(prefix) {
      idPattern(prefix);
      const body = encodeTime(clock.now().getTime()) + encodeRandom(random(10));
      if (body.length !== TIME_CHARS + RANDOM_CHARS) throw new Error("ID body length");
      return `${prefix}_${body}`;
    },
  };
}

/** A new ID from the unit's clock. */
export function newId(prefix: string, clock: Clock): string {
  return createIdSource(clock).newId(prefix);
}
