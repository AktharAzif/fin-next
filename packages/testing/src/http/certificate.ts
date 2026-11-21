// A throwaway TLS identity for the harness's loopback hosts: a self-signed P-256 certificate made
// at start with node:crypto, so every app host answers over https as the zone does and the three
// engines keep Fin's `__Host-` cookies (WebKit drops a `Secure` cookie on plain http). The private
// key lives only in the process that made it; browsers accept the certificate through Playwright's
// `ignoreHTTPSErrors`, and a Node client trusts it by passing it as `ca`.
//
// node:crypto signs but has no X.509 builder, so the certificate is written here in DER: just the
// fields a TLS server certificate needs (RFC 5280 §4.1), with the subject alternative names the
// browsers check.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { TlsIdentity } from "@fin/server/testing/node-http";

/** A certificate and its private key, both PEM: the shape the harness's https listener takes. */
export type { TlsIdentity };

export interface SelfSignedOptions {
  /** Milliseconds since the epoch the validity is counted from (default: the system clock). */
  readonly now?: number;
  /** Days the certificate stays valid after `now` (default 30). */
  readonly days?: number;
}

const DAY_MS = 86_400_000;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function tlv(tag: number, ...contents: readonly Uint8Array[]): Uint8Array {
  const body = concat(contents);
  return concat([Uint8Array.of(tag), derLength(body.length), body]);
}

const sequence = (...items: readonly Uint8Array[]) => tlv(0x30, ...items);
const setOf = (...items: readonly Uint8Array[]) => tlv(0x31, ...items);
const octets = (bytes: Uint8Array) => tlv(0x04, bytes);
const explicit = (tag: number, ...items: readonly Uint8Array[]) => tlv(0xa0 | tag, ...items);
const TRUE = tlv(0x01, Uint8Array.of(0xff));

function bitString(bytes: Uint8Array, unusedBits = 0): Uint8Array {
  return tlv(0x03, Uint8Array.of(unusedBits), bytes);
}

function oid(dotted: string): Uint8Array {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const out = [40 * first + second];
  for (const arc of rest) {
    const groups: number[] = [];
    for (let value = arc; ; value = Math.floor(value / 128)) {
      groups.unshift(value % 128);
      if (value < 128) break;
    }
    out.push(...groups.map((group, index) => (index < groups.length - 1 ? group | 0x80 : group)));
  }
  return tlv(0x06, Uint8Array.from(out));
}

function derTime(ms: number): Uint8Array {
  const iso = new Date(ms).toISOString();
  const digits = iso.slice(0, 19).replace(/[-:T]/g, "");
  const year = Number(iso.slice(0, 4));
  // RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050.
  return year < 2050
    ? tlv(0x17, new TextEncoder().encode(`${digits.slice(2)}Z`))
    : tlv(0x18, new TextEncoder().encode(`${digits}Z`));
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const DNS_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** One subject alternative name: an IPv4 literal, ::1, or a DNS name. */
function generalName(name: string): Uint8Array {
  const v4 = IPV4.exec(name);
  if (v4 !== null) {
    const bytes = v4.slice(1).map(Number);
    if (bytes.some((byte) => byte > 255)) throw new Error(`not an IPv4 address: ${name}`);
    return tlv(0x87, Uint8Array.from(bytes));
  }
  if (name === "::1")
    return tlv(
      0x87,
      Uint8Array.from({ length: 16 }, (_, i) => (i === 15 ? 1 : 0)),
    );
  if (!DNS_NAME.test(name)) throw new Error(`not a host name a certificate can carry: ${name}`);
  return tlv(0x82, new TextEncoder().encode(name.toLowerCase()));
}

function pem(label: string, der: Uint8Array): string {
  const lines =
    Buffer.from(der)
      .toString("base64")
      .match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * A self-signed server certificate for `names` (host names, IPv4 literals or ::1), valid from a
 * day before `now` for `days` days, with a fresh P-256 key. A test identity, never a real one.
 */
export function selfSignedIdentity(
  names: readonly string[],
  options: SelfSignedOptions = {},
): TlsIdentity {
  if (names.length === 0) throw new Error("a certificate names at least one host");
  const sans = [...new Set(names)].map(generalName);
  const now = options.now ?? Date.now();
  const days = options.days ?? 30;
  if (!Number.isInteger(days) || days < 1) throw new Error("days is a whole number above 0");

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ecdsaWithSha256 = sequence(oid("1.2.840.10045.4.3.2"));
  const name = sequence(
    setOf(sequence(oid("2.5.4.3"), tlv(0x0c, new TextEncoder().encode("fin-next test host")))),
  );
  // A positive serial of 16 bytes whose first byte is never 0, so it is minimal DER.
  const serial = randomBytes(16);
  serial[0] = ((serial[0] as number) & 0x7f) | 0x01;
  const extensions = sequence(
    // Basic constraints, critical: not a CA.
    sequence(oid("2.5.29.19"), TRUE, octets(sequence())),
    // Key usage, critical: digitalSignature only (bit 0, so 7 unused bits).
    sequence(oid("2.5.29.15"), TRUE, octets(bitString(Uint8Array.of(0x80), 7))),
    // Extended key usage: TLS server authentication.
    sequence(oid("2.5.29.37"), octets(sequence(oid("1.3.6.1.5.5.7.3.1")))),
    // Subject alternative names.
    sequence(oid("2.5.29.17"), octets(sequence(...sans))),
  );
  const tbs = sequence(
    explicit(0, tlv(0x02, Uint8Array.of(2))),
    tlv(0x02, serial),
    ecdsaWithSha256,
    name,
    sequence(derTime(now - DAY_MS), derTime(now + days * DAY_MS)),
    name,
    new Uint8Array(publicKey.export({ type: "spki", format: "der" })),
    explicit(3, extensions),
  );
  const signature = new Uint8Array(sign("sha256", tbs, privateKey));
  return {
    cert: pem("CERTIFICATE", sequence(tbs, ecdsaWithSha256, bitString(signature))),
    key: String(privateKey.export({ type: "pkcs8", format: "pem" })),
  };
}
