// The Node HTTP server every Fin service runs (ARCHITECTURE §3.5): `[::]:8080`, keep-alive 95 s and
// headers 96 s (longer than cloudflared's 90 s idle reuse), requests 110 s (under Cloudflare's
// 125 s), and a draining mode that answers with `Connection: close` during the pre-stop window.
//
// A request the adapter cannot turn into a Request (a target that does not start with `/`, a `\`
// in its path, a missing or malformed Host) still goes through the app: the app answers a stand-in
// Request with the same Node message behind it, so the front door refuses it from the raw target
// with the request unit, its `request` line and the API headers, and the connection closes.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener, RequestError } from "@hono/node-server";

export const KEEP_ALIVE_TIMEOUT_MS = 95_000;
export const HEADERS_TIMEOUT_MS = 96_000;
export const REQUEST_TIMEOUT_MS = 110_000;

export type FetchHandler = Parameters<typeof getRequestListener>[0];

/** The stand-in's URL: a reserved name and a path no front door answers before refusing. */
export const UNPARSED_URL = "http://unparsed.invalid/";

const STAND_IN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
/** Headers that describe the original message's framing or connection, not the request. */
const NOT_COPIED = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
]);

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

function standIn(incoming: IncomingMessage): Request {
  const headers = new Headers();
  const raw = incoming.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] ?? "";
    if (NOT_COPIED.has(name.toLowerCase())) continue;
    try {
      headers.append(name, raw[i + 1] ?? "");
    } catch {
      // A header Fetch cannot hold is not one the front door reads.
    }
  }
  const method = (incoming.method ?? "GET").toUpperCase();
  return new Request(UNPARSED_URL, {
    method: STAND_IN_METHODS.has(method) ? method : "GET",
    headers,
  });
}

/** Answers what the adapter refused: the app's refusal for a request it could not parse, else 500. */
async function answerUnparsed(
  fetch: FetchHandler,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  error: unknown,
): Promise<Response> {
  if (!(error instanceof RequestError)) return new Response(null, { status: 500 });
  // The body of a request no one will read is discarded, and the connection closes after the answer.
  incoming.resume();
  let answer: Response;
  try {
    const result: unknown = await fetch(standIn(incoming), { incoming, outgoing });
    answer = result instanceof Response ? result : new Response(null, { status: 400 });
  } catch {
    answer = new Response(null, { status: 400 });
  }
  const closing = new Response(answer.body, answer);
  closing.headers.set("connection", "close");
  return closing;
}

export function startHttpServer(options: {
  fetch: FetchHandler;
  port: number;
  host?: string;
}): Promise<HttpServerHandle> {
  let draining = false;
  // Node would answer a missing Host itself, with no line; the front door answers it instead.
  const server = createServer({ requireHostHeader: false }, (incoming, outgoing) => {
    if (draining) outgoing.setHeader("connection", "close");
    const listener = getRequestListener(options.fetch, {
      errorHandler: (error) => answerUnparsed(options.fetch, incoming, outgoing, error),
    });
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
