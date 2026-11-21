// Registers Fin Admin's routes from the route policy, and only from it (spec 02 §14.1): for each
// entry, the path parameters, the query and the JSON body are checked against the entry's schemas
// before the handler runs (a malformed ID in a path is a 404, a refused field a 400 naming the
// field and the problem, never the value), the front door's facts become the realm's request
// context (the request ID, the tunnel's client address, the user agent and the Access identity the
// host verified), and a refusal is answered as a problem document with the request line's outcome
// and bounded reason. The origin gate, the body limit and the Access check ran before (§2.2).
import { AuthRefusal, type RequestContext } from "@fin/identity";
import type { FinContext, FinEnv } from "@fin/server/http";
import { StaffRefusal } from "@fin/staff";
import type { Hono } from "hono";
import type { AdminPolicy, PolicyId } from "../policy/index.ts";

export interface RouteInput {
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
}

export interface HandlerArgs {
  c: FinContext;
  context: RequestContext;
  input: RouteInput;
}

export type RouteAnswer =
  | { status: 200 | 201; body: unknown }
  /** A refusal answered after the unit committed (a counted wrong enrolment code). */
  | { refusal: StaffRefusal };

export type RouteHandler = (args: HandlerArgs) => Promise<RouteAnswer>;

export type Refuse = (
  c: FinContext,
  status: number,
  code: string,
  extensions?: Readonly<Record<string, unknown>>,
) => Response;

function fieldsOf(issues: readonly { path: readonly PropertyKey[]; code: string }[]) {
  return issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
  }));
}

/** The front door's facts as the realm's request context. */
export function requestContextOf(c: FinContext): RequestContext {
  const userAgent = c.req.header("user-agent");
  return {
    requestId: c.get("requestId"),
    clientIp: c.get("ingress")?.clientIp ?? null,
    userAgent: userAgent === undefined ? null : userAgent.slice(0, 400),
    access: c.get("access") ?? null,
  };
}

function answerRefusal(c: FinContext, refuse: Refuse, error: AuthRefusal | StaffRefusal): Response {
  c.set("outcome", "refused");
  c.set("reason", error.lineReason);
  return refuse(c, error.status, error.code, error.extensions);
}

async function readBody(c: FinContext): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await c.req.text();
  if (text === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function registerRoutes(
  api: Hono<FinEnv>,
  policies: readonly AdminPolicy[],
  handlers: Readonly<Record<PolicyId, RouteHandler>>,
  refuse: Refuse,
): void {
  for (const policy of policies) {
    const handler = handlers[policy.id];
    if (handler === undefined) throw new Error(`no handler for the route ${policy.id}`);
    api.on(policy.method, policy.path.slice("/api".length), async (c) => {
      c.set("route", policy.path);
      const params = policy.params.safeParse(c.req.param());
      if (!params.success) {
        c.set("outcome", "refused");
        c.set("reason", "route.params");
        return refuse(c, 404, "not_found");
      }
      let query: Record<string, unknown> = {};
      if (policy.query !== null) {
        const parsed = policy.query.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
        if (!parsed.success) {
          c.set("outcome", "refused");
          c.set("reason", "route.query");
          return refuse(c, 400, "invalid", { fields: fieldsOf(parsed.error.issues) });
        }
        query = parsed.data as Record<string, unknown>;
      }
      let body: Record<string, unknown> = {};
      if (policy.body !== null) {
        const raw = await readBody(c);
        const parsed = raw.ok ? policy.body.safeParse(raw.value) : null;
        if (parsed === null || !parsed.success) {
          c.set("outcome", "refused");
          c.set("reason", "route.body");
          return refuse(c, 400, "invalid", {
            fields:
              parsed === null
                ? [{ path: "", code: "invalid_json" }]
                : fieldsOf(parsed.error.issues),
          });
        }
        body = parsed.data as Record<string, unknown>;
      }
      const context = requestContextOf(c);
      let answer: RouteAnswer;
      try {
        answer = await handler({
          c,
          context,
          input: { params: params.data as Record<string, unknown>, query, body },
        });
      } catch (error) {
        if (error instanceof AuthRefusal || error instanceof StaffRefusal) {
          return answerRefusal(c, refuse, error);
        }
        throw error;
      }
      if ("refusal" in answer) return answerRefusal(c, refuse, answer.refusal);
      c.set("actor", "staff");
      c.set("outcome", "ok");
      return c.json(answer.body as object, answer.status);
    });
  }
}
