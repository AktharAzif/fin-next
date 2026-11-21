// The request unit (spec 08 §7.2; T08-39): one `request` line per HTTP request, written when the
// answer is ready and shipped after it, even when the handler throws. Unexpected errors answer a
// safe 500 problem carrying the request ID and are reported; refusals answer their own code.
import { type Clock, isFinError, newId } from "@fin/core";
import type { ErrorHandler, MiddlewareHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { matchedRoutes } from "hono/route";
import { METHOD_NAME_ALL } from "hono/router";
import type { RouterRoute } from "hono/types";
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

/**
 * The route template the router's matches name for this request, never the raw path. Hono runs the
 * matches in registration order, and the first route among them answers: so the template is the
 * first match registered with a method (`get`, `post`, `on`), or that `answers` says answers
 * requests itself although it was registered without one. An entry registered without a method
 * (`use`, `all`) is taken for middleware in front of a route, and names the request only when no
 * route matches; an entry registered on every path (`*`, `/*`) never does. Where a static route and
 * a parameter route overlap, the later of the two never runs, so it is never the template.
 */
export function matchedTemplate(
  c: FinContext,
  answers: (route: RouterRoute) => boolean = () => false,
): string {
  let middleware: string | undefined;
  for (const route of matchedRoutes(c)) {
    if (route.path === "*" || route.path === "/*") continue;
    if (route.method !== METHOD_NAME_ALL || answers(route)) return route.path;
    middleware ??= route.path;
  }
  return middleware ?? "unmatched";
}

/** The route template: the pattern a layer recorded for this request, or else the matches'. */
export function routeTemplate(c: FinContext): string {
  return c.get("route") ?? matchedTemplate(c);
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
