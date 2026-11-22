// CORS on the edge, for the docs origin only (spec 01 §4.5; spec 05 §3.8; R16), under /v4/ only:
//   - OPTIONS from exactly FIN_DOCS_ORIGIN asking for a listed method and listed headers: 204 with
//     Access-Control-Allow-Origin, -Methods, -Headers and Max-Age 7200; never forwarded, no key;
//   - OPTIONS from any other origin, or asking for anything else: 204 with no Access-Control-*
//     header (reason cors_refused);
//   - any other method with Origin equal to the docs origin: Access-Control-Allow-Origin added.
// Never Access-Control-Allow-Credentials, never `*`, never a reflected origin. Every /v4/ answer
// varies by Origin. The header list grows only by a reviewed change (L-SUN-01 adds fin-version and
// the expose list once SP-14 records what Scalar sends).
import type { FinEnv } from "@fin/server/http";
import type { MiddlewareHandler } from "hono";

export const CORS_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
export const CORS_HEADERS = ["authorization", "content-type", "idempotency-key"] as const;
export const CORS_MAX_AGE = "7200";

export function docsCors(docsOrigin: string): MiddlewareHandler<FinEnv> {
  const methods: readonly string[] = CORS_METHODS;
  const headers: readonly string[] = CORS_HEADERS;
  return async (c, next) => {
    if (!new URL(c.req.url).pathname.startsWith("/v4/")) return next();
    const origin = c.req.header("origin");
    if (c.req.method === "OPTIONS") {
      c.set("route", "/v4/*");
      const method = c.req.header("access-control-request-method");
      const requested = (c.req.header("access-control-request-headers") ?? "")
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name !== "");
      const allowed =
        origin === docsOrigin &&
        method !== undefined &&
        methods.includes(method) &&
        requested.every((name) => headers.includes(name));
      if (!allowed) {
        c.set("outcome", "refused");
        c.set("reason", "cors_refused");
        return c.body(null, 204, { vary: "Origin" });
      }
      return c.body(null, 204, {
        "access-control-allow-origin": docsOrigin,
        "access-control-allow-methods": methods.join(", "),
        "access-control-allow-headers": headers.join(", "),
        "access-control-max-age": CORS_MAX_AGE,
        vary: "Origin",
      });
    }
    await next();
    c.res.headers.append("vary", "Origin");
    if (origin === docsOrigin) c.res.headers.set("access-control-allow-origin", docsOrigin);
  };
}
