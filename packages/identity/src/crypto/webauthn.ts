// Fin's own check of a WebAuthn assertion (spec 02 §5.3), for the one decision Fin makes after
// the library has refused one: whether a passkey whose signature counter did not move forward
// really signed this browser's challenge, and so whether the person is told. The library
// (SimpleWebAuthn) refuses a backwards counter before it checks the signature, so its refusal
// alone says nothing about who sent the assertion. This never decides a sign-in: the library does.
//
// Checked: the client data's type, challenge and origin, the RP ID hash, and the signature over
// `authenticatorData || SHA-256(clientDataJSON)` under the stored COSE key. Supported keys are the
// ones the library registers by default: EdDSA (-8, Ed25519), ES256 (-7, P-256) and RS256 (-257).
// Anything else, and anything malformed, is "not verified". node:crypto only.
import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";

const BASE64URL = /^[A-Za-z0-9_-]*$/;
const MAX_DEPTH = 4;

type Cbor = number | string | Uint8Array | boolean | null | Cbor[] | Map<Cbor, Cbor>;

/** Reads one CBOR item (RFC 8949): definite lengths only, as a COSE_Key needs; throws otherwise. */
function readCbor(bytes: Uint8Array, start: number, depth: number): { value: Cbor; next: number } {
  if (depth > MAX_DEPTH) throw new Error("cbor: too deep");
  const head = bytes[start];
  if (head === undefined) throw new Error("cbor: truncated");
  const major = head >> 5;
  const info = head & 0x1f;
  let offset = start + 1;
  if (major === 7) {
    if (info === 20) return { value: false, next: offset };
    if (info === 21) return { value: true, next: offset };
    if (info === 22) return { value: null, next: offset };
    throw new Error("cbor: unsupported simple value");
  }
  let length: number;
  if (info < 24) {
    length = info;
  } else if (info <= 26) {
    const size = 1 << (info - 24);
    if (offset + size > bytes.length) throw new Error("cbor: truncated");
    length = 0;
    for (let i = 0; i < size; i += 1) length = length * 256 + (bytes[offset + i] as number);
    offset += size;
  } else {
    throw new Error("cbor: unsupported length");
  }
  switch (major) {
    case 0:
      return { value: length, next: offset };
    case 1:
      return { value: -1 - length, next: offset };
    case 2:
    case 3: {
      if (offset + length > bytes.length) throw new Error("cbor: truncated");
      const data = bytes.subarray(offset, offset + length);
      return {
        value: major === 2 ? data : new TextDecoder("utf-8", { fatal: true }).decode(data),
        next: offset + length,
      };
    }
    case 4:
    case 5: {
      // Every item takes at least one byte, so a length past the input is refused at once.
      if (length > bytes.length - offset) throw new Error("cbor: truncated");
      if (major === 4) {
        const items: Cbor[] = [];
        for (let i = 0; i < length; i += 1) {
          const item = readCbor(bytes, offset, depth + 1);
          items.push(item.value);
          offset = item.next;
        }
        return { value: items, next: offset };
      }
      const map = new Map<Cbor, Cbor>();
      for (let i = 0; i < length; i += 1) {
        const key = readCbor(bytes, offset, depth + 1);
        const value = readCbor(bytes, key.next, depth + 1);
        map.set(key.value, value.value);
        offset = value.next;
      }
      return { value: map, next: offset };
    }
    default:
      throw new Error("cbor: unsupported major type");
  }
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

function bytesOf(value: Cbor | undefined, length?: number): Uint8Array | null {
  if (!(value instanceof Uint8Array)) return null;
  return length === undefined || value.length === length ? value : null;
}

/** A stored COSE_Key (base64) as a key Fin can verify with, or null when it cannot. */
function coseKey(publicKey: string): { alg: -7 | -8 | -257; key: KeyObject } | null {
  try {
    const bytes = Buffer.from(publicKey, "base64");
    const { value, next } = readCbor(bytes, 0, 0);
    if (next !== bytes.length || !(value instanceof Map)) return null;
    const kty = value.get(1);
    const alg = value.get(3);
    if (kty === 2 && alg === -7 && value.get(-1) === 1) {
      const x = bytesOf(value.get(-2), 32);
      const y = bytesOf(value.get(-3), 32);
      if (x === null || y === null) return null;
      const jwk = { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y) };
      return { alg, key: createPublicKey({ key: jwk, format: "jwk" }) };
    }
    if (kty === 1 && alg === -8 && value.get(-1) === 6) {
      const x = bytesOf(value.get(-2), 32);
      if (x === null) return null;
      const jwk = { kty: "OKP", crv: "Ed25519", x: b64url(x) };
      return { alg, key: createPublicKey({ key: jwk, format: "jwk" }) };
    }
    if (kty === 3 && alg === -257) {
      const n = bytesOf(value.get(-1));
      const e = bytesOf(value.get(-2));
      if (n === null || e === null) return null;
      const jwk = { kty: "RSA", n: b64url(n), e: b64url(e) };
      return { alg, key: createPublicKey({ key: jwk, format: "jwk" }) };
    }
    return null;
  } catch {
    return null;
  }
}

/** The COSE algorithm of a stored key Fin can verify with (-7, -8 or -257), or null. */
export function coseKeyAlgorithm(publicKey: string): number | null {
  return coseKey(publicKey)?.alg ?? null;
}

export interface AssertionCheck {
  /** The credential's stored public key: its COSE_Key bytes in base64, as the library keeps it. */
  publicKey: string;
  /** The assertion the browser sent (`navigator.credentials.get`'s answer, JSON-encoded). */
  response: unknown;
  expectedChallenge: string;
  expectedOrigin: string;
  rpId: string;
}

function field(value: unknown, name: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const found = (value as Record<string, unknown>)[name];
  return typeof found === "string" && BASE64URL.test(found) ? found : null;
}

/** Whether the credential's key signed this assertion over this challenge, origin and RP ID. */
export function assertionVerified(check: AssertionCheck): boolean {
  try {
    const inner = (check.response as { response?: unknown } | null | undefined)?.response;
    const clientDataText = field(inner, "clientDataJSON");
    const authDataText = field(inner, "authenticatorData");
    const signatureText = field(inner, "signature");
    if (clientDataText === null || authDataText === null || signatureText === null) return false;
    const clientDataBytes = Buffer.from(clientDataText, "base64url");
    const clientData = JSON.parse(clientDataBytes.toString("utf8")) as Record<string, unknown>;
    if (
      clientData.type !== "webauthn.get" ||
      clientData.challenge !== check.expectedChallenge ||
      clientData.origin !== check.expectedOrigin
    ) {
      return false;
    }
    const authData = Buffer.from(authDataText, "base64url");
    if (authData.length < 37) return false;
    const rpIdHash = createHash("sha256").update(check.rpId).digest();
    if (!authData.subarray(0, 32).equals(rpIdHash)) return false;
    const key = coseKey(check.publicKey);
    if (key === null) return false;
    const signed = Buffer.concat([authData, createHash("sha256").update(clientDataBytes).digest()]);
    const signature = Buffer.from(signatureText, "base64url");
    if (key.alg === -7) {
      return verify("sha256", signed, { key: key.key, dsaEncoding: "der" }, signature);
    }
    if (key.alg === -257) return verify("sha256", signed, key.key, signature);
    return verify(null, signed, key.key, signature);
  } catch {
    return false;
  }
}
