// The edge's request unit (spec 05 §10.1; spec 08 §7.2; T08-39): one `request` line per request,
// written when the answer is ready and shipped after it, even when the handler throws, with the
// edge's fields beyond the common set: actor, orgId, keyId, mode, keyReason (spec 05 §4.7), fromDocs,
// corsPreflight, finVersion, rateLimited and violatedPolicies. packages/server's requestUnit writes
// the common set only, so the edge keeps its own, with the same envelope, and the facts a layer
// learns are kept per request beside the context. Never in a line: a key, a secret, an address, a
// body or a query string.
import { type Clock, newId } from "@fin/core";
import type { Reporter } from "@fin/server";
import { type FinContext, type FinEnv, problemResponse, routeTemplate } from "@fin/server/http";
import type { Telemetry } from "@fin/server/telemetry";
import type { MiddlewareHandler } from "hono";

export interface EdgeFacts {
  keyReason?: string;
  keyId?: string;
  orgId?: string;
  mode?: "sandbox" | "live";
  fromDocs?: boolean;
  corsPreflight?: boolean;
  finVersion?: string;
  rateLimited?: boolean;
  violatedPolicies?: string[];
  dbQueries?: number;
  dbMs?: number;
}

const FACTS = new WeakMap<Request, EdgeFacts>();

/** The facts of this request, made on first use. */
export function factsOf(c: FinContext): EdgeFacts {
  let facts = FACTS.get(c.req.raw);
  if (facts === undefined) {
    facts = {};
    FACTS.set(c.req.raw, facts);
  }
  return facts;
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function statusClass(status: number): string {
  return `${Math.min(5, Math.max(1, Math.floor(status / 100)))}xx`;
}

/** Times one database statement into the request's facts. */
export async function timed<T>(c: FinContext, work: () => Promise<T>): Promise<T> {
  const facts = factsOf(c);
  const started = performance.now();
  try {
    return await work();
  } finally {
    facts.dbQueries = (facts.dbQueries ?? 0) + 1;
    facts.dbMs = Math.round(((facts.dbMs ?? 0) + performance.now() - started) * 100) / 100;
  }
}

export function edgeRequestUnit(options: {
  telemetry: Telemetry;
  reporter: Reporter;
  clock: Clock;
  docsOrigin: string;
}): MiddlewareHandler<FinEnv> {
  return async (c, next) => {
    const requestId = newId("req", options.clock);
    c.set("requestId", requestId);
    c.set("actor", "anonymous");
    const started = performance.now();
    await options.telemetry.withUnit({ requestId }, async () => {
      try {
        await next();
      } catch (error) {
        // Errors the app's onError did not take (none expected): a safe, reported 500.
        const errorId = options.reporter.reportError(error, { requestId, route: routeTemplate(c) });
        c.set("errorId", errorId);
        c.set("outcome", "error");
        c.set("reason", "internal");
        c.res = problemResponse(options.docsOrigin, requestId, { status: 500, code: "internal" });
      } finally {
        const status = c.res.status;
        let outcome = c.get("outcome");
        let reason = c.get("reason");
        if (outcome === undefined) {
          outcome = status >= 500 ? "error" : status >= 400 ? "refused" : "ok";
          if (status >= 400 && reason === undefined) reason = `http.${status}`;
        }
        const facts = factsOf(c);
        const length = Number(c.res.headers.get("content-length") ?? "0");
        const fields: Record<string, unknown> = {
          method: METHODS.has(c.req.method) ? c.req.method : "OTHER",
          route: routeTemplate(c),
          status,
          statusClass: statusClass(status),
          durationMs: Math.round((performance.now() - started) * 100) / 100,
          dbMs: facts.dbMs ?? 0,
          dbQueries: facts.dbQueries ?? 0,
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
        for (const [key, value] of Object.entries(facts)) {
          if (value !== undefined && key !== "dbMs" && key !== "dbQueries") fields[key] = value;
        }
        options.telemetry.log(
          "request",
          fields,
          status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        );
      }
    });
  };
}
