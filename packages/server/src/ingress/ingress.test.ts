// T08-40 and AC-P0-07's unit half: only a connector peer with the host's proof is tunnel traffic.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ResolvedAddress } from "../dns/railway-lookup.ts";
import type { FinEnv } from "../http/context.ts";
import { refuse, requestUnit } from "../http/request.ts";
import { capture, randomProof } from "../testing/capture.ts";
import { ingressCheck } from "./check.ts";
import { ConnectorPeers, normaliseAddress } from "./peers.ts";
import { IngressProofs } from "./proofs.ts";

const CONNECTOR = "2001:db8::c1";
const NEIGHBOUR = "2001:db8::99";

describe("normaliseAddress", () => {
  it("turns IPv4-mapped forms into IPv4 and lower-cases IPv6", () => {
    expect(normaliseAddress("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(normaliseAddress("::FFFF:cb00:7105")).toBe("203.0.113.5");
    expect(normaliseAddress("2001:DB8::C1")).toBe("2001:db8::c1");
    expect(normaliseAddress("203.0.113.5")).toBe("203.0.113.5");
  });
});

describe("ConnectorPeers", () => {
  it("resolves every connector service and re-resolves every 15 seconds", async () => {
    const { clock } = capture();
    let answers: Record<string, ResolvedAddress[]> = {
      "cloudflared-public.railway.internal": [{ address: "::ffff:203.0.113.5", family: 6 }],
      "cloudflared-public-b.railway.internal": [{ address: CONNECTOR, family: 6 }],
    };
    const asked: string[] = [];
    const peers = new ConnectorPeers({
      services: ["cloudflared-public", "cloudflared-public-b"],
      resolveAll: async (host) => {
        asked.push(host);
        const found = answers[host];
        if (found === undefined) throw new Error("NXDOMAIN");
        return found;
      },
      clock,
      refreshMs: 20,
    });
    await peers.start();
    expect(peers.ready).toBe(true);
    expect(peers.has("203.0.113.5")).toBe(true);
    expect(peers.has("::ffff:203.0.113.5")).toBe(true);
    expect(peers.has(CONNECTOR)).toBe(true);
    expect(peers.has(NEIGHBOUR)).toBe(false);
    answers = { "cloudflared-public.railway.internal": [{ address: NEIGHBOUR, family: 6 }] };
    await new Promise((r) => setTimeout(r, 60));
    expect(peers.has(NEIGHBOUR)).toBe(true);
    expect(peers.has(CONNECTOR)).toBe(false);
    peers.stop();
    expect(asked.length).toBeGreaterThanOrEqual(4);
  });

  it("re-resolves on demand at most once a second", async () => {
    const { clock } = capture();
    let calls = 0;
    const peers = new ConnectorPeers({
      services: ["cloudflared-public"],
      resolveAll: async () => {
        calls++;
        return [];
      },
      clock,
    });
    expect(await peers.refreshOnDemand()).toBe(true);
    expect(await peers.refreshOnDemand()).toBe(false);
    clock.advance(999);
    expect(await peers.refreshOnDemand()).toBe(false);
    clock.advance(1);
    expect(await peers.refreshOnDemand()).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("IngressProofs", () => {
  it("accepts the current and the previous value of the host's role only", () => {
    const [current, previous, other] = [randomProof(), randomProof(), randomProof()];
    const proofs = new IngressProofs({ console: [current, previous], admin: [other] });
    expect(proofs.matches("console", current)).toBe(true);
    expect(proofs.matches("console", previous)).toBe(true);
    expect(proofs.matches("console", other)).toBe(false);
    expect(proofs.matches("console", undefined)).toBe(false);
    expect(proofs.matches("console", `${current}x`)).toBe(false);
    expect(proofs.matches("verify", current)).toBe(false);
    expect(proofs.matchesAny(other)).toBe(true);
  });
});

function setup() {
  const proof = randomProof();
  const captured = capture();
  let resolutions = 0;
  let connectors = [CONNECTOR];
  const peers = new ConnectorPeers({
    services: ["cloudflared-public"],
    resolveAll: async () => {
      resolutions++;
      return connectors.map((address) => ({ address, family: 6 as const }));
    },
    clock: captured.clock,
  });
  const options = {
    telemetry: captured.telemetry,
    reporter: captured.reporter,
    clock: captured.clock,
    docsOrigin: "https://docs.example.net",
  };
  const app = new Hono<FinEnv>();
  app.use(requestUnit(options));
  app.use(
    ingressCheck({
      peers,
      proofs: new IngressProofs({ console: [proof] }),
      origins: { console: "https://console.example.net" },
      telemetry: captured.telemetry,
      refuse: (c, status, code) => refuse(options, c, status, code),
    }),
  );
  app.all("/api/*", (c) =>
    c.json({
      ingress: c.get("ingress") ?? null,
      proof: c.req.header("fin-ingress-proof") ?? null,
      connecting: c.req.header("cf-connecting-ip") ?? null,
    }),
  );
  const send = (
    peer: string,
    headers: Record<string, string>,
    target = "/api/x?y=1",
  ): Promise<Response> =>
    Promise.resolve(
      app.request(
        `http://console.example.net${target.startsWith("/") && !target.startsWith("//") ? target : "/"}`,
        { headers: { host: "console.example.net", ...headers } },
        { incoming: { socket: { remoteAddress: peer }, url: target } } as never,
      ),
    );
  return {
    proof,
    captured,
    peers,
    send,
    resolutions: () => resolutions,
    setConnectors: (next: string[]) => {
      connectors = next;
    },
  };
}

describe("ingressCheck", () => {
  it("trusts a connector peer with the host's proof, removes the proof and keeps Cf headers", async () => {
    const { proof, peers, send, captured } = setup();
    await peers.start();
    const res = await send(CONNECTOR, {
      "fin-ingress-proof": proof,
      "cf-connecting-ip": "198.51.100.7",
      "cf-ipcountry": "GB",
      "cf-visitor": '{"scheme":"https"}',
      "cf-ray": "8f0a1b2c3d4e5f60-LHR",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ingress: Record<string, unknown>;
      proof: unknown;
      connecting: unknown;
    };
    expect(body.proof).toBeNull();
    expect(body.connecting).toBe("198.51.100.7");
    expect(body.ingress).toEqual({
      role: "console",
      host: "console.example.net",
      publicUrl: "https://console.example.net/api/x?y=1",
      clientIp: "198.51.100.7",
      country: "GB",
      scheme: "https",
      cfRay: "8f0a1b2c3d4e5f60-LHR",
    });
    expect(captured.events("ingress.untrusted_peer")).toHaveLength(0);
    expect(JSON.stringify(captured.stdout)).not.toContain(proof);
  });

  it("refuses a neighbour with a valid proof: 403, ingress.untrusted_peer, Cf headers dropped", async () => {
    const { proof, peers, send, captured, resolutions } = setup();
    await peers.start();
    const before = resolutions();
    const res = await send(NEIGHBOUR, {
      "fin-ingress-proof": proof,
      "cf-connecting-ip": "198.51.100.7",
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(captured.events("ingress.untrusted_peer")).toEqual([
      expect.objectContaining({ reason: "peer_unknown", role: "console", level: "warn" }),
    ]);
    expect(resolutions()).toBe(before + 1);
    const line = captured.events("request")[0];
    expect(line).toMatchObject({ status: 403, outcome: "refused", reason: "ingress.peer_unknown" });
    expect(JSON.stringify(captured.stdout)).not.toContain(proof);
  });

  it("re-resolves once when a redeployed connector presents the proof", async () => {
    const { proof, peers, send, setConnectors } = setup();
    await peers.start();
    setConnectors([NEIGHBOUR]);
    const res = await send(NEIGHBOUR, { "fin-ingress-proof": proof });
    expect(res.status).toBe(200);
  });

  it("refuses a connector peer without the proof, or with another value", async () => {
    const { peers, send, captured } = setup();
    await peers.start();
    expect((await send(CONNECTOR, {})).status).toBe(403);
    expect((await send(CONNECTOR, { "fin-ingress-proof": randomProof() })).status).toBe(403);
    expect(captured.events("ingress.untrusted_peer").map((l) => l.reason)).toEqual([
      "proof_missing",
      "proof_mismatch",
    ]);
  });

  it("answers 421 for a host it does not serve, and 400 for a bad target", async () => {
    const { proof, peers, send } = setup();
    await peers.start();
    const wrongHost = await send(CONNECTOR, {
      "fin-ingress-proof": proof,
      host: "admin.example.net",
    });
    expect(wrongHost.status).toBe(421);
    const wrongBoth = await send(CONNECTOR, {
      "fin-ingress-proof": randomProof(),
      host: "admin.example.net",
    });
    expect(wrongBoth.status).toBe(403);
    for (const target of ["//api/x", "/api\\x", "http://evil.example.com/api/x"]) {
      expect((await send(CONNECTOR, { "fin-ingress-proof": proof }, target)).status, target).toBe(
        400,
      );
    }
  });

  it("answers 421 when the proof is the host's but Host names another configured name", async () => {
    const proof = randomProof();
    const captured = capture();
    const peers = new ConnectorPeers({
      services: ["cloudflared-public"],
      resolveAll: async () => [{ address: CONNECTOR, family: 6 }],
      clock: captured.clock,
    });
    await peers.start();
    const options = {
      telemetry: captured.telemetry,
      reporter: captured.reporter,
      clock: captured.clock,
      docsOrigin: "https://docs.example.net",
    };
    const app = new Hono<FinEnv>();
    app.use(requestUnit(options));
    app.use(
      ingressCheck({
        peers,
        proofs: new IngressProofs({ console: [proof] }),
        origins: { console: "https://console.example.net" },
        telemetry: captured.telemetry,
        refuse: (c, s, code) => refuse(options, c, s, code),
      }),
    );
    app.get("/api/x", (c) => c.text("ok"));
    const res = await app.request(
      "http://other.example.net/api/x",
      { headers: { host: "other.example.net", "fin-ingress-proof": proof } },
      { incoming: { socket: { remoteAddress: CONNECTOR }, url: "/api/x" } } as never,
    );
    expect(res.status).toBe(421);
  });
});
