// T08-40 and AC-P0-07's unit half: only a connector peer with the host's proof is tunnel traffic.
import { createManualClock } from "@fin/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createPrivateResolver, type ResolvedAddress, STALE_MS } from "../dns/railway-lookup.ts";
import type { FinEnv } from "../http/context.ts";
import { apiHeaders } from "../http/headers.ts";
import { errorHandler, notFoundHandler, refuse, requestUnit } from "../http/request.ts";
import { startHttpServer } from "../http/serve.ts";
import { capture, randomProof, TEST_RELEASE } from "../testing/capture.ts";
import { rawRequest } from "../testing/raw-http.ts";
import { ingressCheck } from "./check.ts";
import { ConnectorPeers, normaliseAddress } from "./peers.ts";
import { IngressProofs } from "./proofs.ts";

const CONNECTOR = "2001:db8::c1";
const NEIGHBOUR = "2001:db8::99";

/** A resolver stub: each name's current answer, or a lookup failure. */
function stubResolver(answers: () => Record<string, string[]>, delayMs = 0) {
  let lookups = 0;
  return {
    lookups: () => lookups,
    resolver: {
      resolveAll: async (hostname: string): Promise<ResolvedAddress[]> => {
        lookups++;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        const found = answers()[hostname];
        if (found === undefined) {
          throw Object.assign(new Error("NXDOMAIN"), { code: "ENOTFOUND" });
        }
        return found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
      },
    },
  };
}

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
    let answers: Record<string, string[]> = {
      "cloudflared-public.railway.internal": ["::ffff:203.0.113.5"],
      "cloudflared-public-b.railway.internal": [CONNECTOR],
    };
    const { resolver, lookups } = stubResolver(() => answers);
    const peers = new ConnectorPeers({
      services: ["cloudflared-public", "cloudflared-public-b"],
      resolver,
      clock,
      refreshMs: 20,
    });
    await peers.start();
    expect(peers.ready).toBe(true);
    expect(peers.has("203.0.113.5")).toBe(true);
    expect(peers.has("::ffff:203.0.113.5")).toBe(true);
    expect(peers.has(CONNECTOR)).toBe(true);
    expect(peers.has(NEIGHBOUR)).toBe(false);
    answers = { "cloudflared-public.railway.internal": [NEIGHBOUR] };
    await new Promise((r) => setTimeout(r, 60));
    expect(peers.has(NEIGHBOUR)).toBe(true);
    expect(peers.has(CONNECTOR)).toBe(false);
    peers.stop();
    expect(lookups()).toBeGreaterThanOrEqual(4);
  });

  it("re-resolves on demand at most once a second", async () => {
    const { clock } = capture();
    const { resolver, lookups } = stubResolver(() => ({
      "cloudflared-public.railway.internal": [CONNECTOR],
    }));
    const peers = new ConnectorPeers({ services: ["cloudflared-public"], resolver, clock });
    expect(await peers.refreshOnDemand()).toBe(true);
    expect(await peers.refreshOnDemand()).toBe(false);
    clock.advance(999);
    expect(await peers.refreshOnDemand()).toBe(false);
    clock.advance(1);
    expect(await peers.refreshOnDemand()).toBe(true);
    expect(lookups()).toBe(2);
  });

  it("asks DNS on demand even inside the private resolver's fresh window", async () => {
    const clock = createManualClock(0);
    let current = "2001:db8::a1";
    let queries = 0;
    const resolver = createPrivateResolver({
      clock,
      onFailure: () => undefined,
      resolve: async () => {
        queries++;
        return [{ address: current, family: 6 }];
      },
    });
    const peers = new ConnectorPeers({ services: ["cloudflared-public"], resolver, clock });
    await peers.start();
    peers.stop();
    expect(peers.has("2001:db8::a1")).toBe(true);
    // The connector is redeployed; three seconds after the last resolution its first request comes.
    current = "2001:db8::a2";
    clock.advance(3000);
    expect(await peers.refreshOnDemand()).toBe(true);
    expect(queries).toBe(2);
    expect(peers.has("2001:db8::a2")).toBe(true);
    expect(peers.has("2001:db8::a1")).toBe(false);
  });

  it("keeps a connector's address for the resolver's five stale minutes, and not after", async () => {
    const clock = createManualClock(0);
    let up = true;
    const failures: boolean[] = [];
    const resolver = createPrivateResolver({
      clock,
      onFailure: (fields) => failures.push(fields.stale),
      resolve: async (name) => {
        if (!up) throw Object.assign(new Error("down"), { code: "ENOTFOUND" });
        return name.startsWith("cloudflared-public.")
          ? [{ address: "2001:db8::c1", family: 6 }]
          : [];
      },
    });
    const peers = new ConnectorPeers({
      services: ["cloudflared-public", "cloudflared-public-b"],
      resolver,
      clock,
    });
    await peers.refresh();
    expect(peers.has("2001:db8::c1")).toBe(true);
    up = false;
    clock.advance(STALE_MS - 60_000);
    await peers.refresh();
    expect(peers.has("2001:db8::c1")).toBe(true);
    expect(peers.ready).toBe(true);
    clock.advance(2 * 60_000);
    await peers.refresh();
    expect(peers.has("2001:db8::c1")).toBe(false);
    expect(peers.ready).toBe(false);
    clock.advance(60 * 60_000);
    await peers.refresh();
    expect(peers.has("2001:db8::c1")).toBe(false);
    expect(failures.at(-1)).toBe(false);
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

/** A fake Node message behind a request: its socket, its raw target and its headers. */
function incomingFor(peer: string, target: string, headers: Record<string, string>) {
  return {
    socket: { remoteAddress: peer },
    url: target,
    rawHeaders: Object.entries(headers).flat(),
    headers: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    ),
  };
}

function setup(resolveDelayMs = 0) {
  const proof = randomProof();
  const captured = capture();
  let connectors = [CONNECTOR];
  const { resolver, lookups } = stubResolver(
    () => ({ "cloudflared-public.railway.internal": connectors }),
    resolveDelayMs,
  );
  const peers = new ConnectorPeers({
    services: ["cloudflared-public"],
    resolver,
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
  const seenByHandler: Record<string, unknown>[] = [];
  app.all("/api/*", (c) => {
    const incoming = c.env.incoming;
    seenByHandler.push({
      url: c.req.url,
      nodeHeader: incoming?.headers?.["fin-ingress-proof"],
      nodeRaw: incoming?.rawHeaders?.join("\n").toLowerCase().includes("fin-ingress-proof"),
    });
    return c.json({
      ingress: c.get("ingress") ?? null,
      proof: c.req.header("fin-ingress-proof") ?? null,
      connecting: c.req.header("cf-connecting-ip") ?? null,
    });
  });
  const send = (
    peer: string,
    headers: Record<string, string>,
    target = "/api/x?y=1",
  ): Promise<Response> => {
    const all = { host: "console.example.net", ...headers };
    const path = target.startsWith("/") && !target.startsWith("//") ? target : "/";
    return Promise.resolve(
      app.request(`http://console.example.net${path}`, { headers: all }, {
        incoming: incomingFor(peer, target, all),
      } as never),
    );
  };
  return {
    proof,
    captured,
    peers,
    send,
    seenByHandler,
    resolutions: lookups,
    setConnectors: (next: string[]) => {
      connectors = next;
    },
  };
}

describe("ingressCheck", () => {
  it("trusts a connector peer with the host's proof, removes the proof and keeps Cf headers", async () => {
    const { proof, peers, send, captured, seenByHandler } = setup();
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
    // The proof is gone from Node's message too, and the URL handlers see is the public one.
    expect(seenByHandler).toEqual([
      { url: "https://console.example.net/api/x?y=1", nodeHeader: undefined, nodeRaw: false },
    ]);
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

  it("lets every request a redeployed connector sends at once wait for the one re-resolve", async () => {
    const { proof, peers, send, setConnectors, resolutions } = setup(50);
    await peers.start();
    setConnectors([NEIGHBOUR]);
    const before = resolutions();
    const statuses = await Promise.all(
      Array.from({ length: 5 }, () =>
        send(NEIGHBOUR, { "fin-ingress-proof": proof }).then((r) => r.status),
      ),
    );
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
    expect(resolutions()).toBe(before + 1);
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

  it("removes the proof and every edge header from Node's message when it refuses", async () => {
    const proof = randomProof();
    const captured = capture();
    const { resolver } = stubResolver(() => ({
      "cloudflared-public.railway.internal": [CONNECTOR],
    }));
    const peers = new ConnectorPeers({
      services: ["cloudflared-public"],
      resolver,
      clock: captured.clock,
    });
    await peers.start();
    const app = new Hono<FinEnv>();
    app.use(
      ingressCheck({
        peers,
        proofs: new IngressProofs({ console: [proof] }),
        origins: { console: "https://console.example.net" },
        telemetry: captured.telemetry,
        refuse: () => new Response(null, { status: 403 }),
      }),
    );
    const headers = {
      Host: "console.example.net",
      "Fin-Ingress-Proof": proof,
      "CF-Connecting-IP": "198.51.100.7",
    };
    const incoming = incomingFor(NEIGHBOUR, "/api/x", headers);
    const res = await app.request("http://console.example.net/api/x", { headers }, {
      incoming,
    } as never);
    expect(res.status).toBe(403);
    expect(incoming.rawHeaders).toEqual(["Host", "console.example.net"]);
    expect(incoming.headers).toEqual({ host: "console.example.net" });
  });

  it("answers 421 for a host it does not serve, and 400 for a target that is not canonical", async () => {
    const { proof, peers, send, captured } = setup();
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
    for (const target of [
      "//api/x",
      "/api\\x",
      "http://evil.example.com/api/x",
      "/x/../api/x",
      "/api/./x",
      "/api/x/..",
      "/%61pi/x",
      "/api/%65cho",
      "/api%2Fx",
      "/api%2fx",
      "/api/%2e%2e/api/x",
      "/api/x%5Cy",
      "/api/x%00",
      "/api/x#y",
    ]) {
      expect((await send(CONNECTOR, { "fin-ingress-proof": proof }, target)).status, target).toBe(
        400,
      );
    }
    expect(captured.events("request").at(-1)).toMatchObject({ reason: "ingress.bad_target" });
    // A query may hold anything percent-encoded, and a path may encode what has no plain form.
    for (const target of ["/api/x?next=%2Fsettings%2E", "/api/a%20b", "/api/x%2Cy"]) {
      expect((await send(CONNECTOR, { "fin-ingress-proof": proof }, target)).status, target).toBe(
        200,
      );
    }
  });

  it("answers 421 when the proof is the host's but Host names another configured name", async () => {
    const proof = randomProof();
    const captured = capture();
    const { resolver } = stubResolver(() => ({
      "cloudflared-public.railway.internal": [CONNECTOR],
    }));
    const peers = new ConnectorPeers({
      services: ["cloudflared-public"],
      resolver,
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

describe("the ingress check on a real socket", () => {
  async function serve() {
    const proof = randomProof();
    const captured = capture();
    const { resolver } = stubResolver(() => ({
      "cloudflared-public.railway.internal": ["127.0.0.1"],
    }));
    const peers = new ConnectorPeers({
      services: ["cloudflared-public"],
      resolver,
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
    app.onError(errorHandler(options));
    app.notFound(notFoundHandler(options));
    app.use(requestUnit(options));
    app.use(apiHeaders({ release: TEST_RELEASE, environment: "ci", defaultRole: "console" }));
    app.use(
      ingressCheck({
        peers,
        proofs: new IngressProofs({ console: [proof] }),
        origins: { console: "https://console.example.net" },
        telemetry: captured.telemetry,
        refuse: (c, s, code) => refuse(options, c, s, code),
      }),
    );
    app.post("/api/echo", async (c) => {
      const incoming = c.env.incoming;
      return c.json({
        body: await c.req.text(),
        url: c.req.url,
        header: c.req.header("fin-ingress-proof") ?? null,
        node: incoming?.headers["fin-ingress-proof"] ?? null,
        nodeDistinct: incoming?.headersDistinct["fin-ingress-proof"] ?? null,
        nodeRaw: incoming?.rawHeaders.some((h) => h.toLowerCase() === "fin-ingress-proof"),
      });
    });
    app.get("/api/echo", (c) => c.json({ path: c.req.path }));
    const server = await startHttpServer({ fetch: app.fetch, port: 0, host: "127.0.0.1" });
    return { proof, captured, server };
  }

  it("leaves no trace of the proof in the Request, in Node's message or in a line", async () => {
    const { proof, captured, server } = await serve();
    try {
      // fetch() would send its own Host, so the request is written as the connector sends it.
      const res = await rawRequest(
        server.port,
        `POST /api/echo HTTP/1.1\r\nHost: console.example.net\r\nFin-Ingress-Proof: ${proof}\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n`,
        "hello",
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        body: "hello",
        url: "https://console.example.net/api/echo",
        header: null,
        node: null,
        nodeDistinct: null,
        nodeRaw: false,
      });
      expect(JSON.stringify(captured.stdout)).not.toContain(proof);
    } finally {
      await server.close(100);
    }
  });

  it("refuses encoded and dotted aliases of an /api/ route as the bytes arrive", async () => {
    const { proof, captured, server } = await serve();
    const targets = ["/%61pi/echo", "/api/%65cho", "/x/../api/echo", "/api/%2e%2e/api/echo"];
    try {
      for (const target of targets) {
        const answer = await rawRequest(
          server.port,
          `GET ${target} HTTP/1.1\r\nHost: console.example.net\r\nFin-Ingress-Proof: ${proof}\r\nConnection: close\r\n`,
        );
        expect(answer.status, target).toBe(400);
        expect(answer.headers["request-id"], target).toMatch(/^req_/);
      }
      expect(captured.events("request").map((l) => l.reason)).toEqual(
        targets.map(() => "ingress.bad_target"),
      );
    } finally {
      await server.close(100);
    }
  });
});
