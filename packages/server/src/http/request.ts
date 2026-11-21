// The request unit (spec 08 §7.2; T08-39): one `request` line per HTTP request, written when the
// answer is ready and shipped after it, even when the handler throws. Unexpected errors answer a
// safe 500 problem carrying the request ID and are reported; refusals answer their own code.
import { type Clock, isFinError, newId } from "@fin/core";
import type { ErrorHandler, MiddlewareHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { matchedRoutes } from "hono/route";
import type { Reporter } from "../report.ts";
import { type Fields, type RequestFields, statusClass } from "../telemetry/lines.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { FinContext, FinEnv } from "./context.ts";
import { problemResponse } from "./problem.ts";

export interface RequestOptions {
  telemetry: Telemetry;
  reporter: Reporter;
  clock: Clock;
  docsOrigin: string;
}

/** The route template: the last matched handler's pattern, never the raw path. */
export function routeTemplate(c: FinContext): string {
  const set = c.get("route");
  if (set !== undefined) return set;
  const routes = matchedRoutes(c);
  for (let i = routes.length - 1; i >= 0; i--) {
    const route = routes[i];
    if (route !== undefined && route.method !== "ALL") return route.path;
  }
  return "unmatched";
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Runs the request as one unit and writes its `request` line. Outermost middleware. */
export function requestUnit(options: RequestOptions): MiddlewareHandler<FinEnv> {
  return async (c, next) => {
    const requestId = newId("req", options.clock);
    c.set("requestId", requestId);
    c.set("actor", "anonymous");
    const started = performance.now();
    await options.telemetry.withUnit({ requestId }, async () => {
      try {
        await next();
      } finally {
        const status = c.res.status;
        let outcome = c.get("outcome");
        let reason = c.get("reason");
        if (outcome === undefined) {
          outcome = status >= 500 ? "error" : status >= 400 ? "refused" : "ok";
          if (status >= 400 && reason === undefined) reason = `http.${status}`;
        }
        const length = Number(c.res.headers.get("content-length") ?? "0");
        const fields: RequestFields = {
          method: METHODS.has(c.req.method) ? c.req.method : "OTHER",
          route: routeTemplate(c),
          status,
          statusClass: statusClass(status),
          durationMs: Math.round((performance.now() - started) * 100) / 100,
          dbMs: 0,
          dbQueries: 0,
          providerMs: 0,
          providerCalls: 0,
          bytesOut: Number.isFinite(length) ? length : 0,
          cfRay: c.get("ingress")?.cfRay ?? null,
          actor: c.get("actor"),
          outcome,
        };
        if (reason !== undefined) fields.reason = reason;
        const errorId = c.get("errorId");
        if (errorId !== undefined) fields.errorId = errorId;
        options.telemetry.log(
          "request",
          fields as unknown as Fields,
          status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        );
      }
    });
  };
}

/** Answers a problem for this request. */
export function refuse(
  options: Pick<RequestOptions, "docsOrigin">,
  c: FinContext,
  status: number,
  code: string,
  extensions?: Readonly<Record<string, unknown>>,
  headers?: Readonly<Record<string, string>>,
): Response {
  const input = extensions === undefined ? { status, code } : { status, code, extensions };
  return problemResponse(options.docsOrigin, c.get("requestId") ?? "req_unknown", input, headers);
}

const HTTP_CODES: Readonly<Record<number, string>> = {
  400: "invalid",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  413: "payload_too_large",
  421: "misdirected",
  503: "unavailable",
};

/** app.onError: a FinError refusal answers its code; anything else is a reported, safe 500. */
export function errorHandler(options: RequestOptions): ErrorHandler<FinEnv> {
  return (error, c) => {
    if (isFinError(error) && error.status < 500) {
      c.set("outcome", "refused");
      c.set("reason", error.code);
      return refuse(
        options,
        c,
        error.status,
        error.code.split(".")[0] ?? "invalid",
        error.extensions,
      );
    }
    if (error instanceof HTTPException && error.status < 500) {
      const code = HTTP_CODES[error.status] ?? "invalid";
      c.set("outcome", "refused");
      c.set("reason", `http.${error.status}`);
      return refuse(options, c, error.status, code);
    }
    const errorId = options.reporter.reportError(error, {
      requestId: c.get("requestId"),
      route: routeTemplate(c),
    });
    c.set("errorId", errorId);
    c.set("outcome", "error");
    c.set("reason", "internal");
    return refuse(options, c, 500, "internal");
  };
}

export function notFoundHandler(options: RequestOptions): NotFoundHandler<FinEnv> {
  return (c) => {
    c.set("outcome", "refused");
    c.set("reason", "not_found");
    return refuse(options, c, 404, "not_found");
  };
}
