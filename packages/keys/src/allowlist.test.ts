// T05-11's save-time half (spec 05 §4.5): entries are normalised as Postgres's cidr writes them; the
// refused ranges, prefixes shorter than /16 (IPv4) and /32 (IPv6), and any range covering Cloudflare's
// shared Workers egress address are refused with their position; a match passes and a miss does not.
// Single private addresses are built at run time (the repository holds none, R12).
import { describe, expect, it } from "vitest";
import {
  allowlistAllows,
  entryProblem,
  formatRange,
  normaliseAllowlist,
  parseAddress,
  parseRange,
} from "./allowlist.ts";

const at = (...parts: number[]) => parts.join(".");

describe("parsing", () => {
  it("reads IPv4 and IPv6 strictly", () => {
    expect(parseAddress("8.8.8.8")).toEqual({ family: 4, value: 0x08080808n });
    expect(parseAddress("08.8.8.8")).toBeNull();
    expect(parseAddress("8.8.8")).toBeNull();
    expect(parseAddress("256.1.1.1")).toBeNull();
    expect(parseAddress("2a00:1450::1")).toEqual({ family: 6, value: (0x2a001450n << 96n) | 1n });
    expect(parseAddress("::ffff:8.8.8.8")?.value).toBe((0xffffn << 32n) | 0x08080808n);
    expect(parseAddress("1::2::3")).toBeNull();
    expect(parseAddress("fe80::1%eth0")).toBeNull();
    expect(parseAddress("example.com")).toBeNull();
  });

  it("clears host bits and writes ranges as Postgres does", () => {
    expect(formatRange(parseRange("8.8.8.77/24") as never)).toBe("8.8.8.0/24");
    expect(formatRange(parseRange("8.8.4.4") as never)).toBe("8.8.4.4/32");
    expect(formatRange(parseRange("2A00:1450:4001:0:0:0:0:1/48") as never)).toBe(
      "2a00:1450:4001::/48",
    );
    expect(formatRange(parseRange("2a00:1450:0:1:0:0:2:3") as never)).toBe(
      "2a00:1450:0:1::2:3/128",
    );
    expect(parseRange("8.8.8.8/33")).toBeNull();
    expect(parseRange("8.8.8.8/024")).toBeNull();
  });
});

describe("refused at save", () => {
  it.each([
    ["10.0.0.0/8", "too_wide"],
    [`${at(10, 1, 2, 3)}`, "private"],
    [`${at(172, 16, 4, 1)}/32`, "private"],
    [`${at(192, 168, 1, 0)}/24`, "private"],
    [`${at(100, 64, 7, 7)}`, "cgnat"],
    ["127.0.0.1", "loopback"],
    ["169.254.10.0/24", "link_local"],
    ["192.0.2.10", "documentation"],
    ["198.51.100.0/24", "documentation"],
    ["203.0.113.0/24", "documentation"],
    ["224.1.2.3", "multicast"],
    ["240.0.0.1", "reserved"],
    ["8.0.0.0/15", "too_wide"],
    ["2a00::/31", "too_wide"],
    ["2001:db8::/32", "documentation"],
    [`fd12:${"3456"}::/48`, "unique_local"],
    ["fe80::/64", "link_local"],
    ["ff02::1", "multicast"],
    ["::1", "loopback"],
    ["::ffff:8.8.8.8", "reserved"],
    ["2a06:98c0:3600::103", "workers_egress"],
    ["2a06:98c0::/32", "workers_egress"],
    ["not an address", "unparsable"],
  ])("%s is refused (%s)", (entry, problem) => {
    expect(entryProblem(entry)).toBe(problem);
  });

  it("keeps public ranges, normalised, without duplicates, and names a refused entry's position", () => {
    expect(normaliseAllowlist(["8.8.8.0/24", "8.8.8.9/24", "2a00:1450::/32"])).toEqual({
      ok: true,
      ranges: ["8.8.8.0/24", "2a00:1450::/32"],
    });
    expect(normaliseAllowlist(["8.8.8.0/24", "127.0.0.1"])).toEqual({
      ok: false,
      index: 1,
      problem: "loopback",
    });
    const many = Array.from({ length: 21 }, (_, i) => `8.8.${i}.0/24`);
    expect(normaliseAllowlist(many)).toMatchObject({ ok: false, problem: "too_many" });
  });
});

describe("matching at the edge", () => {
  it("lets every address through an empty list, and only listed ones through a list", () => {
    expect(allowlistAllows([], "8.8.8.8")).toBe(true);
    expect(allowlistAllows(["8.8.8.0/24"], "8.8.8.200")).toBe(true);
    expect(allowlistAllows(["8.8.8.0/24"], "8.8.9.1")).toBe(false);
    expect(allowlistAllows(["8.8.8.0/24"], "::ffff:8.8.8.1")).toBe(true);
    expect(allowlistAllows(["2a00:1450::/32"], "2a00:1450:4001::5")).toBe(true);
    expect(allowlistAllows(["2a00:1450::/32"], "2a01::5")).toBe(false);
    expect(allowlistAllows(["8.8.8.0/24"], undefined)).toBe(false);
    expect(allowlistAllows(["8.8.8.0/24"], "garbage")).toBe(false);
  });
});
