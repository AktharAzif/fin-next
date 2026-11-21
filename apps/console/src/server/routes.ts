// The console's JSON routes, registered from the route policy alone (spec 02 §14.1). For each entry
// the runner checks the path's IDs (another shape is `404`), parses the query and the body with the
// entry's strict schemas (`400 invalid` with each field's path and code, never its value), runs the
// handler, and answers JSON with `Cache-Control: no-store` and any `Set-Cookie` the session's refresh
// or the handler produced. A refusal answers its own problem; anything else reaches the host's
// reported 500. Handlers run their guard and their action in one unit of work (`realm.run`).

import { isBuiltInKey } from "@fin/access";
import { isId as coreIsId, type IdPrefix } from "@fin/core";
import type { RequestContext } from "@fin/identity";
import { CATALOGUE, type Orgs } from "@fin/orgs";
import type { FinContext, FinEnv } from "@fin/server/http";
import type { Hono } from "hono";
import type * as z from "zod";
import { HANDLERS, type RouteAnswer } from "./handlers.ts";
import { CONSOLE_POLICY, type RoutePolicy } from "./policy/index.ts";
import { problem, refusalAnswer } from "./problems.ts";

export interface ConsoleDeps {
  orgs: Orgs;
  docsOrigin: string;
}

export interface RouteInput {
  c: FinContext;
  policy: RoutePolicy;
  request: Request;
  context: RequestContext;
  body: Record<string, unknown>;
  query: Record<string, unknown>;
  params: Record<string, string>;
  /** `Set-Cookie` values for the answer (the session's refresh, the handler's own). */
  cookies: string[];
}

const USER_AGENT_MAX = 400;

/** What the front door tells the realm about this request (spec 02 §3.5, §16.1, [BC-03]). */
export function requestContext(c: FinContext): RequestContext {
  const userAgent = c.req.header("user-agent");
  return {
    requestId: c.get("requestId"),
    // Trusted only because the ingress check passed: tunnel traffic from a connector peer.
    clientIp: c.get("ingress")?.clientIp ?? null,
    userAgent:
      userAgent === undefined || userAgent === ""
        ? null
        : Array.from(userAgent).slice(0, USER_AGENT_MAX).join(""),
    annotate: (fields) => {
      if (typeof fields.outcome === "string" && fields.outcome !== "ok") {
        c.set("outcome", fields.outcome === "error" ? "error" : "refused");
      }
      if (typeof fields.reason === "string") c.set("reason", fields.reason);
      if (typeof fields.userId === "string") c.set("actor", "session");
    },
  };
}

function fieldsOf(error: z.ZodError, base: string): { path: string; code: string }[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path: [base, ...issue.path.map(String)].filter((p) => p !== "").join("."),
    code: issue.code,
  }));
}

function invalid(c: FinContext, deps: ConsoleDeps, fields: { path: string; code: string }[]) {
  c.set("outcome", "refused");
  c.set("reason", "schema.invalid");
  return problem(c, deps.docsOrigin, 400, "invalid", { fields });
}

function pathIdOk(kind: string, value: string): boolean {
  if (kind === "role_key") return isBuiltInKey(CATALOGUE, value) || coreIsId(value, "rol");
  return coreIsId(value, kind as IdPrefix);
}

async function readBody(c: FinContext): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await c.req.text();
  if (text === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function answer(result: RouteAnswer, cookies: readonly string[]): Response {
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  for (const cookie of [...cookies, ...(result.setCookies ?? [])]) {
    headers.append("set-cookie", cookie);
  }
  return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
    status: result.status,
    headers,
  });
}

/** Registers every route of the policy on the API's Hono app (basePath /api). */
export function registerRoutes(api: Hono<FinEnv>, deps: ConsoleDeps): void {
  for (const policy of CONSOLE_POLICY) {
    const handler = HANDLERS[policy.id as keyof typeof HANDLERS];
    if (handler === undefined) throw new Error(`console: no handler for route ${policy.id}`);
    api.on(policy.method, policy.path, async (c) => {
      const params: Record<string, string> = {};
      for (const [name, kind] of Object.entries(policy.params ?? {})) {
        const value = c.req.param(name) ?? "";
        if (!pathIdOk(kind, value)) {
          c.set("outcome", "refused");
          c.set("reason", "path.not_found");
          return problem(c, deps.docsOrigin, 404, "not_found");
        }
        params[name] = value;
      }
      let query: Record<string, unknown> = {};
      const rawQuery = c.req.query();
      if (policy.query === "none") {
        if (Object.keys(rawQuery).length > 0) {
          return invalid(c, deps, [{ path: "query", code: "unrecognized_keys" }]);
        }
      } else {
        const parsed = policy.query.safeParse(rawQuery);
        if (!parsed.success) return invalid(c, deps, fieldsOf(parsed.error, "query"));
        query = parsed.data as Record<string, unknown>;
      }
      let body: Record<string, unknown> = {};
      const read =
        policy.method === "GET" ? { ok: true as const, value: undefined } : await readBody(c);
      if (!read.ok) return invalid(c, deps, [{ path: "body", code: "invalid_json" }]);
      if (policy.body === "none") {
        if (read.value !== undefined) {
          return invalid(c, deps, [{ path: "body", code: "unexpected_body" }]);
        }
      } else {
        const parsed = policy.body.safeParse(read.value ?? {});
        if (!parsed.success) return invalid(c, deps, fieldsOf(parsed.error, ""));
        body = parsed.data as Record<string, unknown>;
      }
      const input: RouteInput = {
        c,
        policy,
        request: c.req.raw,
        context: requestContext(c),
        body,
        query,
        params,
        cookies: [],
      };
      try {
        const result = await handler(input, deps);
        if (policy.guard !== "public") c.set("actor", "session");
        return answer(result, input.cookies);
      } catch (error) {
        const refused = refusalAnswer(c, deps.docsOrigin, error);
        if (refused !== null) return refused;
        throw error;
      }
    });
  }
}
