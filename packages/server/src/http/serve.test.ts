// The server's own edges, over a real socket: a request the adapter cannot parse is still answered
// by the front door, inside the request unit, with its line, its request ID and the API headers
// (spec 08 §7.2: one `request` line per request; T08-40).
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ingressCheck } from "../ingress/check.ts";
import { ConnectorPeers } from "../ingress/peers.ts";
import { IngressProofs } from "../ingress/proofs.ts";
import { capture, randomProof, TEST_RELEASE } from "../testing/capture.ts";
import { rawRequest } from "../testing/raw-http.ts";
import type { FinEnv } from "./context.ts";
import { apiHeaders } from "./headers.ts";
import { errorHandler, notFoundHandler, refuse, requestUnit } from "./request.ts";
import { startHttpServer } from "./serve.ts";

async function serve() {
  const proof = randomProof();
  const captured = capture();
  const peers = new ConnectorPeers({
    services: ["cloudflared-public"],
    resolver: { resolveAll: async () => [{ address: "127.0.0.1", family: 4 as const }] },
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
      refuse: (c, status, code) => refuse(options, c, status, code),
    }),
  );
  app.all("/api/*", (c) => c.json({ ok: true }));
  const server = await startHttpServer({ fetch: app.fetch, port: 0, host: "127.0.0.1" });
  return { proof, captured, server };
}

describe("startHttpServer", () => {
  it("answers what the adapter cannot parse through the front door, inside the request unit", async () => {
    const { proof, captured, server } = await serve();
    try {
      const cases: { head: string; body?: string; status: number; reason: string }[] = [
        {
          head: "GET /api\\x HTTP/1.1\r\nHost: console.example.net\r\n",
          status: 400,
          reason: "ingress.bad_target",
        },
        {
          head: "GET * HTTP/1.1\r\nHost: console.example.net\r\n",
          status: 400,
          reason: "ingress.bad_target",
        },
        {
          head: "POST /api\\x HTTP/1.1\r\nHost: console.example.net\r\nContent-Length: 5\r\n",
          body: "hello",
          status: 400,
          reason: "ingress.bad_target",
        },
        {
          head: `GET /api/x HTTP/1.1\r\nFin-Ingress-Proof: ${proof}\r\n`,
          status: 421,
          reason: "ingress.host",
        },
        {
          head: `GET /api/x HTTP/1.1\r\nHost: a b\r\nFin-Ingress-Proof: ${proof}\r\n`,
          status: 421,
          reason: "ingress.host",
        },
        { head: "GET /api/x HTTP/1.1\r\n", status: 403, reason: "ingress.proof_missing" },
      ];
      for (const { head, body: sent, status, reason } of cases) {
        const answer = await rawRequest(server.port, `${head}Connection: close\r\n`, sent);
        const label = head.split("\r\n")[0] ?? head;
        expect(answer.status, label).toBe(status);
        expect(answer.headers["content-type"], label).toBe("application/problem+json");
        expect(answer.headers["request-id"], label).toMatch(/^req_/);
        expect(answer.headers["cache-control"], label).toBe("no-store");
        expect(answer.headers["x-content-type-options"], label).toBe("nosniff");
        expect(answer.headers.connection, label).toBe("close");
        const body = JSON.parse(answer.body) as { request_id: string };
        expect(body.request_id, label).toBe(answer.headers["request-id"]);
        const line = captured.events("request").at(-1);
        expect(line, label).toMatchObject({ status, outcome: "refused", reason });
      }
      expect(captured.events("request")).toHaveLength(cases.length);
      expect(JSON.stringify(captured.stdout)).not.toContain(proof);
    } finally {
      await server.close(100);
    }
  });

  it("still answers a well-formed request from a connector with the proof", async () => {
    const { proof, server } = await serve();
    try {
      const answer = await rawRequest(
        server.port,
        `GET /api/x HTTP/1.1\r\nHost: console.example.net\r\nFin-Ingress-Proof: ${proof}\r\nConnection: close\r\n`,
      );
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toEqual({ ok: true });
    } finally {
      await server.close(100);
    }
  });
});
