// The headers on every API answer (ARCHITECTURE §7.12; spec 01 §4.4; spec 02 §2.2): no-store,
// Fin-Release, nosniff, the API page policy, HSTS for the zone's class, the referrer and
// permissions policies of the host, COOP and CORP, X-Robots-Tag outside production and the
// Request-Id. An API half never sends a CORS header, so any that reached the answer are removed.
import type { MiddlewareHandler } from "hono";
import type { Environment, HostRole } from "../config/index.ts";
import type { FinEnv } from "./context.ts";

export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** HSTS by the zone's class (ARCHITECTURE §5.8; spec 01 §7.4). */
export function hstsFor(environment: Environment, role: HostRole | "private"): string {
  const preload =
    environment === "production" && (role === "admin" || role === "verify" || role === "selfie");
  return `max-age=63072000; includeSubDomains${preload ? "; preload" : ""}`;
}

const DENY_FEATURES = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
];

/** The console's and Fin Admin's policy: everything denied but passkeys on this origin. */
export const PERMISSIONS_APP = [
  ...DENY_FEATURES,
  "publickey-credentials-get=(self)",
  "publickey-credentials-create=(self)",
].join(", ");

/** Every other host's policy: every feature denied, passkeys included. */
export const PERMISSIONS_DENY_ALL = [
  ...DENY_FEATURES,
  "publickey-credentials-get=()",
  "publickey-credentials-create=()",
].join(", ");

export function referrerPolicyFor(role: HostRole | "private"): "same-origin" | "no-referrer" {
  return role === "console" || role === "admin" ? "same-origin" : "no-referrer";
}

export function permissionsPolicyFor(role: HostRole | "private"): string {
  return role === "console" || role === "admin" ? PERMISSIONS_APP : PERMISSIONS_DENY_ALL;
}

export interface ApiHeaderOptions {
  release: string;
  environment: Environment;
  /** The host role of the request when the ingress check knows it, else this fallback. */
  defaultRole: HostRole | "private";
  /** The edge answers the docs origin's CORS itself; nothing else may keep a CORS header. */
  keepCors?: boolean;
}

/** The answer's headers as a plain record, for a role. */
export function apiHeaderValues(
  options: ApiHeaderOptions,
  role: HostRole | "private",
  requestId: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "fin-release": options.release,
    "x-content-type-options": "nosniff",
    "content-security-policy": API_CSP,
    "strict-transport-security": hstsFor(options.environment, role),
    "referrer-policy": referrerPolicyFor(role),
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": permissionsPolicyFor(role),
  };
  if (options.environment !== "production") headers["x-robots-tag"] = "noindex, nofollow";
  if (requestId !== undefined) headers["request-id"] = requestId;
  return headers;
}

/** Sets the API headers on every answer, the front door's refusals included. */
export function apiHeaders(options: ApiHeaderOptions): MiddlewareHandler<FinEnv> {
  return async (c, next) => {
    await next();
    const role = c.get("ingress")?.role ?? options.defaultRole;
    const values = apiHeaderValues(options, role, c.get("requestId"));
    let headers = c.res.headers;
    try {
      for (const [name, value] of Object.entries(values)) headers.set(name, value);
    } catch {
      // An immutable answer (a forwarded fetch Response): copy it once, then set.
      c.res = new Response(c.res.body, c.res);
      headers = c.res.headers;
      for (const [name, value] of Object.entries(values)) headers.set(name, value);
    }
    headers.delete("x-powered-by");
    headers.delete("server");
    if (options.keepCors !== true) {
      for (const name of [...headers.keys()]) {
        if (name.toLowerCase().startsWith("access-control-")) headers.delete(name);
      }
    }
  };
}
