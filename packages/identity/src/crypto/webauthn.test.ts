// Fin's own check of a passkey assertion (§5.3): it says "signed by this credential, over this
// challenge, from this origin and RP ID" for the algorithms the library registers (ES256, EdDSA,
// RS256), and "not verified" for everything else, malformed input included.
import { createHash, createSign, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Cbor, cbor, SoftAuthenticator } from "../../test/webauthn.ts";
import { assertionVerified, coseKeyAlgorithm } from "./webauthn.ts";

const RP_ID = "console.example.com";
const ORIGIN = "https://console.example.com";
const CHALLENGE = "c2lnbiB0aGlzIGNoYWxsZW5nZQ";

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();

function registered() {
  const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
  authenticator.register({ challenge: "cmVnaXN0ZXI", user: { id: "dXNlcg" } });
  const credential = authenticator.credentials[0];
  if (credential === undefined) throw new Error("no credential");
  return { authenticator, publicKey: credential.cosePublicKey.toString("base64") };
}

function check(
  publicKey: string,
  response: unknown,
  overrides: Partial<{ challenge: string }> = {},
) {
  return assertionVerified({
    publicKey,
    response,
    expectedChallenge: overrides.challenge ?? CHALLENGE,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
  });
}

/** An assertion signed by `signer` over authenticator data and client data built here. */
function signedAssertion(
  signer: (data: Buffer) => Buffer,
  options: { type?: string; origin?: string; rpId?: string } = {},
) {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(7);
  const authenticatorData = Buffer.concat([
    sha256(options.rpId ?? RP_ID),
    Buffer.from([0x05]),
    counter,
  ]);
  const clientData = Buffer.from(
    JSON.stringify({
      type: options.type ?? "webauthn.get",
      challenge: CHALLENGE,
      origin: options.origin ?? ORIGIN,
      crossOrigin: false,
    }),
  );
  const signature = signer(Buffer.concat([authenticatorData, sha256(clientData)]));
  return {
    id: "Y3JlZGVudGlhbA",
    rawId: "Y3JlZGVudGlhbA",
    type: "public-key",
    response: {
      clientDataJSON: b64url(clientData),
      authenticatorData: b64url(authenticatorData),
      signature: b64url(signature),
    },
  };
}

function coseOf(entries: [number, Cbor][]): string {
  return cbor(new Map<number, Cbor>(entries)).toString("base64");
}

function jwkOf(key: KeyObject): Record<string, string> {
  return key.export({ format: "jwk" }) as Record<string, string>;
}

describe("assertionVerified", () => {
  it("verifies an ES256 assertion the software authenticator signed", () => {
    const { authenticator, publicKey } = registered();
    const response = authenticator.authenticate(CHALLENGE);
    expect(check(publicKey, response)).toBe(true);
    expect(coseKeyAlgorithm(publicKey)).toBe(-7);
  });

  it("refuses another challenge, another key and a changed signature", () => {
    const { authenticator, publicKey } = registered();
    const response = authenticator.authenticate(CHALLENGE) as {
      response: { signature: string };
    };
    expect(check(publicKey, response, { challenge: "b3RoZXIgY2hhbGxlbmdl" })).toBe(false);
    expect(check(registered().publicKey, response)).toBe(false);
    const signature = Buffer.from(response.response.signature, "base64url");
    signature[signature.length - 1] = ((signature[signature.length - 1] as number) ^ 1) & 0xff;
    const changed = {
      ...response,
      response: { ...response.response, signature: b64url(signature) },
    };
    expect(check(publicKey, changed)).toBe(false);
  });

  it("refuses another origin, another RP ID and a registration's client data", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = jwkOf(publicKey);
    const cose = coseOf([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x as string, "base64url")],
      [-3, Buffer.from(jwk.y as string, "base64url")],
    ]);
    const es256 = (data: Buffer) => createSign("sha256").update(data).sign(privateKey);
    expect(check(cose, signedAssertion(es256))).toBe(true);
    expect(check(cose, signedAssertion(es256, { origin: "https://evil.example.net" }))).toBe(false);
    expect(check(cose, signedAssertion(es256, { rpId: "example.com" }))).toBe(false);
    expect(check(cose, signedAssertion(es256, { type: "webauthn.create" }))).toBe(false);
  });

  it("verifies EdDSA and RS256 keys", () => {
    const ed = generateKeyPairSync("ed25519");
    const edCose = coseOf([
      [1, 1],
      [3, -8],
      [-1, 6],
      [-2, Buffer.from(jwkOf(ed.publicKey).x as string, "base64url")],
    ]);
    expect(
      check(
        edCose,
        signedAssertion((data) => sign(null, data, ed.privateKey)),
      ),
    ).toBe(true);
    expect(coseKeyAlgorithm(edCose)).toBe(-8);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaJwk = jwkOf(rsa.publicKey);
    const rsaCose = coseOf([
      [1, 3],
      [3, -257],
      [-1, Buffer.from(rsaJwk.n as string, "base64url")],
      [-2, Buffer.from(rsaJwk.e as string, "base64url")],
    ]);
    const rs256 = (data: Buffer) => createSign("sha256").update(data).sign(rsa.privateKey);
    expect(check(rsaCose, signedAssertion(rs256))).toBe(true);
    // An RS256 signature does not pass under an ES256 key, nor the other way round.
    expect(check(edCose, signedAssertion(rs256))).toBe(false);
  });

  it.each([
    ["no response", undefined],
    ["a string", "assertion"],
    ["no signature", { response: { clientDataJSON: "e30", authenticatorData: "AA" } }],
    [
      "bad base64url",
      { response: { clientDataJSON: "e30!", authenticatorData: "AA", signature: "AA" } },
    ],
    [
      "client data that is not JSON",
      { response: { clientDataJSON: "bm90", authenticatorData: "AA", signature: "AA" } },
    ],
  ])("is false for %s", (_label, response) => {
    const { publicKey } = registered();
    expect(check(publicKey, response)).toBe(false);
  });

  it.each([
    ["not CBOR", Buffer.from([0xff, 0x00]).toString("base64")],
    [
      "an unsupported algorithm (ES384)",
      coseOf([
        [1, 2],
        [3, -35],
        [-1, 2],
        [-2, Buffer.alloc(48)],
        [-3, Buffer.alloc(48)],
      ]),
    ],
    [
      "a truncated map",
      cbor(new Map<number, Cbor>([[1, 2]]))
        .subarray(0, 1)
        .toString("base64"),
    ],
    [
      "trailing bytes",
      Buffer.concat([cbor(new Map<number, Cbor>([[1, 2]])), Buffer.from([0])]).toString("base64"),
    ],
    [
      "a point of the wrong length",
      coseOf([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.alloc(31)],
        [-3, Buffer.alloc(32)],
      ]),
    ],
  ])("reads no key from %s", (_label, publicKey) => {
    expect(coseKeyAlgorithm(publicKey)).toBeNull();
    const { authenticator } = registered();
    expect(check(publicKey, authenticator.authenticate(CHALLENGE))).toBe(false);
  });
});
