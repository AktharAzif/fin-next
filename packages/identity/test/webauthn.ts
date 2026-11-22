// A software authenticator for the passkey tests: ES256 keys from node:crypto, "none"
// attestation, CBOR written by hand. It answers exactly what a browser's WebAuthn API would hand
// the page, so the library's real verification (SimpleWebAuthn) runs against it.
import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  if (length < 65_536) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(length, 1);
  return out;
}

export type Cbor = number | string | Uint8Array | Cbor[] | Map<number | string, Cbor>;

export function cbor(value: Cbor): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
  }
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map(cbor)]);
  const parts: Buffer[] = [cborHead(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return Buffer.concat(parts);
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();

export interface Credential {
  id: Buffer;
  privateKey: KeyObject;
  /** The credential's public key as a COSE_Key, the bytes the library stores (base64). */
  cosePublicKey: Buffer;
  counter: number;
  userHandle: string;
}

export class SoftAuthenticator {
  readonly rpId: string;
  readonly origin: string;
  readonly credentials: Credential[] = [];

  constructor(rpId: string, origin: string) {
    this.rpId = rpId;
    this.origin = origin;
  }

  #clientData(type: "webauthn.create" | "webauthn.get", challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }),
    );
  }

  /**
   * Answers `generate-register-options` like `navigator.credentials.create`; `id` chooses the
   * credential ID, which an authenticator picks itself (16 random bytes otherwise).
   */
  register(
    options: { challenge: string; user: { id: string } },
    choose: { id?: Buffer } = {},
  ): Record<string, unknown> {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const id = choose.id ?? Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
    const cose = new Map<number, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ]);
    this.credentials.push({
      id,
      privateKey,
      cosePublicKey: cbor(cose),
      counter: 0,
      userHandle: options.user.id,
    });
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([0x45]), // user present, user verified, attested credential data
      Buffer.alloc(4), // counter 0
      Buffer.alloc(16), // aaguid
      idLength,
      id,
      cbor(cose),
    ]);
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: "public-key",
      response: {
        clientDataJSON: b64url(this.#clientData("webauthn.create", options.challenge)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** Answers `generate-authenticate-options` like `navigator.credentials.get`. */
  authenticate(
    challenge: string,
    options: { credential?: Credential; counter?: number } = {},
  ): Record<string, unknown> {
    const credential = options.credential ?? this.credentials[0];
    if (credential === undefined) throw new Error("no credential");
    credential.counter = options.counter ?? credential.counter + 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(credential.counter);
    const authenticatorData = Buffer.concat([sha256(this.rpId), Buffer.from([0x05]), counter]);
    const clientData = this.#clientData("webauthn.get", challenge);
    const signer = createSign("sha256");
    signer.update(Buffer.concat([authenticatorData, sha256(clientData)]));
    const signature = signer.sign(credential.privateKey);
    return {
      id: b64url(credential.id),
      rawId: b64url(credential.id),
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        userHandle: b64url(Buffer.from(credential.userHandle)),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
