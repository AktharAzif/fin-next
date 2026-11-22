// Address allowlists (spec 05 §4.5): up to 20 entries, each an IPv4 or IPv6 address or CIDR range,
// kept normalised as Postgres `cidr` text. Refused at save, with the entry's position: private,
// loopback, link-local, CGNAT, unique-local, documentation, multicast and reserved ranges (no caller
// arrives from one through Cloudflare); IPv4 prefixes shorter than /16 and IPv6 shorter than /32;
// and any range covering Cloudflare's shared Workers egress address, which stands for every Worker
// (D05-11). The edge matches `CF-Connecting-IP` (trusted only for tunnel traffic) against the list.
//
// Plain TypeScript with no import: node:net is a platform module only packages/server may use
// (spec 01 §4.6), and the parser is small. Addresses are parsed strictly (no leading zeros in an
// IPv4 part, no zone, at most one "::"), so two spellings of one address normalise alike.

export type Family = 4 | 6;

export interface Address {
  family: Family;
  value: bigint;
}

export interface Range {
  family: Family;
  /** The network address, host bits cleared. */
  base: bigint;
  bits: number;
}

export const MAX_ALLOWLIST_ENTRIES = 20;
const MIN_PREFIX: Readonly<Record<Family, number>> = { 4: 16, 6: 32 };
const WIDTH: Readonly<Record<Family, number>> = { 4: 32, 6: 128 };

function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIpv6(text: string): bigint | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(text)) return null;
  let head = text;
  let tailV4: bigint | null = null;
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    tailV4 = parseIpv4(text.slice(lastColon + 1));
    if (tailV4 === null) return null;
    head = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : (halves[0] as string).split(":");
  const right = halves.length === 2 && halves[1] !== "" ? (halves[1] as string).split(":") : [];
  const groups = left.length + right.length;
  if (halves.length === 1 ? groups !== 8 : groups > 7) return null;
  const all = [...left, ...Array<string>(8 - groups).fill("0"), ...right];
  let value = 0n;
  for (const group of all) {
    if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  if (tailV4 !== null) value = (value & ~0xffffffffn) | tailV4;
  return value;
}

/** Parses one address; anything else (a zone, a port, a host name) is null. */
export function parseAddress(text: string): Address | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 45) return null;
  if (text.includes(":")) {
    const value = parseIpv6(text);
    return value === null ? null : { family: 6, value };
  }
  const value = parseIpv4(text);
  return value === null ? null : { family: 4, value };
}

function mask(family: Family, bits: number): bigint {
  const width = WIDTH[family];
  return bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits);
}

/** Parses `address` or `address/bits`; host bits are cleared, as Postgres's cidr keeps them. */
export function parseRange(text: string): Range | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  const slash = trimmed.indexOf("/");
  const address = parseAddress(slash < 0 ? trimmed : trimmed.slice(0, slash));
  if (address === null) return null;
  const width = WIDTH[address.family];
  let bits = width;
  if (slash >= 0) {
    const suffix = trimmed.slice(slash + 1);
    if (!/^(0|[1-9][0-9]{0,2})$/.test(suffix)) return null;
    bits = Number(suffix);
    if (bits > width) return null;
  }
  return { family: address.family, base: address.value & mask(address.family, bits), bits };
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 255n)).join(".");
}

/** RFC 5952's form: lower case, the longest run of two or more zero groups as "::". */
function formatIpv6(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, i) =>
    Number((value >> BigInt(112 - i * 16)) & 0xffffn),
  );
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLength && j - i >= 2) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(":");
  const left = hex.slice(0, bestStart).join(":");
  const right = hex.slice(bestStart + bestLength).join(":");
  return `${left}::${right}`;
}

/** The range as Postgres's `cidr` writes it back (`203.0.113.0/24`, `2001:db8::/32`). */
export function formatRange(range: Range): string {
  const text = range.family === 4 ? formatIpv4(range.base) : formatIpv6(range.base);
  return `${text}/${range.bits}`;
}

/** Whether two ranges of one family share any address (one holds the other). */
function overlaps(a: Range, b: Range): boolean {
  if (a.family !== b.family) return false;
  const bits = Math.min(a.bits, b.bits);
  const m = mask(a.family, bits);
  return (a.base & m) === (b.base & m);
}

function contains(range: Range, address: Address): boolean {
  if (range.family !== address.family) return false;
  return (address.value & mask(range.family, range.bits)) === range.base;
}

type RefusedRange = Range & { name: string };

function refused(cidr: string, name: string): RefusedRange {
  const range = parseRange(cidr);
  if (range === null) throw new Error(`allowlist: bad built-in range ${cidr}`);
  return { ...range, name };
}

let refusedRanges: readonly RefusedRange[] | null = null;

/** The ranges no caller arrives from through Cloudflare, built on first use. */
function refusedList(): readonly RefusedRange[] {
  refusedRanges ??= [
    refused("0.0.0.0/8", "unspecified"),
    refused("10.0.0.0/8", "private"),
    refused("100.64.0.0/10", "cgnat"),
    refused("127.0.0.0/8", "loopback"),
    refused("169.254.0.0/16", "link_local"),
    refused("172.16.0.0/12", "private"),
    refused("192.0.0.0/24", "reserved"),
    refused("192.0.2.0/24", "documentation"),
    refused("192.88.99.0/24", "reserved"),
    refused("192.168.0.0/16", "private"),
    refused("198.18.0.0/15", "reserved"),
    refused("198.51.100.0/24", "documentation"),
    refused("203.0.113.0/24", "documentation"),
    refused("224.0.0.0/4", "multicast"),
    refused("240.0.0.0/4", "reserved"),
    // IPv6: everything outside global unicast (2000::/3) is refused below; within it, these.
    refused("2001::/23", "reserved"),
    refused("2001:db8::/32", "documentation"),
    refused("2002::/16", "reserved"),
    refused("3fff::/20", "documentation"),
    // Cloudflare's shared Workers egress address (D05-11).
    refused("2a06:98c0:3600::103/128", "workers_egress"),
  ];
  return refusedRanges;
}

const GLOBAL_UNICAST = { family: 6 as const, base: 0x2n << 124n, bits: 3 };

export type AllowlistProblem =
  | "unparsable"
  | "too_wide"
  | "private"
  | "loopback"
  | "link_local"
  | "cgnat"
  | "unique_local"
  | "documentation"
  | "multicast"
  | "reserved"
  | "unspecified"
  | "workers_egress";

/** Why an entry is refused at save, or null when it may be stored. */
export function entryProblem(text: string): AllowlistProblem | null {
  const range = parseRange(text);
  if (range === null) return "unparsable";
  if (range.bits < MIN_PREFIX[range.family]) return "too_wide";
  if (range.family === 6) {
    const base = range.base;
    if (base >> 121n === 0x7en) return "unique_local"; // fc00::/7
    if (base >> 118n === 0x3fan) return "link_local"; // fe80::/10
    if (base >> 120n === 0xffn) return "multicast"; // ff00::/8
    if (base === 0n && range.bits === 128) return "unspecified";
    if (base === 1n && range.bits === 128) return "loopback";
    if (!overlaps(range, GLOBAL_UNICAST) || range.bits < GLOBAL_UNICAST.bits) return "reserved";
  }
  for (const r of refusedList()) {
    if (overlaps(range, r)) return r.name as AllowlistProblem;
  }
  return null;
}

export interface AllowlistRefusal {
  /** The entry's position in what was sent, from 0. */
  index: number;
  problem: AllowlistProblem | "too_many";
}

/**
 * Normalises an allowlist for storage: each entry checked and written as `cidr` text, duplicates
 * dropped, order kept. Returns the first refusal with its position instead.
 */
export function normaliseAllowlist(
  entries: readonly string[],
): { ok: true; ranges: string[] } | ({ ok: false } & AllowlistRefusal) {
  if (entries.length > MAX_ALLOWLIST_ENTRIES) {
    return { ok: false, index: MAX_ALLOWLIST_ENTRIES, problem: "too_many" };
  }
  const out: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const problem = entryProblem(entry);
    if (problem !== null) return { ok: false, index, problem };
    const text = formatRange(parseRange(entry) as Range);
    if (!out.includes(text)) out.push(text);
  }
  return { ok: true, ranges: out };
}

/**
 * Whether the caller's address is in the allowlist. An empty list allows every address; an address
 * that does not parse is in no list. An IPv4-mapped IPv6 address is read as its IPv4 address.
 */
export function allowlistAllows(
  allowlist: readonly string[],
  clientIp: string | undefined,
): boolean {
  if (allowlist.length === 0) return true;
  if (clientIp === undefined) return false;
  let address = parseAddress(clientIp);
  if (address === null) return false;
  if (address.family === 6 && address.value >> 32n === 0xffffn) {
    address = { family: 4, value: address.value & 0xffffffffn };
  }
  for (const entry of allowlist) {
    const range = parseRange(entry);
    if (range !== null && contains(range, address)) return true;
  }
  return false;
}
