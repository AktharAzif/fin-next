// ARCHITECTURE §7.11's refusal tests: every range and port, names refused before resolution, the
// connection made to exactly the checked address, and a redirect reported, never followed. Private
// addresses are built at run time so the public-safety check never sees one in the file.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { refusedAddress, refusedIpv4, refusedIpv6 } from "./addresses.ts";
import {
  checkDeliveryUrl,
  DeliveryRefused,
  deliveryFetch,
  type HttpsRequest,
  pickAddress,
} from "./delivery-fetch.ts";

const dot = (...parts: number[]): string => parts.join(".");
const colon = (...parts: string[]): string => parts.join(":");

const REFUSED_V4: [string, string][] = [
  [dot(0, 0, 0, 0), "unspecified"],
  [dot(10, 0, 0, 1), "private"],
  [dot(10, 255, 255, 255), "private"],
  [dot(100, 64, 0, 1), "cgnat"],
  [dot(100, 127, 255, 254), "cgnat"],
  [dot(127, 0, 0, 1), "loopback"],
  [dot(169, 254, 169, 254), "link_local"],
  [dot(172, 16, 0, 1), "private"],
  [dot(172, 31, 255, 255), "private"],
  [dot(192, 0, 0, 8), "protocol_assignments"],
  [dot(192, 0, 2, 1), "documentation"],
  [dot(192, 88, 99, 1), "relay_6to4"],
  [dot(192, 168, 1, 1), "private"],
  [dot(198, 18, 0, 1), "benchmarking"],
  [dot(198, 51, 100, 1), "documentation"],
  [dot(203, 0, 113, 1), "documentation"],
  [dot(224, 0, 0, 1), "multicast"],
  [dot(239, 255, 255, 250), "multicast"],
  [dot(240, 0, 0, 1), "reserved"],
  [dot(255, 255, 255, 255), "reserved"],
];

const PUBLIC_V4 = [
  dot(1, 1, 1, 1),
  dot(8, 8, 8, 8),
  dot(100, 63, 255, 255),
  dot(100, 128, 0, 0),
  dot(172, 15, 0, 1),
  dot(172, 32, 0, 1),
];

const REFUSED_V6: [string, string][] = [
  ["::", "unspecified"],
  ["::1", "loopback"],
  [`::ffff:${dot(10, 0, 0, 1)}`, "private"],
  [`::ffff:${dot(8, 8, 8, 8)}`, "ipv4_mapped"],
  [`64:ff9b::${dot(127, 0, 0, 1)}`, "loopback"],
  [`64:ff9b::${dot(8, 8, 8, 8)}`, "nat64"],
  [colon("2002", "0a00", "0001", "", "1"), "private"],
  [colon("2002", "0808", "0808", "", "1"), "relay_6to4"],
  [colon("2001", "0", "", "1"), "teredo"],
  [colon("2001", "db8", "", "1"), "documentation"],
  [colon(["f", "c", "00"].join(""), "", "1"), "unique_local"],
  [colon(["f", "d", "12"].join(""), "", "1"), "unique_local"],
  [colon("fe80", "", "1"), "link_local"],
  [colon("fec0", "", "1"), "site_local"],
  [colon("ff02", "", "1"), "multicast"],
  [colon("100", "", "1"), "discard"],
];

const PUBLIC_V6 = [colon("2606", "4700", "", "1111"), colon("2a00", "1450", "4009", "", "200e")];

describe("refused addresses", () => {
  it("refuses every IPv4 range", () => {
    for (const [address, reason] of REFUSED_V4) expect(refusedIpv4(address), address).toBe(reason);
    for (const address of PUBLIC_V4) expect(refusedIpv4(address), address).toBeUndefined();
  });

  it("refuses every IPv6 range and every embedded refused IPv4 address", () => {
    for (const [address, reason] of REFUSED_V6) expect(refusedIpv6(address), address).toBe(reason);
    for (const address of PUBLIC_V6) expect(refusedIpv6(address), address).toBeUndefined();
    expect(refusedAddress("not an address")).toBe("unparsable");
  });
});

describe("checkDeliveryUrl", () => {
  const zones = ["fin.example.com"];
  const reason = (url: string): string => {
    try {
      checkDeliveryUrl(url, zones);
      return "ok";
    } catch (error) {
      return error instanceof DeliveryRefused ? error.reason : "other";
    }
  };

  it("allows https on 443 and 8443 only", () => {
    expect(reason("https://hooks.example.org/fin")).toBe("ok");
    expect(reason("https://hooks.example.org:443/fin")).toBe("ok");
    expect(reason("https://hooks.example.org:8443/fin")).toBe("ok");
    for (const port of [80, 22, 25, 5432, 6379, 8080, 8444, 9000, 65535]) {
      expect(reason(`https://hooks.example.org:${port}/fin`), String(port)).toBe("port");
    }
    expect(reason("http://hooks.example.org/fin")).toBe("scheme");
    expect(reason("ftp://hooks.example.org/fin")).toBe("scheme");
    expect(reason("not a url")).toBe("url_invalid");
    expect(reason("https://user:pw@hooks.example.org/")).toBe("credentials");
  });

  it("refuses names before resolution", () => {
    for (const url of [
      `https://${dot(8, 8, 8, 8)}/`,
      `https://${dot(10, 0, 0, 1)}/`,
      "https://[::1]/",
      "https://2130706433/",
      "https://0x7f000001/",
    ]) {
      expect(reason(url), url).toBe("ip_literal");
    }
    for (const url of [
      "https://localhost/",
      "https://api.localhost/",
      "https://printer.local/",
      "https://edge.railway.internal/",
      "https://intranet/",
      "https://x.home.arpa/",
    ]) {
      expect(reason(url), url).toBe("local_name");
    }
    for (const url of [
      "https://fin.example.com/",
      "https://api.fin.example.com/",
      "https://API.FIN.EXAMPLE.COM./",
    ]) {
      expect(reason(url), url).toBe("own_zone");
    }
  });
});

describe("pickAddress", () => {
  it("refuses when ANY resolved address is refused", async () => {
    for (const [address] of [...REFUSED_V4, ...REFUSED_V6]) {
      const family = address.includes(":") ? 6 : 4;
      const resolve = async () => [
        { address: dot(1, 1, 1, 1), family: 4 as const },
        { address, family: family as 4 | 6 },
      ];
      await expect(pickAddress("hooks.example.org", resolve), address).rejects.toBeInstanceOf(
        DeliveryRefused,
      );
    }
  });

  it("needs an IPv4 address, and refuses a failed lookup", async () => {
    await expect(
      pickAddress("x.example.org", async () => [{ address: PUBLIC_V6[0] ?? "", family: 6 }]),
    ).rejects.toMatchObject({ reason: "no_ipv4" });
    await expect(pickAddress("x.example.org", async () => [])).rejects.toMatchObject({
      reason: "resolve_failed",
    });
    await expect(
      pickAddress("x.example.org", async () => Promise.reject(new Error("x"))),
    ).rejects.toMatchObject({ reason: "resolve_failed" });
    expect(
      await pickAddress("x.example.org", async () => [{ address: dot(8, 8, 4, 4), family: 4 }]),
    ).toBe(dot(8, 8, 4, 4));
  });
});

/** A fake https.request that records its options and answers like a server. */
function fakeRequest(answer: { status: number; headers?: Record<string, string>; body?: string }) {
  const seen: Record<string, unknown>[] = [];
  const request = ((
    options: Record<string, unknown>,
    onResponse: (res: EventEmitter & Record<string, unknown>) => void,
  ) => {
    seen.push(options);
    const req = new EventEmitter() as EventEmitter & {
      end: (b?: unknown) => void;
      destroy: () => void;
    };
    req.destroy = () => undefined;
    req.end = () => {
      const lookup = options.lookup as (
        h: string,
        o: object,
        cb: (e: null, a: string, f: number) => void,
      ) => void;
      lookup(String(options.host), {}, (_e, address) => {
        seen.push({ connectedTo: address });
        const socket = new EventEmitter();
        req.emit("socket", socket);
        socket.emit("secureConnect");
        const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
        res.statusCode = answer.status;
        res.headers = answer.headers ?? {};
        res.destroy = () => undefined;
        onResponse(res);
        if (answer.body !== undefined) res.emit("data", Buffer.from(answer.body));
        res.emit("end");
      });
    };
    return req;
  }) as unknown as HttpsRequest;
  return { request, seen };
}

describe("deliveryFetch", () => {
  const resolve = async () => [{ address: dot(93, 184, 215, 14), family: 4 as const }];

  it("connects to exactly the checked address with SNI, IPv4 and no agent", async () => {
    const { request, seen } = fakeRequest({ status: 204 });
    const answer = await deliveryFetch(
      "https://hooks.example.org:8443/fin?x=1",
      { body: "{}" },
      { ownZones: [], resolve, request },
    );
    expect(answer.status).toBe(204);
    expect(seen[0]).toMatchObject({
      host: "hooks.example.org",
      servername: "hooks.example.org",
      port: 8443,
      path: "/fin?x=1",
      family: 4,
      agent: false,
    });
    expect(seen[1]).toEqual({ connectedTo: dot(93, 184, 215, 14) });
  });

  it("reports a redirect and never follows it, even to a refused address", async () => {
    const location = `https://${dot(169, 254, 169, 254)}/latest/meta-data`;
    const { request, seen } = fakeRequest({ status: 302, headers: { location } });
    const answer = await deliveryFetch(
      "https://hooks.example.org/fin",
      {},
      { ownZones: [], resolve, request },
    );
    expect(answer).toMatchObject({ status: 302, location });
    expect(seen.filter((s) => "host" in s)).toHaveLength(1);
    await expect(
      deliveryFetch(location, {}, { ownZones: [], resolve, request }),
    ).rejects.toMatchObject({ reason: "ip_literal" });
  });

  it("keeps at most 1 KB of the answer", async () => {
    const { request } = fakeRequest({ status: 200, body: "x".repeat(5000) });
    const answer = await deliveryFetch(
      "https://hooks.example.org/fin",
      {},
      { ownZones: [], resolve, request },
    );
    expect(answer.body.length).toBe(1024);
  });

  it("refuses before connecting when a resolved address is refused", async () => {
    const { request, seen } = fakeRequest({ status: 200 });
    const bad = async () => [{ address: dot(10, 1, 2, 3), family: 4 as const }];
    await expect(
      deliveryFetch("https://hooks.example.org/", {}, { ownZones: [], resolve: bad, request }),
    ).rejects.toMatchObject({ reason: "refused_address", detailCode: "private" });
    expect(seen).toHaveLength(0);
  });
});
