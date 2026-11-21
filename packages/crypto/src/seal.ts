// Sealed fields (ARCHITECTURE §6.6, DECISIONS DA-06). AES-256-GCM with a random 96-bit IV under an
// HKDF-SHA256 subkey per organisation (salt `fin-seal-v1`, info `data:<organization>`, or
// `money:<organization>` for the money family), with the field as additional data
// (`<organization>:<table>.<column>`), so a sealed value cannot be moved to another field or
// another organisation and still open. The stored form is `fdk<n>.<iv>.<ciphertext and tag>`, both
// parts base64url, where `<n>` is the key version.
import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from "node:crypto";
import { concatBytes, fromBase64Url, toBase64Url, utf8 } from "./bytes.ts";
import { hkdfSha256 } from "./hkdf.ts";
import type { Keyring } from "./keyring.ts";

export type SealPurpose = "data" | "money";

export interface SealField {
  /** The organisation the value belongs to, for example `org_...`. */
  organization: string;
  /** The table, optionally schema-qualified: `customer` or `kyc.customer`. */
  table: string;
  column: string;
}

export interface Sealer {
  seal(field: SealField, plaintext: string | Uint8Array): string;
  open(field: SealField, sealed: string): Uint8Array;
  openText(field: SealField, sealed: string): string;
  /** The key version a sealed value was written with (for re-seal batches). */
  versionOf(sealed: string): number;
}

export class SealOpenError extends Error {
  override readonly name = "SealOpenError";
  constructor() {
    // Fixed message: why a value failed to open is never reported (it would help an attacker).
    super("sealed value could not be opened");
  }
}

const SEAL_SALT = "fin-seal-v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 1024 * 1024;
const SEALED = /^fdk([1-9][0-9]{0,5})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/;
const ORGANIZATION = /^[A-Za-z0-9_]{1,64}$/;
const TABLE = /^[a-z][a-z0-9_]{0,62}(?:\.[a-z][a-z0-9_]{0,62})?$/;
const COLUMN = /^[a-z][a-z0-9_]{0,62}$/;

function additionalData(field: SealField): Uint8Array {
  if (!ORGANIZATION.test(field.organization)) throw new TypeError("invalid seal organization");
  if (!TABLE.test(field.table)) throw new TypeError("invalid seal table");
  if (!COLUMN.test(field.column)) throw new TypeError("invalid seal column");
  return utf8(`${field.organization}:${field.table}.${field.column}`);
}

/** The per-organisation subkey; exported for the known-answer tests only. */
export function sealSubkey(
  key: Uint8Array,
  purpose: SealPurpose,
  organization: string,
): Uint8Array {
  if (!ORGANIZATION.test(organization)) throw new TypeError("invalid seal organization");
  return hkdfSha256(key, SEAL_SALT, `${purpose}:${organization}`, 32);
}

export interface SealerOptions {
  /** Defaults to node:crypto's; tests inject a fixed source for known answers. */
  randomBytes?: (size: number) => Uint8Array;
}

export function createSealer(
  keyring: Keyring,
  purpose: SealPurpose,
  options: SealerOptions = {},
): Sealer {
  const random = options.randomBytes ?? ((size: number) => new Uint8Array(nodeRandomBytes(size)));

  function parse(sealed: string): { version: number; iv: Uint8Array; body: Uint8Array } {
    const match = SEALED.exec(sealed);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      throw new SealOpenError();
    }
    try {
      const iv = fromBase64Url(match[2]);
      const body = fromBase64Url(match[3]);
      if (iv.byteLength !== IV_BYTES || body.byteLength < TAG_BYTES) throw new SealOpenError();
      return { version: Number(match[1]), iv, body };
    } catch {
      throw new SealOpenError();
    }
  }

  function seal(field: SealField, plaintext: string | Uint8Array): string {
    const aad = additionalData(field);
    const data = typeof plaintext === "string" ? utf8(plaintext) : plaintext;
    if (data.byteLength > MAX_PLAINTEXT_BYTES) throw new RangeError("value too large to seal");
    const version = keyring.inUse;
    const key = keyring.key(version);
    if (key === undefined) throw new Error("the in-use seal key is missing");
    const iv = random(IV_BYTES);
    if (iv.byteLength !== IV_BYTES) throw new Error("random source returned the wrong length");
    const cipher = createCipheriv("aes-256-gcm", sealSubkey(key, purpose, field.organization), iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aad);
    const body = concatBytes(cipher.update(data), cipher.final(), cipher.getAuthTag());
    return `fdk${version}.${toBase64Url(iv)}.${toBase64Url(body)}`;
  }

  function open(field: SealField, sealed: string): Uint8Array {
    const aad = additionalData(field);
    const { version, iv, body } = parse(sealed);
    const key = keyring.key(version);
    if (key === undefined) throw new SealOpenError();
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        sealSubkey(key, purpose, field.organization),
        iv,
        { authTagLength: TAG_BYTES },
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(body.subarray(body.byteLength - TAG_BYTES));
      return concatBytes(
        decipher.update(body.subarray(0, body.byteLength - TAG_BYTES)),
        decipher.final(),
      );
    } catch {
      throw new SealOpenError();
    }
  }

  function openText(field: SealField, sealed: string): string {
    const bytes = open(field, sealed);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new SealOpenError();
    }
  }

  return { seal, open, openText, versionOf: (sealed) => parse(sealed).version };
}
