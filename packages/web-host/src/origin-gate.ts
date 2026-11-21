// The origin gate (spec 01 §4.4; spec 02 §2.3; ARCHITECTURE §7.12; FW-C09 under OD-4; [SA-44]).
// On every method but GET, HEAD and OPTIONS, before any handler and Better Auth's included, in this
// order:
//   1. `Origin` is present, not `null`, and equals the host's configured origin exactly
//      (origin_missing, origin_mismatch);
//   2. `Sec-Fetch-Site`, when present, is `same-origin` (fetch_site);
//   3. `X-Fin-App` equals the app's name (app_header);
//   4. a body is `application/json`, except a route the policy names as a `multipart/form-data`
//      upload; a body-less request carries no other content type (content_type).
// Each refusal is 403 with the problem `invalid_origin` and its `reason`, one `csrf.refused` line
// (`reason`, `route`), and the request line's `outcome: refused`, `reason: origin_gate.<code>`.
// The only exemption is `GET /api/auth/callback/google`, which as a GET is never gated; a POST to
// any `/api/auth/callback/*` is gated like every other unsafe request. No check reads an
// environment variable.
import type { FinContext, FinEnv } from "@fin/server/http";
import { routeTemplate } from "@fin/server/http";
import type { Telemetry } from "@fin/server/telemetry";
import type { MiddlewareHandler } from "hono";

export type GateCode =
  | "origin_missing"
  | "origin_mismatch"
  | "fetch_site"
  | "app_header"
  | "content_type";

export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export interface GateRequest {
  method: string;
  origin: string | undefined;
  secFetchSite: string | undefined;
  finApp: string | undefined;
  contentType: string | undefined;
  hasBody: boolean;
  /** The route accepts a `multipart/form-data` upload (named in its policy). */
  upload: boolean;
}

function mediaType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.split(";")[0]?.trim().toLowerCase();
}

/** The gate's decision for one request: the refusal code, or undefined to pass. */
export function gateDecision(
  request: GateRequest,
  expected: { origin: string; app: string },
): GateCode | undefined {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return undefined;
  if (request.origin === undefined || request.origin === "" || request.origin === "null") {
    return "origin_missing";
  }
  if (request.origin !== expected.origin) return "origin_mismatch";
  if (request.secFetchSite !== undefined && request.secFetchSite !== "same-origin") {
    return "fetch_site";
  }
  if (request.finApp !== expected.app) return "app_header";
  const type = mediaType(request.contentType);
  if (request.hasBody) {
    if (type === "application/json") return undefined;
    if (type === "multipart/form-data" && request.upload) return undefined;
    return "content_type";
  }
  if (type !== undefined && type !== "" && type !== "application/json") return "content_type";
  return undefined;
}

/** Whether a request carries a body: a positive Content-Length or any Transfer-Encoding. */
export function hasBody(c: FinContext): boolean {
  const length = c.req.header("content-length");
  if (c.req.header("transfer-encoding") !== undefined) return true;
  return length !== undefined && length.trim() !== "" && length.trim() !== "0";
}

export interface OriginGateOptions {
  /** The app's name, which X-Fin-App must carry: console, admin or verify. */
  app: string;
  /** The configured origin of the host the request arrived on. */
  originFor: (c: FinContext) => string | undefined;
  /** Route templates (`POST /api/x/:id/upload`) whose bodies may be multipart uploads. */
  uploads: ReadonlySet<string>;
  telemetry: Telemetry;
  refuse: (c: FinContext, code: GateCode) => Response;
}

export function originGate(options: OriginGateOptions): MiddlewareHandler<FinEnv> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const route = routeTemplate(c);
    const expected = options.originFor(c);
    const code =
      expected === undefined
        ? "origin_mismatch"
        : gateDecision(
            {
              method: c.req.method,
              origin: c.req.header("origin"),
              secFetchSite: c.req.header("sec-fetch-site"),
              finApp: c.req.header("x-fin-app"),
              contentType: c.req.header("content-type"),
              hasBody: hasBody(c),
              upload: options.uploads.has(`${c.req.method} ${route}`),
            },
            { origin: expected, app: options.app },
          );
    if (code === undefined) return next();
    options.telemetry.log("csrf.refused", { reason: code, route }, "warn");
    c.set("outcome", "refused");
    c.set("reason", `origin_gate.${code}`);
    return options.refuse(c, code);
  };
}
