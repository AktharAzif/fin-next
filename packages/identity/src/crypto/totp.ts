// RFC 6238 TOTP over node:crypto HMAC-SHA1 (spec 02 §3.6). Fin's own code, used to find the time
// step of an accepted code so a step is never accepted twice across sign-in and step-up
// (totp-replay.ts, [SA-35]). The canonical home is packages/crypto/src/totp.ts (P0-E); until it
// lands it lives here, with RFC 6238's known answers in its test.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface TotpOptions {
  digits?: number;
  period?: number;
}

export function hotp(secret: Uint8Array, counter: bigint, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

export function totpStep(at: Date, period = 30): bigint {
  return BigInt(Math.floor(at.getTime() / 1000 / period));
}

export function totp(secret: Uint8Array, at: Date, options: TotpOptions = {}): string {
  return hotp(secret, totpStep(at, options.period ?? 30), options.digits ?? 6);
}

/**
 * The step (within plus or minus `window` steps of `at`) whose code equals `code`, or null.
 * Compares in constant time per step.
 */
export function matchingStep(
  secret: Uint8Array,
  code: string,
  at: Date,
  options: TotpOptions & { window?: number } = {},
): bigint | null {
  const digits = options.digits ?? 6;
  if (!/^\d+$/.test(code) || code.length !== digits) return null;
  const current = totpStep(at, options.period ?? 30);
  const window = BigInt(options.window ?? 1);
  const given = Buffer.from(code);
  for (let delta = -window; delta <= window; delta += 1n) {
    const step = current + delta;
    if (step < 0n) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step, digits)), given)) return step;
  }
  return null;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "").toUpperCase();
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("base32Decode: not base32");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}
