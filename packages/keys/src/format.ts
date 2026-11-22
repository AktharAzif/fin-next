// The API key's format (spec 05 §4.1, [SA-18]):
//
//   fin_<mode>_<kind>_<id><secret><checksum>
//     mode     test | live                  ("test" is Sandbox, "live" is Production)
//     kind     sk | rk                      (full access | restricted)
//     id       10 upper-case Crockford characters (the key ID, safe to log and show)
//     secret   32 base62 characters
//     checksum 6 base62 characters: CRC-32 of `salt + ":" + body`, left-padded with "0"
//
// `body` is everything before the checksum. The checksum is over a public per-deployment salt, so
// it filters typos and another deployment's keys before any lookup; it is no defence against an
// attacker (the edge's load shedding is). This module is browser-safe (`@fin/keys/format` is the
// only subpath the docs site imports): it imports only its siblings, never node:*.
import { base62 } from "./base62.ts";
import { crc32Ascii } from "./crc32.ts";
import { isKeyId } from "./crockford.ts";
import { KNOWN_SALTS } from "./salts.ts";

export type KeyMode = "test" | "live";
export type KeyKind = "sk" | "rk";

export interface ParsedKey {
  mode: KeyMode;
  kind: KeyKind;
  id: string;
  secret: string;
  checksum: string;
  body: string;
}

export const KEY_LENGTH = 60;
export const SECRET_LENGTH = 32;
export const CHECKSUM_LENGTH = 6;

export const KEY_REGEX =
  /^fin_(test|live)_(sk|rk)_([0-9A-HJKMNP-TV-Z]{10})([0-9A-Za-z]{32})([0-9A-Za-z]{6})$/;

/** The key's shape only: no checksum is checked. Anything else is null. */
export function parseKey(raw: string): ParsedKey | null {
  if (typeof raw !== "string" || raw.length !== KEY_LENGTH) return null;
  const match = KEY_REGEX.exec(raw);
  if (match === null) return null;
  const [, mode, kind, id, secret, checksum] = match as unknown as [
    string,
    KeyMode,
    KeyKind,
    string,
    string,
    string,
  ];
  return { mode, kind, id, secret, checksum, body: raw.slice(0, KEY_LENGTH - CHECKSUM_LENGTH) };
}

/** The 6-character checksum of a key's body under a salt. */
export function checksumOf(body: string, salt: string): string {
  return base62(crc32Ascii(`${salt}:${body}`), CHECKSUM_LENGTH);
}

/** Whether the key has the right shape and its checksum verifies under this salt. */
export function verifyChecksum(raw: string, salt: string): boolean {
  const parsed = parseKey(raw);
  return parsed !== null && checksumOf(parsed.body, salt) === parsed.checksum;
}

/**
 * The known salt, other than `salt`, under which the key's checksum verifies (the key is another
 * deployment's), or null. The edge logs `keyReason: other_deployment` for such a key.
 */
export function otherDeploymentSalt(raw: string, salt: string): string | null {
  const parsed = parseKey(raw);
  if (parsed === null) return null;
  for (const known of KNOWN_SALTS) {
    if (known !== salt && checksumOf(parsed.body, known) === parsed.checksum) return known;
  }
  return null;
}

/** Builds a key from its parts; each part is checked, so a malformed key is never made. */
export function buildKey(
  mode: KeyMode,
  kind: KeyKind,
  id: string,
  secret: string,
  salt: string,
): string {
  if (mode !== "test" && mode !== "live") throw new TypeError("mode is test or live");
  if (kind !== "sk" && kind !== "rk") throw new TypeError("kind is sk or rk");
  if (!isKeyId(id)) throw new TypeError("the key ID is 10 Crockford characters");
  if (!/^[0-9A-Za-z]{32}$/.test(secret)) throw new TypeError("the secret is 32 base62 characters");
  const body = `fin_${mode}_${kind}_${id}${secret}`;
  return `${body}${checksumOf(body, salt)}`;
}

/** What the console shows as a key's prefix: `fin_<mode>_<kind>_<id>`, never the secret. */
export function keyPrefix(mode: KeyMode, kind: KeyKind, id: string): string {
  return `fin_${mode}_${kind}_${id}`;
}
