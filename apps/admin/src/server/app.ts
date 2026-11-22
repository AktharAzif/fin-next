// Fin Admin's hooks into the shared API host (packages/web-host): the staff realm's `/api/auth/*`
// behind its allowlist, and the app's JSON routes, registered from the route policy only.
import type { FinContext, FinEnv } from "@fin/server/http";
import { refuse } from "@fin/server/http";
import type { StaffDeps } from "@fin/staff";
import type { ApiServiceHooks } from "@fin/web-host";
import type { Hono } from "hono";
import { staffAuthHook } from "./auth-hook.ts";
import { ADMIN_POLICIES } from "./policy/index.ts";
import { adminHandlers } from "./routes/handlers.ts";
import { registerRoutes } from "./routes/register.ts";

export function adminRoutes(deps: StaffDeps, docsOrigin: string): (api: Hono<FinEnv>) => void {
  const handlers = adminHandlers(deps);
  const answer = (
    c: FinContext,
    status: number,
    code: string,
    extensions?: Readonly<Record<string, unknown>>,
  ) => refuse({ docsOrigin }, c, status, code, extensions);
  return (api) => registerRoutes(api, ADMIN_POLICIES, handlers, answer);
}

export function adminHooks(deps: StaffDeps, docsOrigin: string): ApiServiceHooks {
  return { auth: staffAuthHook(deps.realm), routes: adminRoutes(deps, docsOrigin) };
}
