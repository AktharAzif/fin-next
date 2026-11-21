// AC-P0-07's unit half and spec 01 §6.4: /healthz and /readyz answer private callers that are not
// connectors, and are 404 through a public host, with a proof, from a connector peer, and for any
// method but GET and HEAD.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { FinEnv } from "../http/context.ts";
import { notFoundHandler, requestUnit } from "../http/request.ts";
import { startHttpServer } from "../http/serve.ts";
import { ConnectorPeers } from "../ingress/peers.ts";
import { capture, randomProof } from "../testing/capture.ts";
import { privateHealth, Readiness } from "./readiness.ts";

const CONNECTOR = "2001:db8::c1";
const NEIGHBOUR = "2001:db8::99";
const RAILWAY = "healthcheck.railway.app";

async function setup(peerAddresses: string[] = [CONNECTOR]) {
  const captured = capture();
  const peers = new ConnectorPeers({
    services: ["cloudflared-public"],
    resolver: {
      resolveAll: async () => peerAddresses.map((address) => ({ address, family: 6 as const })),
    },
    clock: captured.clock,
  });
  await peers.start();
  const readiness = new Readiness();
  const options = {
    telemetry: captured.telemetry,
    reporter: captured.reporter,
    clock: captured.clock,
    docsOrigin: "https://docs.example.net",
  };
  const notFound = notFoundHandler(options);
  const app = new Hono<FinEnv>();
  app.use(requestUnit(options));
  app.use(privateHealth({ readiness, peers, publicHosts: ["console.example.net"], notFound }));
  app.all("*", (c) => c.text("past health", 200));
  const ask = (
    path: string,
    init: { peer?: string; host?: string; method?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> => {
    const headers = { host: init.host ?? RAILWAY, ...init.headers };
    return Promise.resolve(
      app.request(`http://${headers.host}${path}`, { method: init.method ?? "GET", headers }, {
        incoming: { socket: { remoteAddress: init.peer ?? NEIGHBOUR }, url: path },
      } as never),
    );
  };
  return { captured, readiness, ask, app };
}

describe("privateHealth", () => {
  it("answers Railway's checker and a private neighbour", async () => {
    const { ask } = await setup();
    const healthz = await ask("/healthz");
    expect(healthz.status).toBe(200);
    expect(await healthz.json()).toEqual({ status: "ok" });
    expect((await ask("/readyz")).status).toBe(200);
    expect((await ask("/readyz", { method: "HEAD" })).status).toBe(200);
    expect((await ask("/readyz", { host: "console.railway.internal:8080" })).status).toBe(200);
  });

  it("is 404 through a public host, in any case and with any port", async () => {
    const { ask, captured } = await setup();
    for (const host of [
      "console.example.net",
      "Console.Example.NET",
      "console.example.net:443",
      "console.example.net.",
    ]) {
      expect((await ask("/readyz", { host })).status, host).toBe(404);
      expect((await ask("/healthz", { host })).status, host).toBe(404);
    }
    expect(captured.events("request").every((l) => l.reason === "health.public")).toBe(true);
  });

  it("is 404 with a proof header, from a connector peer, and for any other method", async () => {
    const { ask, captured } = await setup();
    const proof = { "fin-ingress-proof": randomProof() };
    expect((await ask("/readyz", { headers: proof })).status).toBe(404);
    expect((await ask("/healthz", { peer: CONNECTOR })).status).toBe(404);
    expect((await ask("/readyz", { peer: `::ffff:${"203.0.113.5"}` })).status).toBe(200);
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      expect((await ask("/readyz", { method })).status, method).toBe(404);
    }
    const refused = captured.events("request").filter((l) => l.status === 404);
    expect(refused).toHaveLength(6);
    expect(refused.every((l) => l.reason === "health.public" && l.route !== "unmatched")).toBe(
      true,
    );
  });

  it("leaves every other path to the next step", async () => {
    const { ask } = await setup();
    expect(await (await ask("/healthz/")).text()).toBe("past health");
    expect(await (await ask("/api/readyz")).text()).toBe("past health");
  });

  it("answers 503 with what is failing while a check fails or the process stops", async () => {
    const { ask, readiness } = await setup();
    let dbOk = false;
    readiness.add("database", () => dbOk);
    const failing = await ask("/readyz");
    expect(failing.status).toBe(503);
    expect(await failing.json()).toEqual({ status: "not_ready", failing: ["database"] });
    dbOk = true;
    expect((await ask("/readyz")).status).toBe(200);
    readiness.markStopping();
    const stopping = await ask("/readyz");
    expect(stopping.status).toBe(503);
    expect(await stopping.json()).toEqual({ status: "not_ready", failing: ["shutting_down"] });
    expect((await ask("/healthz")).status).toBe(200);
  });

  it("refuses a connector peer over a real socket, and answers a neighbour", async () => {
    const asConnector = await setup(["127.0.0.1"]);
    const server = await startHttpServer({
      fetch: asConnector.app.fetch,
      port: 0,
      host: "127.0.0.1",
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/readyz`);
      expect(res.status).toBe(404);
    } finally {
      await server.close(100);
    }
    const asNeighbour = await setup([CONNECTOR]);
    const other = await startHttpServer({
      fetch: asNeighbour.app.fetch,
      port: 0,
      host: "127.0.0.1",
    });
    try {
      expect((await fetch(`http://127.0.0.1:${other.port}/readyz`)).status).toBe(200);
    } finally {
      await other.close(100);
    }
  });
});
