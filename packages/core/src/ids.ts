// Fin's IDs (ARCHITECTURE §3.5, §6.2): `<prefix>_<26 Crockford base32 characters>`, time-ordered.
// The 26 characters are a ULID written in lower case: 10 for the 48-bit millisecond time from the
// injected Clock, 16 for 80 bits from crypto.getRandomValues. The database checks the same shape
// (spec 01 §6.10: `^job_[0-9a-hjkmnp-tv-z]{26}$`).
import type { Clock } from "./clock.ts";

/** Crockford's base32 alphabet in lower case: no i, l, o or u. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const MAX_TIME = 2 ** 48 - 1;

/**
 * Every prefix Fin uses, with what it names (ARCHITECTURE §6.2). The test refuses a duplicate, a
 * prefix of the wrong shape, and a prefix used in code but missing here.
 */
export const ID_PREFIXES = {
  usr: "user",
  ses: "session",
  acc: "auth account",
  pky: "passkey",
  tfa: "two-factor record",
  asr: "assurance record",
  org: "organisation",
  mem: "membership",
  inv: "invitation",
  rol: "role",
  stf: "staff member",
  sts: "staff session",
  srl: "staff role",
  cus: "customer",
  per: "person",
  doc: "document",
  lnk: "hosted link",
  rfi: "request for information",
  rit: "request item",
  frm: "form",
  glr: "go-live request",
  kap: "applicant record",
  kie: "KYC inbound event",
  evt: "developer event",
  whe: "webhook endpoint",
  whd: "webhook delivery",
  vac: "virtual account",
  ben: "beneficiary",
  trf: "transfer",
  lac: "ledger account",
  len: "ledger entry",
  hld: "hold",
  pev: "provider event",
  pop: "provider operation",
  rbk: "reconciliation break",
  req: "request",
  job: "job or duty run",
  eml: "email",
  sti: "step-up intent",
  lks: "hosted-link session",
  tbr: "trusted browser",
  enc: "staff enrolment code",
  sft: "selfie ticket",
  run: "pnpm fin run",
} as const;

export type IdPrefix = keyof typeof ID_PREFIXES;

/** The 26-character body, as the database and the path checks see it. */
export const ID_BODY = /^[0-9a-hjkmnp-tv-z]{26}$/;

function isPrefix(value: string): value is IdPrefix {
  return Object.hasOwn(ID_PREFIXES, value);
}

function encode(value: bigint, length: number): string {
  let out = "";
  let rest = value;
  for (let i = 0; i < length; i++) {
    out = ALPHABET.charAt(Number(rest & 31n)) + out;
    rest >>= 5n;
  }
  return out;
}

function timePart(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) {
    throw new RangeError("an ID's time must be a whole number of milliseconds within 48 bits");
  }
  return encode(BigInt(ms), TIME_CHARS);
}

/** The random source: crypto.getRandomValues unless a test passes its own. */
export type RandomFill = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;

const cryptoFill: RandomFill = (bytes) => crypto.getRandomValues(bytes);

/**
 * Makes a new ID, inside a request or job, from the Clock it is given (never at module scope).
 */
export function newId(prefix: IdPrefix, clock: Clock, fill: RandomFill = cryptoFill): string {
  const bytes = fill(new Uint8Array(10));
  let random = 0n;
  for (const byte of bytes) random = (random << 8n) | BigInt(byte);
  return `${prefix}_${timePart(clock.now())}${encode(random, RANDOM_CHARS)}`;
}

/**
 * The smallest ID of `prefix` at time `ms`, so that `id >= idAt(prefix, dayAgo)` is a time window
 * on a primary key (ARCHITECTURE §6.2).
 */
export function idAt(prefix: IdPrefix, ms: number): string {
  return `${prefix}_${timePart(ms)}${"0".repeat(RANDOM_CHARS)}`;
}

/** Whether `value` is an ID, of `prefix` when one is given. A path ID of another shape is a 404. */
export function isId(value: unknown, prefix?: IdPrefix): value is string {
  if (typeof value !== "string" || value.length !== 30 || value.charAt(3) !== "_") return false;
  const head = value.slice(0, 3);
  if (prefix !== undefined ? head !== prefix : !isPrefix(head)) return false;
  return ID_BODY.test(value.slice(4)) && value.charAt(4) <= "7";
}

/** The millisecond time an ID was made at, or undefined if `value` is not an ID. */
export function idTime(value: string): number | undefined {
  if (!isId(value)) return undefined;
  let ms = 0;
  for (const char of value.slice(4, 4 + TIME_CHARS)) ms = ms * 32 + ALPHABET.indexOf(char);
  return ms;
}
