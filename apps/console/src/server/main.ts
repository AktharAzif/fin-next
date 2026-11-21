// The console's API half (spec 01 §4.4; spec 02 §2.2, §14.2): it answers only console.<zone>/api/*
// and its private health, behind the shared front door of @fin/web-host. It runs the developer realm
// (`/api/auth/*` through the realm's exact allowlist, §4.2) and Fin's own routes, registered from
// the route policy (policy/), each with its guard, permission, step-up, schemas, limits and audit.
//
// Everything is built inside main() through `build(ctx)`, never at module scope: the realm's
// settings and secrets, the database pool (one unit of work per request), the realm, this area's
// services, and the API host. The host is assembled here rather than by web-host's
// `buildApiService`, whose connector-peer options on the integration commit predate the server
// core's (`resolver`); the gap is recorded for P0-D.
import type { Clock } from "@fin/core";
import { createPgDatabase, createRealm, type LineSink, type Realm } from "@fin/identity";
import { KEYS_ACTIONS } from "@fin/keys";
import { CredentialRegistry, createOrgs, ORGS_ACTIONS, type Orgs } from "@fin/orgs";
import type { BuiltService, ServiceContext, ServiceDefinition } from "@fin/server";
import { loadDocsOrigin, loadIngressConfig } from "@fin/server/config";
import type { FinContext } from "@fin/server/http";
import { ConnectorPeers } from "@fin/server/ingress";
import type { Telemetry } from "@fin/server/telemetry";
import { type AuthHook, createApiHost } from "@fin/web-host";
import type { Pool } from "pg";
import { apiKeyCredentials, keysOf } from "./keys.ts";
import { registerRoutes, requestContext } from "./routes.ts";
import { createConsolePool, poolSettings, realmSettings } from "./settings.ts";

export interface ConsoleOverrides {
  /** A pool made by the caller (the integration tests' own login). */
  pool?: Pool;
  /** The credential sources (API keys with stretch 1, webhook secrets on Sunday). */
  credentials?: CredentialRegistry;
}

/** The realm's lines go out as the process's own structured lines, scrubbed by telemetry. */
export function lineSink(telemetry: Telemetry): LineSink {
  return {
    write: (event, level, fields) => {
      const clean: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields))
        if (value !== undefined) clean[key] = value;
      telemetry.log(event, clean, level);
    },
  };
}

/** The realm's clock (a Date) over the process's injected one (milliseconds). */
export function dateClock(clock: Clock): { now(): Date } {
  return { now: () => new Date(clock.now()) };
}

/**
 * The developer realm's `/api/auth/*` (spec 02 §4.2): the exact allowlist decides before anything
 * else runs, on the raw path as received; only an allowed path reaches the library, with the URL
 * rebuilt from the configured origin.
 */
export function authHook(realm: Realm): AuthHook {
  return {
    realm: "developer",
    classify(method, rawPath) {
      const rule = realm.policy.match(rawPath, method);
      if (rule === null) return "unlisted";
      return rule.class === "blocked" ? "blocked" : "allow";
    },
    async handle(c: FinContext) {
      const publicUrl = c.get("ingress")?.publicUrl ?? c.req.url;
      const method = c.req.method;
      const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();
      const request = new Request(publicUrl, {
        method,
        headers: c.req.raw.headers,
        ...(body === undefined || body.byteLength === 0 ? {} : { body }),
      });
      return realm.handler(request, requestContext(c));
    },
  };
}

export interface ConsoleRuntime {
  realm: Realm;
  orgs: Orgs;
}

export async function buildConsole(
  ctx: ServiceContext,
  overrides: ConsoleOverrides = {},
): Promise<BuiltService & ConsoleRuntime> {
  const environment = ctx.config.environment;
  const ingress = loadIngressConfig(ctx.env, environment, ["console"]);
  const docsOrigin = loadDocsOrigin(ctx.env, environment);
  const settings = realmSettings(ctx.env, environment);
  const pool = overrides.pool ?? createConsolePool(poolSettings(ctx.env, environment));
  if (overrides.pool === undefined) ctx.onStop("database", () => pool.end());
  pool.on("error", () => {
    ctx.telemetry.log("database.pool_error", {}, "error");
  });
  const lines = lineSink(ctx.telemetry);
  const clock = dateClock(ctx.clock);
  const db = createPgDatabase({ pool, clock, release: ctx.config.release, lines });
  const realm = createRealm({
    settings,
    db,
    clock,
    lines,
    docsOrigin,
    actions: [ORGS_ACTIONS, KEYS_ACTIONS],
  });
  // API keys (spec 02 §12, L-SAT-11): the lifecycle, and its keys as a credential source a removal
  // or a demotion rolls (§9.4).
  const keys = keysOf(ctx.env, environment, { clock, lines });
  const credentials = overrides.credentials ?? new CredentialRegistry();
  if (keys !== null && !credentials.sources.some((s) => s.kind === "api_key")) {
    credentials.register(apiKeyCredentials(keys));
  }
  const orgs = createOrgs(realm, { credentials });
  ctx.readiness.add("database", async () => {
    try {
      await pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  });
  const peers = new ConnectorPeers({
    services: ingress.connectorServices,
    resolver: ctx.resolver,
    clock: ctx.clock,
  });
  const host = createApiHost({
    app: "console",
    environment,
    release: ctx.config.release,
    docsOrigin,
    ingress,
    telemetry: ctx.telemetry,
    reporter: ctx.reporter,
    clock: ctx.clock,
    readiness: ctx.readiness,
    peers,
    fetch: ctx.fetch,
    auth: authHook(realm),
    routes: (api) => registerRoutes(api, { orgs, docsOrigin, keys }),
  });
  return {
    fetch: host.fetch,
    peers,
    health: async () => ({ dbPoolTotal: pool.totalCount, dbPoolIdle: pool.idleCount }),
    realm,
    orgs,
  };
}

/** The console's service definition; tests pass their own pool. */
export function defineConsoleService(overrides: ConsoleOverrides = {}): ServiceDefinition {
  return { services: ["console"], build: (ctx) => buildConsole(ctx, overrides) };
}

export const consoleService: ServiceDefinition = defineConsoleService();
