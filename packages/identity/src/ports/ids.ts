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

function encodeTime(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0)
    throw new RangeError("newId: the clock's time is invalid");
  let out = "";
  let rest = ms;
  for (let i = 0; i < 10; i += 1) {
    out = ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits as 16 base32 characters, five bits at a time.
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
    }
  }
  return out;
}

export function newId(prefix: IdPrefix, clock: Clock): string {
  const random = new Uint8Array(10);
  crypto.getRandomValues(random);
  return `${prefix}_${encodeTime(clock.now().getTime())}${encodeRandom(random)}`;
}

/** True when `value` has the shape of an ID with the given prefix (a wrong shape is a 404). */
export function isId(value: unknown, prefix?: IdPrefix): value is string {
  if (typeof value !== "string" || !ID_SHAPE.test(value)) return false;
  return prefix === undefined || value.startsWith(`${prefix}_`);
}
