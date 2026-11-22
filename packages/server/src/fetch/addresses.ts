// The addresses `deliveryFetch` refuses (ARCHITECTURE §7.11): private, loopback, link-local, CGNAT,
// unique-local IPv6 (Railway's fd12::/16 among them), documentation, benchmarking, multicast,
// reserved and unspecified ranges, and IPv6 forms that embed a refused IPv4 address (mapped,
// NAT64, 6to4, Teredo). An address that does not parse is refused too.
import { isIPv4, isIPv6 } from "node:net";

interface Range4 {
  base: number;
  bits: number;
  name: string;
}

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
}

function range4(cidr: string, name: string): Range4 {
  const [base = "", bits = "32"] = cidr.split("/");
  return { base: ipv4ToNumber(base), bits: Number(bits), name };
}

/** IPv4 ranges a delivery never connects to. */
export const REFUSED_IPV4: readonly Range4[] = [
  range4("0.0.0.0/8", "unspecified"),
  range4("10.0.0.0/8", "private"),
  range4("100.64.0.0/10", "cgnat"),
  range4("127.0.0.0/8", "loopback"),
  range4("169.254.0.0/16", "link_local"),
  range4("172.16.0.0/12", "private"),
  range4("192.0.0.0/24", "protocol_assignments"),
  range4("192.0.2.0/24", "documentation"),
  range4("192.88.99.0/24", "relay_6to4"),
  range4("192.168.0.0/16", "private"),
  range4("198.18.0.0/15", "benchmarking"),
  range4("198.51.100.0/24", "documentation"),
  range4("203.0.113.0/24", "documentation"),
  range4("224.0.0.0/4", "multicast"),
  range4("240.0.0.0/4", "reserved"),
];

function inRange4(value: number, range: Range4): boolean {
  if (range.bits === 0) return true;
  const size = 2 ** (32 - range.bits);
  return Math.floor(value / size) === Math.floor(range.base / size);
}

/** The reason an IPv4 address is refused, or undefined when it is public. */
export function refusedIpv4(address: string): string | undefined {
  if (!isIPv4(address)) return "unparsable";
  const value = ipv4ToNumber(address);
  for (const range of REFUSED_IPV4) if (inRange4(value, range)) return range.name;
  return undefined;
}

/** Expands an IPv6 address into its eight 16-bit groups. */
export function ipv6Groups(address: string): number[] | undefined {
  const plain = address.split("%")[0] ?? "";
  if (!isIPv6(plain)) return undefined;
  let text = plain.toLowerCase();
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail?.[1] !== undefined) {
    const v4 = ipv4ToNumber(tail[1]);
    text = `${text.slice(0, -tail[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = 8 - left.length - right.length;
  if (rest === undefined && missing !== 0) return undefined;
  const groups = [...left, ...Array.from({ length: Math.max(0, missing) }, () => "0"), ...right];
  return groups.length === 8 ? groups.map((g) => Number.parseInt(g, 16)) : undefined;
}

function embeddedV4(high: number, low: number): string {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** The reason an IPv6 address is refused, or undefined when it is public. */
export function refusedIpv6(address: string): string | undefined {
  const g = ipv6Groups(address);
  if (g === undefined) return "unparsable";
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, h7 = 0, h8 = 0] = g;
  if (g.every((x) => x === 0)) return "unspecified";
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && h7 === 0 && h8 === 1) {
    return "loopback";
  }
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) {
    return refusedIpv4(embeddedV4(h7, h8)) ?? "ipv4_mapped";
  }
  if (a === 0x64 && b === 0xff9b) return refusedIpv4(embeddedV4(h7, h8)) ?? "nat64";
  if (a === 0x2002) return refusedIpv4(embeddedV4(b, c)) ?? "relay_6to4";
  if (a === 0x2001 && b === 0) return "teredo";
  if (a === 0x2001 && b === 0x0db8) return "documentation";
  if (a === 0x3fff && b <= 0x0fff) return "documentation";
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return "discard";
  if ((a & 0xfe00) === 0xfc00) return "unique_local";
  if ((a & 0xffc0) === 0xfe80) return "link_local";
  if ((a & 0xffc0) === 0xfec0) return "site_local";
  if ((a & 0xff00) === 0xff00) return "multicast";
  if (a === 0x2001 && b < 0x0200) return "special_purpose";
  return undefined;
}

export function refusedAddress(address: string): string | undefined {
  if (isIPv4(address)) return refusedIpv4(address);
  if (isIPv6(address.split("%")[0] ?? "")) return refusedIpv6(address);
  return "unparsable";
}
