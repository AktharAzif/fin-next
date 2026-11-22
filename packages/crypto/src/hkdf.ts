// HKDF-SHA256 (RFC 5869) through node:crypto. Fin derives every per-organisation and per-use subkey
// this way (ARCHITECTURE §6.6); subkeys live in memory for one call and are never stored.
import { hkdfSync } from "node:crypto";
import { utf8 } from "./bytes.ts";

export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | string,
  info: Uint8Array | string,
  length: number,
): Uint8Array {
  if (!Number.isInteger(length) || length < 1 || length > 255 * 32) {
    throw new RangeError("HKDF-SHA256 output length must be between 1 and 8160 bytes");
  }
  const saltBytes = typeof salt === "string" ? utf8(salt) : salt;
  const infoBytes = typeof info === "string" ? utf8(info) : info;
  if (infoBytes.byteLength > 1024) throw new RangeError("HKDF info longer than 1024 bytes");
  return new Uint8Array(hkdfSync("sha256", ikm, saltBytes, infoBytes, length));
}
