// The supervisor's only listener (spec 01 §7.3): `GET /healthz` and `GET /readyz` on [::]:8080, for
// Railway's deploy health check. Everything else is 404. cloudflared's own metrics stay on loopback,
// so `/config`, `/diag/*` and `/debug/pprof/*` are never served to neighbours (SP-04g).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface HealthServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export function startHealthServer(options: {
  port: number;
  host?: string;
  ready: () => boolean;
  alive: () => boolean;
}): Promise<HealthServer> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const send = (status: number, body: unknown): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-length": Buffer.byteLength(text),
      });
      res.end(req.method === "HEAD" ? undefined : text);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(404, { status: "not_found" });
    if (path === "/healthz")
      return options.alive() ? send(200, { status: "ok" }) : send(503, { status: "exiting" });
    if (path === "/readyz")
      return options.ready() ? send(200, { status: "ready" }) : send(503, { status: "not_ready" });
    return send(404, { status: "not_found" });
  });
  server.keepAliveTimeout = 5000;
  server.requestTimeout = 10_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: options.port, host: options.host ?? "::", ipv6Only: false }, () => {
      server.off("error", reject);
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
