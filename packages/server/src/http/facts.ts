// What the socket says about a request, read from Node's IncomingMessage (the Hono binding). The
// raw request target is what the connector forwarded, before any URL parsing normalised it.
import { normaliseAddress } from "../ingress/peers.ts";
import type { FinContext } from "./context.ts";

/** The TCP peer's address, normalised, or undefined outside a Node server (unit tests). */
export function peerAddress(c: FinContext): string | undefined {
  const address = c.env?.incoming?.socket?.remoteAddress;
  return typeof address === "string" ? normaliseAddress(address) : undefined;
}

/** The raw request target as received (`incoming.url`), or the URL's path and query. */
export function rawTarget(c: FinContext): string {
  const raw = c.env?.incoming?.url;
  if (typeof raw === "string") return raw;
  const url = new URL(c.req.url);
  return `${url.pathname}${url.search}`;
}

/** The request target rule of ARCHITECTURE §5.5: exactly one leading `/`, and no `\`. */
export function isSafeTarget(target: string): boolean {
  return target.startsWith("/") && !target.startsWith("//") && !target.includes("\\");
}

/**
 * Joins the configured origin with the raw target as a string (never `new URL(path, origin)`, which
 * `//evil.example/` would redirect), then asserts the result's origin.
 */
export function publicUrl(origin: string, target: string): string | undefined {
  if (!isSafeTarget(target)) return undefined;
  const joined = `${origin}${target}`;
  try {
    return new URL(joined).origin === origin ? joined : undefined;
  } catch {
    return undefined;
  }
}

/** Removes request headers before any handler can read them. */
export function dropRequestHeaders(c: FinContext, names: readonly string[]): void {
  const present = names.filter((name) => c.req.raw.headers.has(name));
  if (present.length === 0) return;
  const headers = new Headers(c.req.raw.headers);
  for (const name of present) headers.delete(name);
  const raw = c.req.raw;
  const init: RequestInit & { duplex?: "half" } = {
    method: raw.method,
    headers,
    signal: raw.signal,
    redirect: raw.redirect,
  };
  if (raw.method !== "GET" && raw.method !== "HEAD" && raw.body !== null) {
    init.body = raw.body;
    init.duplex = "half";
  }
  c.req.raw = new Request(raw.url, init);
}
