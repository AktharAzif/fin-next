// Making a key (spec 05 §4.2): the ID is 10 Crockford characters (50 bits) and the secret 32 base62
// characters (about 190 bits), both from crypto.getRandomValues, the secret by rejection sampling so
// no character is likelier than another. An ID that already exists is drawn again by the caller (a
// unique violation), and an ID of ten digits is redrawn here: such a run reads as a long number to
// the audit trail's shape check, which would refuse the key's events.
import { base62Random } from "./base62.ts";
import { crockfordFromBytes, KEY_ID_LENGTH } from "./crockford.ts";
import { buildKey, type KeyKind, type KeyMode, keyPrefix, SECRET_LENGTH } from "./format.ts";

/** Fills n fresh random bytes; tests pass their own. */
export type RandomBytes = (n: number) => Uint8Array;

export const systemRandom: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export function newKeyId(random: RandomBytes = systemRandom): string {
  for (;;) {
    const id = crockfordFromBytes(random(7), KEY_ID_LENGTH);
    if (!/^[0-9]+$/.test(id)) return id;
  }
}

export interface NewKey {
  id: string;
  /** The whole key: shown once, never stored or logged. */
  key: string;
  /** What is hashed: everything before the checksum. */
  body: string;
  prefix: string;
}

export function newKey(
  mode: KeyMode,
  kind: KeyKind,
  salt: string,
  random: RandomBytes = systemRandom,
  id: string = newKeyId(random),
): NewKey {
  const secret = base62Random(SECRET_LENGTH, random);
  const key = buildKey(mode, kind, id, secret, salt);
  return { id, key, body: key.slice(0, -6), prefix: keyPrefix(mode, kind, id) };
}
