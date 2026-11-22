// Byte helpers shared by the crypto modules. Strict decoders: a value with a character outside the
// alphabet, or padding where none belongs, is refused rather than decoded loosely, so two different
// strings never open to the same bytes.

const BASE64URL = /^[A-Za-z0-9_-]*$/;
const BASE64_NOPAD = /^[A-Za-z0-9+/]*$/;

export class EncodingError extends Error {
  override readonly name = "EncodingError";
}

export function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

export function fromBase64Url(text: string): Uint8Array {
  if (!BASE64URL.test(text) || text.length % 4 === 1) {
    throw new EncodingError("not base64url");
  }
  const bytes = Buffer.from(text, "base64url");
  if (bytes.toString("base64url") !== text) throw new EncodingError("not canonical base64url");
  return new Uint8Array(bytes);
}

/** Standard base64 without padding, as PHC strings write it. */
export function toBase64NoPad(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("base64")
    .replace(/=+$/, "");
}

export function fromBase64NoPad(text: string): Uint8Array {
  if (!BASE64_NOPAD.test(text) || text.length % 4 === 1) {
    throw new EncodingError("not unpadded base64");
  }
  const bytes = Buffer.from(text, "base64");
  if (toBase64NoPad(new Uint8Array(bytes)) !== text) {
    throw new EncodingError("not canonical base64");
  }
  return new Uint8Array(bytes);
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}

export function fromHex(text: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(text)) throw new EncodingError("not lower-case hex");
  return new Uint8Array(Buffer.from(text, "hex"));
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
