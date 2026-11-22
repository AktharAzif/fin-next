// Fin IDs for the rows this package makes: `eml_` for outbox rows and `job_` for duty runs
// (ARCHITECTURE §6.2): a ULID in lower-case Crockford base32, the time from the injected clock and
// 80 bits from crypto.getRandomValues. It matches `@fin/core`'s ids.ts (P0-D, under review); this
// package switches to that module once it is on main (recorded in the pull request).
import { webcrypto } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export interface IdClock {
  now(): number;
}

function encodeTime(ms: number): string {
  let rest = Math.floor(ms);
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ALPHABET.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out = ALPHABET.charAt(Number(value & 31n)) + out;
    value >>= 5n;
  }
  return out;
}

export function newId(prefix: "eml" | "job", clock: IdClock): string {
  const bytes = new Uint8Array(10);
  webcrypto.getRandomValues(bytes);
  return `${prefix}_${encodeTime(clock.now())}${encodeRandom(bytes)}`;
}

export const EMAIL_ID = /^eml_[0-9a-hjkmnp-tv-z]{26}$/u;
