// The static host (spec 01 §4.7; ARCHITECTURE FW-C17): one app host as the zone serves it, for
// Playwright journeys and local runs. It answers in this order, as S-01 recorded for the zone:
//
//   1. a target that is not origin-form: 400;
//   2. with Access in front (Fin Admin): `/cdn-cgi/access/authorized` takes the token and sets
//      `CF_Authorization`; a request without a valid token is sent to the stand-in's login;
//   3. any path ending `.map`: 404, the zone's refusal (the deployment would answer the SPA);
//   4. `/api/*` (after the zone's normalisation), when the app has an API half: the tunnel, which
//      forwards the raw target to the app's test server with the configured `Host`, the host's
//      test ingress proof and the headers Cloudflare sets, and answers 404 when its own `^/api/`
//      rule does not match the raw path;
//   5. everything else: the assets-only deployment. GET and HEAD only (405 otherwise); auto
//      trailing slash; unknown paths answer index.html with 200; the rendered `_headers` applied;
//      and, for an HTML answer under `/assets/`, the zone's added `Cache-Control: no-store`.
//
// Each request writes one `request` line (the route as a kind, never the raw path) to `log`.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccessGate, AccessIdentity } from "../access/stand-in.ts";
import { isLocalPath } from "../access/stand-in.ts";
import {
  type ForwardOptions,
  type ForwardRequest,
  forward,
  type HostRequest,
  headerValue,
  type RawHeaders,
} from "../http/node.ts";
import { fallbackAsset, type Manifest, readManifest, resolveAsset } from "./assets.ts";
import {
  applyHeaderRules,
  compileHeaders,
  type HeadersMatcher,
  parseHeadersStrict,
} from "./headers.ts";
import {
  decodeAssetPath,
  encodeAssetPath,
  isApiRoute,
  isSourceMapPath,
  normaliseEdgePath,
  splitTarget,
  tunnelMatches,
} from "./paths.ts";

export type Route =
  | "asset"
  | "spa-fallback"
  | "redirect"
  | "method-not-allowed"
  | "not-found"
  | "map-refused"
  | "api"
  | "tunnel-no-match"
  | "upstream-failed"
  | "access-login"
  | "access-authorized"
  | "bad-target"
  | "misdirected";

export interface RequestLine {
  readonly dt: string;
  readonly message: "request";
  readonly event: "request";
  readonly level: "info" | "warn" | "error";
  readonly service: "static-host";
  readonly app: string;
  readonly method: string;
  readonly route: Route;
  readonly status: number;
  readonly durationMs: number;
}

export interface ApiUpstream {
  /** The app's test server, an http origin on loopback. */
  readonly origin: string;
  /** The `Host` the tunnel's `httpHostHeader` sets; defaults to the host the browser used. */
  readonly host?: string;
  /** The host's test ingress proof, sent as `Fin-Ingress-Proof`; built at run time. */
  readonly ingressProof: string;
}

export interface StaticHostOptions {
  /** The app's role (console, admin, verify, selfie, docs), for log lines. */
  readonly app: string;
  /** The built output, e.g. apps/console/dist/static. */
  readonly root: string;
  /**
   * The rendered `_headers` text. Undefined reads `<root>/_headers` when it exists; null serves
   * with no custom headers (a test of the host itself, never a journey).
   */
  readonly headers?: string | null;
  /** Files served as if the deploy had rendered them into the artefact, e.g. `/env.json`. */
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  /** The app's API half. Omitted for a host with no `/api/` route (the docs site). */
  readonly api?: ApiUpstream;
  /** Cloudflare Access in front of every path (Fin Admin). */
  readonly access?: AccessGate;
  /** `CF-IPCountry` for forwarded requests (default "XX", Cloudflare's unknown). */
  readonly country?: string;
  readonly forwardOptions?: ForwardOptions;
  readonly log?: (line: RequestLine) => void;
  /** Milliseconds since the epoch, for log lines; read per request. */
  readonly now?: () => number;
}

export interface StaticHost {
  /** Answers one request. `origin` is the browser-facing origin, e.g. https://console.localhost:4101. */
  handle(request: HostRequest, origin: string): Promise<Response>;
  readonly manifest: Manifest;
}

/** One `request` line, the route as a kind and never the path. */
export function requestLine(
  app: string,
  method: string,
  route: Route,
  status: number,
  startedMs: number,
  endedMs: number,
): RequestLine {
  return {
    dt: new Date(startedMs).toISOString(),
    message: "request",
    event: "request",
    level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
    service: "static-host",
    app,
    method,
    route,
    status,
    durationMs: Math.max(0, endedMs - startedMs),
  };
}

/**
 * Headers Cloudflare and Access set on a request they forward. A client's own are replaced, except
 * `X-Forwarded-For`, which Cloudflare keeps and appends the connecting address to.
 */
const EDGE_SET = new Set([
  "host",
  "fin-ingress-proof",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-visitor",
  "cf-ray",
  "x-forwarded-for",
  "x-forwarded-proto",
  "cdn-loop",
]);
const ACCESS_SET = new Set(["cf-access-jwt-assertion", "cf-access-authenticated-user-email"]);
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const DEFAULT_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const ACCESS_COOKIE = "CF_Authorization";

function readCookie(headers: RawHeaders, name: string): string | undefined {
  for (const [key, value] of headers) {
    if (key.toLowerCase() !== "cookie") continue;
    for (const part of value.split(";")) {
      const eq = part.indexOf("=");
      if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

function connectionTokens(headers: RawHeaders): Set<string> {
  const tokens = new Set<string>();
  for (const [key, value] of headers) {
    if (key.toLowerCase() !== "connection") continue;
    for (const token of value.split(",")) tokens.add(token.trim().toLowerCase());
  }
  return tokens;
}

/** The upstream's answer without its connection-level headers, as an edge passes it on. */
function withoutHopByHop(upstream: Response): Response {
  const dropped = new Set(
    (upstream.headers.get("connection") ?? "").split(",").map((t) => t.trim().toLowerCase()),
  );
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!HOP_BY_HOP.has(name) && !dropped.has(name)) headers.append(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

function loadHeaders(options: StaticHostOptions): HeadersMatcher {
  let source = options.headers;
  if (source === undefined) {
    try {
      source = readFileSync(join(options.root, "_headers"), "utf8");
    } catch {
      throw new Error(
        "no rendered _headers: pass `headers` (the deploy renders it; builds write none) or null",
      );
    }
  }
  return compileHeaders(source === null ? [] : parseHeadersStrict(source));
}

/** Builds a static host over a built app. Reads the files and the headers once, here. */
export function createStaticHost(options: StaticHostOptions): StaticHost {
  const manifest = readManifest(options.root, options.files);
  const matcher = loadHeaders(options);
  const now = options.now ?? Date.now;
  const country = options.country ?? "XX";

  function serveStatic(request: HostRequest, path: string, query: string, hostname: string) {
    const decoded = decodeAssetPath(path);
    const intent =
      decoded === undefined ? fallbackAsset(manifest) : resolveAsset(manifest, decoded);
    if (intent.kind === "none")
      return { route: "not-found" as const, response: text(404, "Not found\n") };
    if (request.method !== "GET" && request.method !== "HEAD") {
      return { route: "method-not-allowed" as const, response: text(405, "Method not allowed\n") };
    }
    const headers = new Headers();
    let status = 200;
    let body: Uint8Array | null = null;
    let route: Route;
    if (intent.kind === "redirect") {
      status = 307;
      headers.set("location", `${encodeAssetPath(intent.location)}${query}`);
      route = "redirect";
    } else {
      const { asset } = intent;
      headers.set("content-type", asset.contentType);
      headers.set("etag", asset.etag);
      headers.set("cache-control", DEFAULT_CACHE_CONTROL);
      const inm = headerValue(request.headers, "if-none-match");
      const tags = (inm ?? "").split(",").map((tag) => tag.trim().replace(/^W\//, ""));
      if (inm !== undefined && (tags.includes(asset.etag) || tags.includes("*"))) {
        status = 304;
      } else {
        headers.set("content-length", String(asset.body.byteLength));
        body = asset.body;
      }
      route = intent.fallback ? "spa-fallback" : "asset";
    }
    applyHeaderRules(headers, matcher.match(hostname, path));
    const isHtml = (headers.get("content-type") ?? "").startsWith("text/html");
    if (path.startsWith("/assets/") && isHtml) headers.append("cache-control", "no-store");
    const payload = request.method === "HEAD" || body === null ? null : body.slice();
    return { route, response: new Response(payload, { status, headers }) };
  }

  async function serveApi(
    request: HostRequest,
    api: ApiUpstream,
    rawPath: string,
    browserHost: string,
    identity: AccessIdentity | undefined,
  ): Promise<{ route: Route; response: Response }> {
    if (!tunnelMatches(rawPath)) return { route: "tunnel-no-match", response: text(404, "") };
    const dropped = connectionTokens(request.headers);
    const headers: Array<readonly [string, string]> = [["Host", api.host ?? browserHost]];
    for (const [name, value] of request.headers) {
      const lower = name.toLowerCase();
      if (EDGE_SET.has(lower) || HOP_BY_HOP.has(lower) || dropped.has(lower)) continue;
      if (options.access !== undefined && ACCESS_SET.has(lower)) continue;
      headers.push([name, value]);
    }
    const peer = request.remoteAddress;
    // Cloudflare keeps a client's X-Forwarded-For and appends the address that connected, so a
    // forged first element reaches the API half; only CF-Connecting-IP names the client.
    const sentForwardedFor = request.headers
      .filter(([name]) => name.toLowerCase() === "x-forwarded-for")
      .map(([, value]) => value.trim())
      .filter((value) => value !== "");
    headers.push(
      ["CF-Connecting-IP", peer],
      ["CF-IPCountry", country],
      ["CF-Visitor", '{"scheme":"https"}'],
      ["CF-Ray", `${randomBytes(8).toString("hex")}-TST`],
      ["X-Forwarded-For", [...sentForwardedFor, peer].join(",")],
      ["X-Forwarded-Proto", "https"],
      ["CDN-Loop", "cloudflare"],
      ["Fin-Ingress-Proof", api.ingressProof],
    );
    if (identity !== undefined) {
      headers.push(
        ["Cf-Access-Jwt-Assertion", identity.token],
        ["Cf-Access-Authenticated-User-Email", identity.email],
      );
    }
    const body = request.body;
    const forwarded: ForwardRequest = {
      method: request.method,
      target: request.target,
      headers,
      body,
    };
    try {
      return {
        route: "api",
        response: withoutHopByHop(await forward(api.origin, forwarded, options.forwardOptions)),
      };
    } catch {
      await body?.cancel().catch(() => undefined);
      return {
        route: "upstream-failed",
        response: text(502, "Bad gateway: the app's test server did not answer\n"),
      };
    }
  }

  function accessAuthorized(query: string, secure: boolean, gate: AccessGate): Response {
    const params = new URLSearchParams(query);
    const token = params.get("token") ?? "";
    const redirect = params.get("redirect_url") ?? "/";
    if (gate.verify(token) === undefined) return text(403, "Access: the token is not valid\n");
    const cookie = `${ACCESS_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
    return new Response(null, {
      status: 302,
      headers: { location: isLocalPath(redirect) ? redirect : "/", "set-cookie": cookie },
    });
  }

  async function route(
    request: HostRequest,
    origin: string,
  ): Promise<{ route: Route; response: Response }> {
    if (!request.target.startsWith("/")) {
      return { route: "bad-target", response: text(400, "Bad request\n") };
    }
    const { path: rawPath, query } = splitTarget(request.target);
    const path = normaliseEdgePath(rawPath);
    const originUrl = new URL(origin);
    let identity: AccessIdentity | undefined;
    if (options.access !== undefined) {
      if (path === "/cdn-cgi/access/authorized") {
        const response = accessAuthorized(query, originUrl.protocol === "https:", options.access);
        return { route: "access-authorized", response };
      }
      const token = readCookie(request.headers, ACCESS_COOKIE);
      identity = token === undefined ? undefined : options.access.verify(token);
      if (identity === undefined) {
        const login = options.access.loginUrl(origin, `${path}${query}`);
        return {
          route: "access-login",
          response: new Response(null, { status: 302, headers: { location: login } }),
        };
      }
    }
    if (isSourceMapPath(path)) return { route: "map-refused", response: text(404, "Not found\n") };
    if (options.api !== undefined && isApiRoute(path)) {
      return serveApi(request, options.api, rawPath, originUrl.host, identity);
    }
    return serveStatic(request, path, query, originUrl.hostname);
  }

  return {
    manifest,
    async handle(request, origin) {
      const started = now();
      const { route: kind, response } = await route(request, origin);
      options.log?.(
        requestLine(options.app, request.method, kind, response.status, started, now()),
      );
      return response;
    },
  };
}
