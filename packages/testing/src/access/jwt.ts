// Compact JWS with RS256 over node:crypto, just enough for the Access stand-in to sign tokens and
// for the harness to check the ones it is handed back. Fin's own verifier lives in packages/staff;
// these helpers also build the malformed tokens its tests need.
import { createPublicKey, type KeyObject, sign, verify } from "node:crypto";

export type JsonObject = { readonly [key: string]: unknown };

export function base64url(data: Uint8Array | string): string {
  return Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data).toString(
    "base64url",
  );
}

export function fromBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  return new Uint8Array(Buffer.from(text, "base64url"));
}

function encodeJson(value: JsonObject): string {
  return base64url(JSON.stringify(value));
}

/** Signs `payload` with RS256 under `header` (which should carry `alg: "RS256"` and a `kid`). */
export function signRs256(header: JsonObject, payload: JsonObject, privateKey: KeyObject): string {
  const input = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = sign("sha256", new TextEncoder().encode(input), privateKey);
  return `${input}.${base64url(signature)}`;
}

/** An unsigned token (`alg: "none"`), for tests that a verifier refuses one. */
export function unsignedToken(header: JsonObject, payload: JsonObject): string {
  return `${encodeJson(header)}.${encodeJson(payload)}.`;
}

export interface DecodedToken {
  readonly header: JsonObject;
  readonly payload: JsonObject;
  readonly signingInput: string;
  readonly signature: Uint8Array;
}

function parseJsonObject(part: string): JsonObject {
  const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(part)));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("a token part is not a JSON object");
  }
  return value as JsonObject;
}

/** Splits and decodes a compact token without checking it. Throws on a malformed token. */
export function decodeToken(token: string): DecodedToken {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("a token has three parts");
  const [header, payload, signature] = parts as [string, string, string];
  return {
    header: parseJsonObject(header),
    payload: parseJsonObject(payload),
    signingInput: `${header}.${payload}`,
    signature: fromBase64url(signature),
  };
}

/** True when `token`'s RS256 signature verifies under the public JWK. */
export function verifyRs256(decoded: DecodedToken, publicJwk: JsonObject): boolean {
  if (decoded.header.alg !== "RS256") return false;
  const key = createPublicKey({ key: publicJwk as never, format: "jwk" });
  return verify("sha256", new TextEncoder().encode(decoded.signingInput), key, decoded.signature);
}
