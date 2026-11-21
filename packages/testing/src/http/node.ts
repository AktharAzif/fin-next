// The harness's one bridge to Node's HTTP stack: a listener that hands each request to a handler
// as Web types, and a forwarder that sends a request upstream exactly as given (the raw target,
// every header in order, the `Host` the caller chose). Everything else in @fin/testing works on
// Web `Response` objects and these plain request records, so it stays testable without sockets.
//
// node:http is used here, and only here, because the static host must proxy `/api/` with the
// configured `Host` header and the browser's headers unchanged (spec 01 §4.7), which `fetch()`
// cannot do: it drops a caller's `Host` and adds `accept-language`, `sec-fetch-mode` and
// `user-agent` of its own. The import rules allow node:http only in packages/server and
// apps/connector (spec 01 §4.6); this test-only file needs the steward's exception (recorded in the
// pull request's Decisions).
//
// biome-ignore lint/style/noRestrictedImports: the static host is Node built-ins only and must set Host (spec 01 §4.7); test target only, steward exception requested
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Header pairs in the order they arrived, names as sent. */
export type RawHeaders = ReadonlyArray<readonly [name: string, value: string]>;

/** One request as the harness sees it, before any parsing that could change it. */
export interface HostRequest {
  readonly method: string;
  /** The request-target exactly as received (origin-form, never rebuilt from a URL). */
  readonly target: string;
  readonly headers: RawHeaders;
  readonly body: ReadableStream<Uint8Array> | null;
  /** The TCP peer, with any IPv4-mapped IPv6 prefix removed. */
  readonly remoteAddress: string;
}

export type Handler = (request: HostRequest) => Promise<Response>;

export interface Listening {
  /** `http://<host>:<port>`, the origin a browser uses. */
  readonly origin: string;
  /** `<host>:<port>`, the authority a browser sends as `Host`. */
  readonly authority: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface ListenOptions {
  /** Defaults to 127.0.0.1: the harness never listens beyond loopback. */
  readonly host?: string;
  /** 0 (the default) picks a free port. */
  readonly port?: number;
  /** Called when a handler throws; the client gets a bare 500 either way. */
  readonly onError?: (error: unknown) => void;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** Pairs Node's flat rawHeaders list. */
export function pairRawHeaders(flat: readonly string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pairs.push([flat[i] as string, flat[i + 1] as string]);
  }
  return pairs;
}

/** The last value of a header, by case-insensitive name. */
export function headerValue(headers: RawHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  let found: string | undefined;
  for (const [key, value] of headers) if (key.toLowerCase() === lower) found = value;
  return found;
}

function normaliseAddress(address: string | undefined): string {
  if (address === undefined) return "";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function hasBody(incoming: IncomingMessage): boolean {
  if (incoming.method === "GET" || incoming.method === "HEAD") return false;
  return (
    incoming.headers["transfer-encoding"] !== undefined ||
    (incoming.headers["content-length"] !== undefined && incoming.headers["content-length"] !== "0")
  );
}

function setResponseHeaders(response: Response, set: (name: string, value: string[]) => void) {
  const grouped = new Map<string, string[]>();
  response.headers.forEach((value, name) => {
    if (name === "set-cookie") return;
    grouped.set(name, [...(grouped.get(name) ?? []), value]);
  });
  for (const [name, values] of grouped) set(name, values);
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) set("set-cookie", cookies);
}

/** Serves `handler` on loopback until `close()`. */
export function listen(handler: Handler, options: ListenOptions = {}): Promise<Listening> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) {
    return Promise.reject(new Error("the test harness listens on loopback only"));
  }
  const server = createServer(async (incoming, outgoing) => {
    const request: HostRequest = {
      method: incoming.method ?? "GET",
      target: incoming.url ?? "/",
      headers: pairRawHeaders(incoming.rawHeaders),
      body: hasBody(incoming) ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : null,
      remoteAddress: normaliseAddress(incoming.socket.remoteAddress),
    };
    let response: Response;
    try {
      response = await handler(request);
    } catch (error) {
      options.onError?.(error);
      response = new Response(null, { status: 500 });
    }
    outgoing.statusCode = response.status;
    if (response.statusText !== "") outgoing.statusMessage = response.statusText;
    setResponseHeaders(response, (name, values) =>
      outgoing.setHeader(name, values.length === 1 ? (values[0] as string) : values),
    );
    if (response.body === null || request.method === "HEAD") {
      await response.body?.cancel();
      outgoing.end();
      return;
    }
    try {
      await pipeline(Readable.fromWeb(response.body as never), outgoing);
    } catch (error) {
      options.onError?.(error);
      outgoing.destroy();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the server has no TCP address"));
        return;
      }
      const shown = address.family === "IPv6" ? `[${address.address}]` : address.address;
      const authority = `${host === "localhost" ? "localhost" : shown}:${address.port}`;
      resolve({
        origin: `http://${authority}`,
        authority,
        port: address.port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}

export interface ForwardRequest {
  readonly method: string;
  /** Sent as the request-target unchanged. */
  readonly target: string;
  /** Sent in this order; must already carry the `Host` the upstream should see. */
  readonly headers: RawHeaders;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface ForwardOptions {
  /** Milliseconds to wait for the upstream's answer headers (default 30 s). */
  readonly timeoutMs?: number;
}

const NO_BODY_STATUS = new Set([204, 205, 304]);

/**
 * Sends `request` to `upstream` (an http origin) on a fresh connection and answers with the
 * upstream's status, headers (each `Set-Cookie` kept apart) and streamed body. Rejects when the
 * upstream cannot be reached or does not answer in time.
 */
export function forward(
  upstream: string,
  request: ForwardRequest,
  options: ForwardOptions = {},
): Promise<Response> {
  const url = new URL(upstream);
  if (url.protocol !== "http:") return Promise.reject(new Error("the upstream must be http"));
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port === "" ? 80 : Number(url.port),
        method: request.method,
        path: request.target,
        headers: request.headers.flat(),
        setHost: false,
        agent: false,
        timeout: options.timeoutMs ?? 30_000,
      },
      (answer) => {
        const headers = new Headers();
        for (const [name, value] of pairRawHeaders(answer.rawHeaders)) headers.append(name, value);
        const status = answer.statusCode ?? 502;
        const empty = request.method === "HEAD" || NO_BODY_STATUS.has(status);
        if (empty) answer.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(answer) as ReadableStream<Uint8Array>), {
            status,
            statusText: answer.statusMessage ?? "",
            headers,
          }),
        );
      },
    );
    outgoing.once("timeout", () => outgoing.destroy(new Error("the upstream did not answer")));
    outgoing.once("error", reject);
    if (request.body === null) {
      outgoing.end();
    } else {
      pipeline(Readable.fromWeb(request.body as never), outgoing).catch((error: unknown) =>
        outgoing.destroy(error instanceof Error ? error : new Error("request body failed")),
      );
    }
  });
}
