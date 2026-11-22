// deliveryFetch (ARCHITECTURE §7.11; [SA-40]): the only way to call a URL a person supplied.
// https only, ports 443 and 8443 only; names refused before resolution when they are IP literals,
// `localhost`, `*.local`, `*.internal` or one of Fin's own zones; every resolved address checked and
// the connection refused if ANY is refused; the checked address is the one connected to (the
// resolved address is handed to the socket through `lookup`, so there is no second lookup);
// redirects never followed; connect 5 s, total 15 s; at most 1 KB of the answer kept; IPv4 only.
//
// It is built on node:https rather than an undici dispatcher: undici is not a dependency, and a
// guard on undici's `dispatcher` is void on Bun (bun#38840), so this one holds on both.

import { request as httpsRequest, type RequestOptions } from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import { FinError } from "@fin/core";
import { type ResolveAll, systemResolveAll } from "../dns/railway-lookup.ts";
import { refusedAddress } from "./addresses.ts";

export const ALLOWED_PORTS: ReadonlySet<number> = new Set([443, 8443]);
export const CONNECT_TIMEOUT_MS = 5000;
export const TOTAL_TIMEOUT_MS = 15_000;
export const MAX_ANSWER_BYTES = 1024;

export type RefusalReason =
  | "url_invalid"
  | "scheme"
  | "port"
  | "credentials"
  | "ip_literal"
  | "local_name"
  | "own_zone"
  | "resolve_failed"
  | "refused_address"
  | "no_ipv4";

export class DeliveryRefused extends FinError {
  readonly reason: RefusalReason;
  readonly detailCode: string | undefined;

  constructor(reason: RefusalReason, detailCode?: string) {
    super(`delivery.${reason}`, "The delivery URL is refused", { status: 400 });
    this.name = "DeliveryRefused";
    this.reason = reason;
    this.detailCode = detailCode;
  }
}

export class DeliveryFailed extends FinError {
  constructor(code: "timeout" | "network" | "tls") {
    super(`delivery.${code}`, "The delivery could not be completed", { status: 502 });
    this.name = "DeliveryFailed";
  }
}

export interface DeliveryRequest {
  method?: "POST" | "GET";
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
}

export interface DeliveryAnswer {
  status: number;
  /** At most 1 KB of the body, as text. */
  body: string;
  /** A redirect's `location` is reported, never followed. */
  location: string | undefined;
}

/** The transport, injectable so tests can see what would be connected to. */
export type HttpsRequest = typeof httpsRequest;

export interface DeliveryOptions {
  /** Fin's own zones: never a delivery target, subdomains included. */
  ownZones: readonly string[];
  resolve?: ResolveAll;
  request?: HttpsRequest;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
}

const LOCAL_NAME =
  /(?:^|\.)(?:localhost|local|internal|localdomain|home\.arpa|invalid|test|example)$/;

/** Checks a URL without connecting: what is refused before any DNS lookup. */
export function checkDeliveryUrl(raw: string, ownZones: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeliveryRefused("url_invalid");
  }
  if (url.protocol !== "https:") throw new DeliveryRefused("scheme");
  if (url.username !== "" || url.password !== "") throw new DeliveryRefused("credentials");
  const port = url.port === "" ? 443 : Number(url.port);
  if (!ALLOWED_PORTS.has(port)) throw new DeliveryRefused("port");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || isIP(host) !== 0 || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) {
    throw new DeliveryRefused("ip_literal");
  }
  if (!host.includes(".") || LOCAL_NAME.test(host)) throw new DeliveryRefused("local_name");
  for (const zone of ownZones) {
    const z = zone.toLowerCase().replace(/\.$/, "");
    if (host === z || host.endsWith(`.${z}`)) throw new DeliveryRefused("own_zone");
  }
  return url;
}

/**
 * Resolves `hostname` and picks the address to connect to: refused when any resolved address is
 * refused, or when there is no IPv4 address (IPv6 egress is off on Railway).
 */
export async function pickAddress(hostname: string, resolve: ResolveAll): Promise<string> {
  let answers: { address: string; family: 4 | 6 }[];
  try {
    answers = await resolve(hostname);
  } catch {
    throw new DeliveryRefused("resolve_failed");
  }
  if (answers.length === 0) throw new DeliveryRefused("resolve_failed");
  for (const answer of answers) {
    const refused = refusedAddress(answer.address);
    if (refused !== undefined) throw new DeliveryRefused("refused_address", refused);
  }
  const v4 = answers.find((a) => a.family === 4);
  if (v4 === undefined) throw new DeliveryRefused("no_ipv4");
  return v4.address;
}

/** Calls a person-supplied URL under every rule above. */
export async function deliveryFetch(
  raw: string,
  init: DeliveryRequest,
  options: DeliveryOptions,
): Promise<DeliveryAnswer> {
  const url = checkDeliveryUrl(raw, options.ownZones);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const address = await pickAddress(hostname, options.resolve ?? systemResolveAll);
  // The socket connects to exactly the address checked above: no second lookup.
  const lookup: LookupFunction = (_name, lookupOptions, callback) => {
    if (lookupOptions.all === true) {
      (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address, family: 4 },
      ]);
    } else {
      callback(null, address, 4);
    }
  };
  const send = options.request ?? httpsRequest;
  const connectMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const totalMs = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  const body =
    init.body === undefined
      ? undefined
      : typeof init.body === "string"
        ? Buffer.from(init.body)
        : Buffer.from(init.body);

  return new Promise<DeliveryAnswer>((resolve, reject) => {
    const requestOptions: RequestOptions = {
      method: init.method ?? "POST",
      host: hostname,
      servername: hostname,
      port: url.port === "" ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      headers: {
        ...init.headers,
        host: url.host,
        ...(body !== undefined ? { "content-length": String(body.length) } : {}),
      },
      lookup,
      family: 4,
      agent: false,
      signal: AbortSignal.timeout(totalMs),
      rejectUnauthorized: true,
    };
    let settled = false;
    const fail = (error: FinError): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = send(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        const location = res.headers.location;
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).subarray(0, MAX_ANSWER_BYTES).toString("utf8"),
          location: typeof location === "string" ? location : undefined,
        });
      };
      res.on("data", (chunk: Buffer) => {
        if (size < MAX_ANSWER_BYTES) chunks.push(chunk);
        size += chunk.length;
        if (size >= MAX_ANSWER_BYTES) {
          finish();
          res.destroy();
        }
      });
      res.on("end", finish);
      res.on("error", () => finish());
    });
    const connectTimer = setTimeout(() => {
      fail(new DeliveryFailed("timeout"));
      req.destroy();
    }, connectMs);
    connectTimer.unref();
    req.on("socket", (socket) => {
      socket.once("secureConnect", () => clearTimeout(connectTimer));
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(connectTimer);
      const code =
        error.name === "AbortError" || error.code === "ABORT_ERR"
          ? "timeout"
          : error.code?.startsWith("ERR_TLS") ||
              error.code === "CERT_HAS_EXPIRED" ||
              error.code === "DEPTH_ZERO_SELF_SIGNED_CERT"
            ? "tls"
            : "network";
      fail(new DeliveryFailed(code));
    });
    req.end(body);
  });
}
