// The relying party's half of a passkey ceremony, for the admin API stand-in (test target only):
// read the client data and the authenticator data, take the credential's public key out of a "none"
// attestation, and check an assertion's signature with node:crypto. It checks what the real realm's
// library checks (type, challenge, origin, the RP ID hash, user presence and verification, the
// counter, the ES256 signature) so a journey that passes here does what a browser would.
import { createHash, createPublicKey, verify } from "node:crypto";

type Cbor = number | string | Uint8Array | boolean | null | Cbor[] | Map<Cbor, Cbor>;

/** A CBOR reader for the definite-length items WebAuthn uses. */
export function decodeCbor(bytes: Uint8Array): Cbor {
  let at = 0;
  const byte = () => {
    if (at >= bytes.length) throw new Error("CBOR: truncated");
    return bytes[at++] as number;
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return byte();
    if (info === 25) return (byte() << 8) | byte();
    if (info === 26) return ((byte() << 24) >>> 0) + ((byte() << 16) | (byte() << 8) | byte());
    throw new Error("CBOR: unsupported length");
  };
  const item = (): Cbor => {
    const head = byte();
    const major = head >> 5;
    const info = head & 31;
    switch (major) {
      case 0:
        return length(info);
      case 1:
        return -1 - length(info);
      case 2: {
        const n = length(info);
        const out = bytes.slice(at, at + n);
        at += n;
        return out;
      }
      case 3: {
        const n = length(info);
        const out = new TextDecoder().decode(bytes.slice(at, at + n));
        at += n;
        return out;
      }
      case 4: {
        const n = length(info);
        return Array.from({ length: n }, () => item());
      }
      case 5: {
        const n = length(info);
        const map = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i += 1) map.set(item(), item());
        return map;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error("CBOR: unsupported simple value");
      default:
        throw new Error("CBOR: unsupported major type");
    }
  };
  return item();
}

export function fromBase64Url(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

export interface ClientData {
  readonly type: string;
  readonly challenge: string;
  readonly origin: string;
}

export function readClientData(encoded: string): ClientData | null {
  try {
    const value = JSON.parse(fromBase64Url(encoded).toString("utf8")) as Record<string, unknown>;
    if (
      typeof value.type !== "string" ||
      typeof value.challenge !== "string" ||
      typeof value.origin !== "string"
    ) {
      return null;
    }
    return { type: value.type, challenge: value.challenge, origin: value.origin };
  } catch {
    return null;
  }
}

interface AuthData {
  readonly rpIdHash: Buffer;
  readonly userPresent: boolean;
  readonly userVerified: boolean;
  readonly counter: number;
  readonly credentialId?: Buffer;
  readonly publicKey?: Map<Cbor, Cbor>;
}

function readAuthData(data: Buffer): AuthData {
  if (data.length < 37) throw new Error("authenticator data is too short");
  const flags = data[32] as number;
  const base = {
    rpIdHash: data.subarray(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    counter: data.readUInt32BE(33),
  };
  if ((flags & 0x40) === 0) return base;
  const idLength = data.readUInt16BE(53);
  const credentialId = data.subarray(55, 55 + idLength);
  const key = decodeCbor(data.subarray(55 + idLength));
  if (!(key instanceof Map)) throw new Error("the credential public key is not a map");
  return { ...base, credentialId, publicKey: key };
}

/** A COSE ES256 key (kty 2, alg -7, crv 1) as a JWK. */
function coseToJwk(key: Map<Cbor, Cbor>): JsonWebKey {
  const x = key.get(-2);
  const y = key.get(-3);
  if (key.get(1) !== 2 || key.get(3) !== -7 || key.get(-1) !== 1) {
    throw new Error("only ES256 passkeys are accepted");
  }
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) throw new Error("bad EC point");
  return { kty: "EC", crv: "P-256", x: toBase64Url(x), y: toBase64Url(y) };
}

export interface RegisteredPasskey {
  readonly credentialId: string;
  readonly publicKey: JsonWebKey;
  readonly counter: number;
}

export interface Expected {
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
}

type Json = Record<string, unknown>;

/** The `response` member of a credential's JSON, or null. */
function innerOf(credential: unknown): Json | null {
  if (typeof credential !== "object" || credential === null) return null;
  const inner = (credential as Json).response;
  return typeof inner === "object" && inner !== null ? (inner as Json) : null;
}

/** Checks a registration response; returns the new passkey, or the reason it is refused. */
export function verifyRegistration(
  credential: unknown,
  expected: Expected,
): { ok: true; passkey: RegisteredPasskey } | { ok: false; reason: string } {
  const inner = innerOf(credential);
  if (inner === null) return { ok: false, reason: "malformed" };
  const clientData = readClientData(String(inner.clientDataJSON ?? ""));
  if (clientData === null) return { ok: false, reason: "malformed" };
  if (clientData.type !== "webauthn.create") return { ok: false, reason: "type" };
  if (clientData.challenge !== expected.challenge) return { ok: false, reason: "challenge" };
  if (clientData.origin !== expected.origin) return { ok: false, reason: "origin" };
  try {
    const attestation = decodeCbor(fromBase64Url(String(inner.attestationObject ?? "")));
    if (!(attestation instanceof Map)) return { ok: false, reason: "malformed" };
    if (attestation.get("fmt") !== "none") return { ok: false, reason: "attestation" };
    const raw = attestation.get("authData");
    if (!(raw instanceof Uint8Array)) return { ok: false, reason: "malformed" };
    const auth = readAuthData(Buffer.from(raw));
    if (!auth.rpIdHash.equals(sha256(expected.rpId))) return { ok: false, reason: "rp_id" };
    if (!auth.userPresent || !auth.userVerified) return { ok: false, reason: "user_verification" };
    if (auth.credentialId === undefined || auth.publicKey === undefined) {
      return { ok: false, reason: "malformed" };
    }
    return {
      ok: true,
      passkey: {
        credentialId: toBase64Url(auth.credentialId),
        publicKey: coseToJwk(auth.publicKey),
        counter: auth.counter,
      },
    };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/** The credential ID an assertion names, before it is checked. */
export function assertionCredentialId(credential: unknown): string | null {
  if (typeof credential !== "object" || credential === null) return null;
  const id = (credential as Json).id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** The challenge an assertion answers, before it is checked. */
export function assertionChallenge(credential: unknown): string | null {
  return readClientData(String(innerOf(credential)?.clientDataJSON ?? ""))?.challenge ?? null;
}

/** Checks an assertion against a stored passkey; returns the new counter, or the reason. */
export function verifyAssertion(
  credential: unknown,
  passkey: RegisteredPasskey,
  expected: Expected,
): { ok: true; counter: number } | { ok: false; reason: string } {
  const inner = innerOf(credential);
  if (inner === null) return { ok: false, reason: "malformed" };
  const clientDataText = String(inner.clientDataJSON ?? "");
  const clientData = readClientData(clientDataText);
  if (clientData === null) return { ok: false, reason: "malformed" };
  if (clientData.type !== "webauthn.get") return { ok: false, reason: "type" };
  if (clientData.challenge !== expected.challenge) return { ok: false, reason: "challenge" };
  if (clientData.origin !== expected.origin) return { ok: false, reason: "origin" };
  try {
    const authData = fromBase64Url(String(inner.authenticatorData ?? ""));
    const auth = readAuthData(authData);
    if (!auth.rpIdHash.equals(sha256(expected.rpId))) return { ok: false, reason: "rp_id" };
    if (!auth.userPresent || !auth.userVerified) return { ok: false, reason: "user_verification" };
    if (passkey.counter > 0 && auth.counter <= passkey.counter)
      return { ok: false, reason: "counter" };
    const signed = Buffer.concat([authData, sha256(fromBase64Url(clientDataText))]);
    const key = createPublicKey({ key: passkey.publicKey, format: "jwk" });
    const good = verify("sha256", signed, key, fromBase64Url(String(inner.signature ?? "")));
    return good ? { ok: true, counter: auth.counter } : { ok: false, reason: "signature" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
