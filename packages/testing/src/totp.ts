// HOTP (RFC 4226) and TOTP (RFC 6238), so a journey can answer an authenticator step from the
// secret it read at set-up (the `otpauth://` URI or the manual key), and base32 (RFC 4648) for that
// key. The time is always passed in: a test takes it from the frozen clock or the server's.
import { createHmac } from "node:crypto";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes base32, ignoring case, spaces, hyphens and `=` padding (as authenticator apps do). */
export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function secretBytes(secret: Uint8Array | string): Uint8Array {
  return typeof secret === "string" ? base32Decode(secret) : secret;
}

export interface HotpOptions {
  readonly digits?: number;
  readonly algorithm?: TotpAlgorithm;
}

/** RFC 4226 §5.3: the code for an 8-byte counter. A string secret is base32. */
export function hotp(
  secret: Uint8Array | string,
  counter: number | bigint,
  options: HotpOptions = {},
): string {
  const digits = options.digits ?? 6;
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new Error("digits is 6 to 10");
  const big = BigInt(counter);
  if (big < 0n) throw new Error("the counter is not negative");
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, big);
  const algorithm = (options.algorithm ?? "SHA1").toLowerCase();
  const mac = createHmac(algorithm, secretBytes(secret)).update(message).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export interface TotpOptions extends HotpOptions {
  /** Seconds per step (default 30). */
  readonly period?: number;
  /** The Unix time steps count from, in seconds (default 0). */
  readonly t0?: number;
}

/** The step a moment falls in. */
export function totpCounter(timeMs: number, options: TotpOptions = {}): bigint {
  const period = options.period ?? 30;
  const seconds = Math.floor(timeMs / 1000) - (options.t0 ?? 0);
  return BigInt(Math.floor(seconds / period));
}

/** RFC 6238: the code at `timeMs` (milliseconds since the epoch). */
export function totp(
  secret: Uint8Array | string,
  timeMs: number,
  options: TotpOptions = {},
): string {
  return hotp(secret, totpCounter(timeMs, options), options);
}

/** Milliseconds until the next step starts, so a test can avoid typing a code as it expires. */
export function msUntilNextStep(timeMs: number, options: TotpOptions = {}): number {
  const periodMs = (options.period ?? 30) * 1000;
  const sinceT0 = timeMs - (options.t0 ?? 0) * 1000;
  return periodMs - (((sinceT0 % periodMs) + periodMs) % periodMs);
}

export interface OtpauthKey {
  readonly secret: Uint8Array;
  readonly issuer?: string;
  readonly account: string;
  readonly algorithm: TotpAlgorithm;
  readonly digits: number;
  readonly period: number;
}

/** Reads an `otpauth://totp/...` URI, as an authenticator set-up shows it. */
export function parseOtpauthUri(uri: string): OtpauthKey {
  const url = new URL(uri);
  if (url.protocol !== "otpauth:" || url.hostname !== "totp") {
    throw new Error("not an otpauth://totp URI");
  }
  const secret = url.searchParams.get("secret");
  if (secret === null || secret === "") throw new Error("the URI has no secret");
  const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const colon = label.indexOf(":");
  const labelIssuer = colon === -1 ? undefined : label.slice(0, colon);
  const account = colon === -1 ? label : label.slice(colon + 1).trim();
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  if (algorithm !== "SHA1" && algorithm !== "SHA256" && algorithm !== "SHA512") {
    throw new Error("the URI's algorithm is not SHA1, SHA256 or SHA512");
  }
  const issuer = url.searchParams.get("issuer") ?? labelIssuer;
  return {
    secret: base32Decode(secret),
    ...(issuer === undefined ? {} : { issuer }),
    account,
    algorithm,
    digits: Number(url.searchParams.get("digits") ?? "6"),
    period: Number(url.searchParams.get("period") ?? "30"),
  };
}
