// The keyed hash a recipient is counted under (spec 08 §4.3; ARCHITECTURE §6.6): HMAC-SHA256 under
// `FIN_LIMIT_KEY_<n>` of the normalised address (NFC, lower case, the domain through WHATWG URL's
// IDNA; dots and plus tags kept as typed). A reference recipient (a customer or person ID) is hashed
// as `<kind>:<id>`. The table and the digest key hold only this hash, never the address.
import { createHmac } from "node:crypto";

/** Normalises an address for hashing; returns undefined when it is not an address. */
export function normaliseAddress(address: string): string | undefined {
  const value = address.normalize("NFC").trim();
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return undefined;
  const local = value.slice(0, at).toLowerCase();
  let domain: string;
  try {
    domain = new URL(`http://${value.slice(at + 1)}`).hostname;
  } catch {
    return undefined;
  }
  if (domain === "" || /[\s@]/u.test(local)) return undefined;
  return `${local}@${domain}`;
}

export interface LimitKey {
  readonly version: number;
  readonly secret: Uint8Array;
}

export type RecipientHasher = (kind: string, recipient: string) => string;

/** Makes the hasher. 32 hex characters (128 bits) are kept: enough to never collide in a window. */
export function recipientHasher(key: LimitKey): RecipientHasher {
  if (key.secret.byteLength < 32) throw new Error("FIN_LIMIT_KEY must be at least 32 bytes");
  return (kind, recipient) => {
    const subject =
      kind === "address"
        ? (normaliseAddress(recipient) ?? recipient.toLowerCase())
        : `${kind}:${recipient}`;
    return createHmac("sha256", key.secret)
      .update(`email-recipient:${subject}`)
      .digest("hex")
      .slice(0, 32);
  };
}
