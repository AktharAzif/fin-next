// What the socket says about a request, read from Node's IncomingMessage (the Hono binding). The
// raw request target is what the connector forwarded, before any URL parsing normalised it.
import type { IncomingMessage } from "node:http";
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

/** A dot segment: `/./` or `/../`, or one at the end of the path. */
const DOT_SEGMENT = /\/\.{1,2}(?:\/|$)/;
/**
 * A percent-encoded character no canonical path encodes: an unreserved one (RFC 3986 §2.3: a letter,
 * a digit, `-`, `.`, `_`, `~`), `/`, `\` or a control character. Each makes the decoded path, which
 * cloudflared matches and the router routes, differ from the raw one checked here.
 */
const ENCODED_ALIAS =
  /%(?:[01][0-9A-Fa-f]|3[0-9]|[46][1-9A-Fa-f]|[57][0-9Aa]|2[DdEeFf]|5[CcFf]|7[EeFf])/;

/**
 * The request target rule of ARCHITECTURE §5.5, made canonical so a path has one meaning: exactly
 * one leading `/`, no `\` or `#`, and in the path no dot segment and no percent-encoding of a
 * character that has a plain form. `/%61pi/x`, `/api%2Fx` and `/x/../api/x` are refused (400)
 * rather than answered as `/api/x`. Every front door checks this first, on the raw target.
 */
export function isSafeTarget(target: string): boolean {
  if (!target.startsWith("/") || target.startsWith("//")) return false;
  if (target.includes("\\") || target.includes("#")) return false;
  const query = target.indexOf("?");
  const path = query === -1 ? target : target.slice(0, query);
  return !DOT_SEGMENT.test(path) && !ENCODED_ALIAS.test(path);
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

/** Removes headers from Node's own message: its header object, its distinct headers, its raw list. */
function dropIncomingHeaders(
  incoming: Partial<IncomingMessage> | undefined,
  names: ReadonlySet<string>,
): void {
  if (incoming === undefined || incoming === null) return;
  // Node builds `headers` and `headersDistinct` on first read from `rawHeaders` and the count it
  // parsed, so both are read (built) before the raw list shrinks, then edited in place.
  for (const bag of [incoming.headers, incoming.headersDistinct] as unknown[]) {
    if (typeof bag !== "object" || bag === null) continue;
    for (const name of names) delete (bag as Record<string, unknown>)[name];
  }
  const raw = incoming.rawHeaders;
  if (Array.isArray(raw)) {
    const kept: string[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = raw[i];
      const value = raw[i + 1];
      if (typeof name !== "string" || typeof value !== "string") continue;
      if (!names.has(name.toLowerCase())) kept.push(name, value);
    }
    raw.splice(0, raw.length, ...kept);
  }
}

/**
 * Removes request headers before any handler can read them: from the Request handlers see and from
 * Node's IncomingMessage behind it (`c.env.incoming`). With `url`, the Request handlers see is
 * rebuilt on that URL (the configured public origin and the raw target).
 */
export function dropRequestHeaders(c: FinContext, names: readonly string[], url?: string): void {
  const raw = c.req.raw;
  const present = names.filter((name) => raw.headers.has(name));
  if (present.length > 0 || (url !== undefined && url !== raw.url)) {
    const headers = new Headers(raw.headers);
    for (const name of present) headers.delete(name);
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
    c.req.raw = new Request(url ?? raw.url, init);
  }
  // After the Request is rebuilt: the adapter's own Request reads Node's headers lazily.
  dropIncomingHeaders(c.env?.incoming, new Set(names.map((name) => name.toLowerCase())));
}
