// The harness's one bridge to Node's HTTP stack: a listener that hands each request to a handler
// as Web types, and a forwarder that sends a request upstream exactly as given (the raw target,
// every header in order, the `Host` the caller chose). Everything else in @fin/testing works on
// Web `Response` objects and these plain request records, so it stays testable without sockets.
//
// node:http and node:https are used here, and only here, because the static host must proxy
// `/api/` with the configured `Host` header and the browser's headers unchanged (spec 01 §4.7),
// which `fetch()` cannot do: it drops a caller's `Host` and adds `accept-language`,
// `sec-fetch-mode` and `user-agent` of its own. The app hosts answer over https, as the zone does,
// so that every engine keeps Fin's `__Host-` cookies. The import rules allow these modules only in
// packages/server and apps/connector (spec 01 §4.6); this test-only file needs the steward's
// exception (recorded in the pull request's Decisions).
//
// biome-ignore lint/style/noRestrictedImports: the static host is Node built-ins only and must set Host (spec 01 §4.7); test target only, steward exception requested
import * as http from "node:http";
// biome-ignore lint/style/noRestrictedImports: the app hosts answer over https as the zone does, so WebKit keeps Secure cookies; test target only, steward exception requested
import * as https from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { TlsIdentity } from "./certificate.ts";

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
  /** `<scheme>://<name>:<port>`, the origin a browser uses. */
  readonly origin: string;
  /** `<name>:<port>`, the authority a browser sends as `Host`. */
  readonly authority: string;
  /**
   * `<scheme>://<bound address>:<port>`: the same server for a Node client that should not depend
   * on name resolution (a name under `.localhost` resolves in browsers, but not everywhere in Node).
   */
  readonly loopbackOrigin: string;
  readonly port: number;
  /** The certificate (PEM) an https server presents, for a Node client to trust as `ca`. */
  readonly certificate: string | undefined;
  close(): Promise<void>;
}

export interface ListenOptions {
  /** The address to bind: 127.0.0.1 (the default), localhost or ::1, never beyond loopback. */
  readonly host?: string;
  /** 0 (the default) picks a free port. */
  readonly port?: number;
  /**
   * The host name clients use (default: `host`): localhost, a name under `.localhost` (which every
   * browser resolves to loopback), or a loopback address. It is the origin's host, and the `Host`
   * this server answers.
   */
  readonly name?: string;
  /** Serve https with this identity (see `selfSignedIdentity`); http without it. */
  readonly tls?: TlsIdentity;
  /**
   * Answer any `Host`. Only for a stand-in of a server that sits behind a proxy setting the public
   * `Host` (the API halves' test servers); every other harness server refuses a `Host` that is not
   * its own with 421, so a page that rebinds its name to loopback cannot read it.
   */
  readonly anyHost?: boolean;
  /** Called when a request is refused for its `Host` (the answer is 421 either way). */
  readonly onMisdirected?: (request: { readonly method: string }) => void;
  /** Called when a handler throws; the client gets a bare 500 either way. */
  readonly onError?: (error: unknown) => void;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

/** True for a name a browser resolves to loopback without asking DNS. */
export function isLoopbackName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    LOOPBACK.has(lower) ||
    lower === "[::1]" ||
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+localhost$/.test(lower)
  );
}

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

/**
 * True when `host` (a request's `Host`) names this server: its own name or a loopback name, with
 * its port (or none, when the port is the scheme's default).
 */
export function hostMatches(
  host: string | undefined,
  {
    name,
    port,
    secure,
  }: { readonly name: string; readonly port: number; readonly secure: boolean },
): boolean {
  if (host === undefined) return false;
  const value = host.trim().toLowerCase();
  const names = new Set([name.toLowerCase(), ...LOOPBACK_NAMES]);
  const defaultPort = secure ? 443 : 80;
  for (const candidate of names) {
    if (value === `${candidate}:${port}`) return true;
    if (port === defaultPort && value === candidate) return true;
  }
  return false;
}

function normaliseAddress(address: string | undefined): string {
  if (address === undefined) return "";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function hasBody(incoming: http.IncomingMessage): boolean {
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

const MISDIRECTED = "Misdirected request: this server answers only its own host name\n";

/** Serves `handler` on loopback until `close()`. */
export function listen(handler: Handler, options: ListenOptions = {}): Promise<Listening> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) {
    return Promise.reject(new Error("the test harness listens on loopback only"));
  }
  const name = options.name ?? host;
  if (!isLoopbackName(name)) {
    return Promise.reject(new Error("a harness server's name is localhost or under .localhost"));
  }
  const secure = options.tls !== undefined;
  let boundPort = 0;
  const onRequest = async (incoming: http.IncomingMessage, outgoing: http.ServerResponse) => {
    const method = incoming.method ?? "GET";
    if (
      !options.anyHost &&
      !hostMatches(incoming.headers.host, { name, port: boundPort, secure })
    ) {
      options.onMisdirected?.({ method });
      outgoing.writeHead(421, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      outgoing.end(method === "HEAD" ? undefined : MISDIRECTED);
      incoming.resume();
      return;
    }
    const request: HostRequest = {
      method,
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
    setResponseHeaders(response, (header, values) =>
      outgoing.setHeader(header, values.length === 1 ? (values[0] as string) : values),
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
  };
  const server =
    options.tls === undefined
      ? http.createServer(onRequest)
      : https.createServer({ cert: options.tls.cert, key: options.tls.key }, onRequest);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the server has no TCP address"));
        return;
      }
      boundPort = address.port;
      const scheme = secure ? "https" : "http";
      const shown = address.family === "IPv6" ? `[${address.address}]` : address.address;
      const shownName = name === "::1" ? "[::1]" : name;
      const authority = `${shownName}:${address.port}`;
      resolve({
        origin: `${scheme}://${authority}`,
        authority,
        loopbackOrigin: `${scheme}://${shown}:${address.port}`,
        port: address.port,
        certificate: options.tls?.cert,
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
  /**
   * Milliseconds to wait for the upstream's answer headers (default 30 s). Once they arrive the
   * body streams for as long as the upstream takes, as it does through the tunnel.
   */
  readonly timeoutMs?: number;
  /** For an https upstream: the certificate (PEM) to trust, such as a harness host's own. */
  readonly ca?: string;
}

const NO_BODY_STATUS = new Set([204, 205, 304]);

/**
 * Sends `request` to `upstream` (an http or https origin) on a fresh connection and answers with
 * the upstream's status, headers (each `Set-Cookie` kept apart) and streamed body. Rejects when the
 * upstream cannot be reached or sends no answer headers in time.
 */
export function forward(
  upstream: string,
  request: ForwardRequest,
  options: ForwardOptions = {},
): Promise<Response> {
  const url = new URL(upstream);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(new Error("the upstream must be http or https"));
  }
  const secure = url.protocol === "https:";
  const send = secure ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const onTimeout = () => outgoing.destroy(new Error("the upstream did not answer"));
    const outgoing = send(
      {
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
        method: request.method,
        path: request.target,
        headers: request.headers.flat(),
        setHost: false,
        agent: false,
        timeout: options.timeoutMs ?? 30_000,
        ...(secure && options.ca !== undefined ? { ca: options.ca } : {}),
      },
      (answer) => {
        // The wait was for the answer headers; the body may take as long as it takes.
        outgoing.off("timeout", onTimeout);
        outgoing.setTimeout(0);
        const headers = new Headers();
        for (const [header, value] of pairRawHeaders(answer.rawHeaders)) {
          headers.append(header, value);
        }
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
    outgoing.once("timeout", onTimeout);
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
