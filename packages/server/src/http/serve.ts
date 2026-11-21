// The Node HTTP server every Fin service runs (ARCHITECTURE §3.5): `[::]:8080`, keep-alive 95 s and
// headers 96 s (longer than cloudflared's 90 s idle reuse), requests 110 s (under Cloudflare's
// 125 s), and a draining mode that answers with `Connection: close` during the pre-stop window.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";

export const KEEP_ALIVE_TIMEOUT_MS = 95_000;
export const HEADERS_TIMEOUT_MS = 96_000;
export const REQUEST_TIMEOUT_MS = 110_000;

export type FetchHandler = Parameters<typeof getRequestListener>[0];

export interface HttpServerHandle {
  server: Server;
  port: number;
  /** From now on every answer carries `Connection: close`. */
  startDraining(): void;
  readonly draining: boolean;
  /** Stops accepting, closes idle sockets, waits for in-flight requests up to `graceMs`. */
  close(graceMs: number): Promise<{ forced: boolean }>;
  connections(): Promise<number>;
}

export function startHttpServer(options: {
  fetch: FetchHandler;
  port: number;
  host?: string;
}): Promise<HttpServerHandle> {
  const listener = getRequestListener(options.fetch, {
    // A request Node cannot even parse into a Request: answer 400 with no detail.
    errorHandler: () => new Response(null, { status: 400 }),
  });
  let draining = false;
  const server = createServer((incoming, outgoing) => {
    if (draining) outgoing.setHeader("connection", "close");
    void listener(incoming, outgoing);
  });
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: options.port, host: options.host ?? "::", ipv6Only: false }, () => {
      server.off("error", reject);
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        startDraining: () => {
          draining = true;
        },
        get draining() {
          return draining;
        },
        close: (graceMs) =>
          new Promise((done) => {
            let finished = false;
            const timer = setTimeout(
              () => {
                if (finished) return;
                finished = true;
                server.closeAllConnections();
                done({ forced: true });
              },
              Math.max(0, graceMs),
            );
            timer.unref();
            server.close(() => {
              if (finished) return;
              finished = true;
              clearTimeout(timer);
              done({ forced: false });
            });
            server.closeIdleConnections();
          }),
        connections: () =>
          new Promise((done, fail) => server.getConnections((e, n) => (e ? fail(e) : done(n)))),
      });
    });
  });
}
