// IDs are `<prefix>_<26 Crockford base32 characters>`, time-ordered (ARCHITECTURE §6.2): 10
// characters of milliseconds from the injected clock, then 16 of randomness (80 bits). The
// alphabet is the lower-case Crockford set the database checks (`[0-9a-hjkmnp-tv-z]`).
//
// The catalogue of prefixes belongs to packages/core/src/ids.ts (P0-D). Until it lands, this
// package names its own prefixes here; the new ones (ver, brw, emr, sur) are asked of P0-D
// through the lane board (spec 02 §13.1, IF-01).
import type { Clock } from "./clock.ts";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export const ID_PREFIXES = {
  user: "usr",
  session: "ses",
  account: "acc",
  verification: "ver",
  passkey: "pky",
  twoFactor: "tfa",
  assurance: "asr",
  knownBrowser: "brw",
  trustedBrowser: "tbr",
  emailCodeRequest: "emr",
  signUpRequest: "sur",
  stepUpIntent: "sti",
  organization: "org",
  member: "mem",
  staffMember: "stf",
  staffSession: "sts",
  enrolmentCode: "enc",
  audit: "aud",
  email: "eml",
  request: "req",
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

const ID_SHAPE = /^[a-z]{3}_[0-9a-hjkmnp-tv-z]{26}$/;

// The part after the prefix is a single number of 26 × 5 = 130 bits, written in Crockford base32:
// the most significant symbol first, each symbol carrying 5 bits. Its high 50 bits are the
// clock's milliseconds and its low 80 bits are the random bytes, so the first 10 symbols spell the
// time alone and the last 16 the randomness. Because every body has the same width and the
// alphabet is in ascending character order, comparing two IDs as text compares their times.
const BODY_SYMBOLS = 26;
const TIME_SYMBOLS = 10;
const RANDOM_BYTES = 10;
/** The first millisecond that no longer fits in 10 symbols (32 ** 10, that is 2 ** 50). */
const TIME_LIMIT = 32 ** TIME_SYMBOLS;

/**
 * Writes a non-negative `value` as exactly `width` Crockford symbols. Shorter numbers are
 * zero-extended at the front, as the specification asks; a number too wide for `width`, or a
 * negative one, is refused rather than cut short.
 */
function crockford(value: bigint, width: number): string {
  let text = "";
  let remaining = value;
  for (let written = 0; written < width; written++) {
    text = ALPHABET.charAt(Number(remaining & 0x1fn)) + text;
    remaining >>= 5n;
  }
  if (remaining !== 0n) {
    throw new RangeError(`a value does not fit in ${width} base32 symbols`);
  }
  return text;
}

/** The 26 symbols after the prefix, from a time in milliseconds and the random bytes. */
function idBody(ms: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms >= TIME_LIMIT) {
    throw new RangeError("newId: the clock's time cannot be written in an ID");
  }
  if (random.length !== RANDOM_BYTES) {
    throw new RangeError(`newId: an ID takes exactly ${RANDOM_BYTES} random bytes`);
  }
  let value = BigInt(ms);
  for (const byte of random) value = (value << 8n) | BigInt(byte);
  return crockford(value, BODY_SYMBOLS);
}

export function newId(prefix: IdPrefix, clock: Clock): string {
  const random = new Uint8Array(RANDOM_BYTES);
  crypto.getRandomValues(random);
  return `${prefix}_${idBody(clock.now().getTime(), random)}`;
}

/** True when `value` has the shape of an ID with the given prefix (a wrong shape is a 404). */
export function isId(value: unknown, prefix?: IdPrefix): value is string {
  if (typeof value !== "string" || !ID_SHAPE.test(value)) return false;
  return prefix === undefined || value.startsWith(`${prefix}_`);
}
