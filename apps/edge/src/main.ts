// The edge (spec 05 §2, §2.1; ARCHITECTURE §5.5, §5.6, §7.7, §13): Hono on Node at [::]:8080, reached
// only by the public tunnel on api.<zone> (gateway.<staging-zone> on staging). The pipeline, in
// spec 05 §2.1's order (L-SAT-11 builds steps 1 to 6, 12 to 19, `GET /v4/whoami` and the request
// line; L-SUN-01 the rest of §2.1 and §3):
//    1. private health (/healthz, /readyz: 404 through the tunnel);
//    2. the ingress check (a current connector peer and the api host's proof);
//    3. the configured host (421), a target with one leading `/` and no `\` (400);
//    4. `req_<26>` (the request unit; a caller's Request-Id is ignored);
//    5. load shedding: per-replica buckets for the address and in all (429, Retry-After: 1);
//    6. plain http refused (403 https_required; the key's revocation of [FD-03] is §4.8's, later);
//    then a 256 KB body limit, GET /health, 404 for anything not under /v4/, CORS for the docs
//    origin only (9), the route table (10), Fin-Version (11), the key check (12 to 19, keycheck.ts),
//    `GET /v4/whoami` answered here (21), and "last used" after the answer (23).
// Every answer carries the API headers, `Fin-Version`, `Request-Id` and `Cache-Control: no-store`,
// and never `Fin-Release` (D05-29). Every request writes one `request` line (spec 05 §10.1).
//
// Everything is built inside main() through `buildEdge(ctx)`, never at module scope: the settings
// and secrets, the pool, the shedder, the app.
import { type Clock, ConfigError } from "@fin/core";
import { type Keyring, KeyringConfigError, keyringFromEnv } from "@fin/crypto";
import {
  createPool,
  DatabaseConfigError,
  type LineSink,
  type PgPool,
  poolSettingsFromEnv,
} from "@fin/db";
import { type KeyEnvironment, type KeyStore, keyStore, type Queryable, saltFor } from "@fin/keys";
import type { BuiltService, ServiceContext, ServiceDefinition } from "@fin/server";
import { loadDocsOrigin, loadIngressConfig } from "@fin/server/config";
import { privateHealth } from "@fin/server/health";
import {
  apiHeaders,
  type FinContext,
  type FinEnv,
  isSafeTarget,
  rawTarget,
  refuse,
} from "@fin/server/http";
import { ConnectorPeers, IngressProofs, ingressCheck } from "@fin/server/ingress";
import type { Telemetry } from "@fin/server/telemetry";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { docsCors } from "./cors.ts";
import { checkKey, type EdgeRoute, type KeyCheckDeps } from "./keycheck.ts";
import { LastUsed } from "./last-used.ts";
import { problemAnswer } from "./problems.ts";
import { edgeRequestUnit, factsOf } from "./request-line.ts";
import { addressKey, Shedder, type ShedSettings, shedSettings } from "./shed.ts";
import { whoami } from "./whoami.ts";

export const BODY_LIMIT_BYTES = 256 * 1024;

/** The public API's one version date (spec 05 §3.6, D05-25); L-SUN-01's contract package owns it. */
export const FIN_API_VERSION = "2026-11-23";
export const SUPPORTED_VERSIONS: readonly string[] = [FIN_API_VERSION];

/** The /v4 operations the edge knows (spec 05 §6); every other /v4 path is 404 before any key. */
export const EDGE_ROUTES: readonly EdgeRoute[] = [
  {
    operationId: "getApiKey",
    method: "GET",
    path: "/v4/whoami",
    keyKind: "any",
    scopes: [],
    mode: "any",
  },
];

export interface EdgeOverrides {
  /** The key statements (tests that count them, or that need no database). */
  store?: KeyStore;
  peppers?: Keyring;
  shed?: Partial<ShedSettings>;
  /** The clock of the in-memory minutes (shedding and "last used"), for tests that cross one. */
  clock?: Clock;
}

export interface EdgeSettings {
  peppers: Keyring;
  salt: string;
  shed: ShedSettings;
}

/** The edge's own settings, each refused at start-up naming the variable, never its value (exit 78). */
export function edgeSettings(
  env: Readonly<Record<string, string | undefined>>,
  environment: KeyEnvironment,
): Omit<EdgeSettings, "peppers"> & { peppers: () => Keyring } {
  const salt = env.FIN_KEY_SALT;
  if (salt === undefined || salt === "") throw new ConfigError("FIN_KEY_SALT", "missing");
  // The salt must be this environment's: a staging edge never accepts a production key.
  if (salt !== saltFor(environment)) throw new ConfigError("FIN_KEY_SALT", "refused");
  return {
    salt,
    shed: shedSettings(env),
    peppers: () => {
      try {
        return keyringFromEnv(env, "API_KEY_PEPPER");
      } catch (error) {
        if (error instanceof KeyringConfigError) throw new ConfigError(error.variable, "malformed");
        throw error;
      }
    },
  };
}

/** Each statement on a client taken from the pool and given back at once: none is held across I/O. */
export function poolQueryable(pool: PgPool): Queryable {
  return {
    async query(text, values) {
      const client = await pool.connect();
      try {
        const result = await client.query(text, values);
        return { rows: result.rows as never[] };
      } finally {
        client.release();
      }
    },
  };
}

function dbLines(telemetry: Telemetry): LineSink {
  return { write: (line) => telemetry.log(line.event, line.fields ?? {}, line.level) };
}

/** Fin-Version on every answer, Vary: Origin on /v4, and never Fin-Release (D05-29). */
function publicHeaders(): MiddlewareHandler<FinEnv> {
  return async (c, next) => {
    await next();
    let headers = c.res.headers;
    try {
      headers.set("fin-version", FIN_API_VERSION);
    } catch {
      c.res = new Response(c.res.body, c.res);
      headers = c.res.headers;
      headers.set("fin-version", FIN_API_VERSION);
    }
    headers.delete("fin-release");
    if (
      new URL(c.req.url).pathname.startsWith("/v4/") &&
      !(headers.get("vary") ?? "").includes("Origin")
    ) {
      headers.append("vary", "Origin");
    }
  };
}

function routeOf(c: FinContext): EdgeRoute | undefined {
  const path = new URL(c.req.url).pathname;
  return EDGE_ROUTES.find((r) => r.path === path && r.method === c.req.method);
}

export async function buildEdge(
  ctx: ServiceContext,
  overrides: EdgeOverrides = {},
): Promise<BuiltService> {
  const environment = ctx.config.environment;
  const ingress = loadIngressConfig(ctx.env, environment, ["api"]);
  const docsOrigin = loadDocsOrigin(ctx.env, environment);
  const apiOrigin = ingress.origins.api as string;
  const settings = edgeSettings(ctx.env, environment);
  const peppers = overrides.peppers ?? settings.peppers();
  let store = overrides.store;
  let poolStats: (() => Record<string, number>) | undefined;
  if (store === undefined) {
    let poolSettings: ReturnType<typeof poolSettingsFromEnv>;
    try {
      poolSettings = poolSettingsFromEnv(ctx.env, "edge");
    } catch (error) {
      if (error instanceof DatabaseConfigError) throw new ConfigError(error.variable, "malformed");
      throw error;
    }
    const pool = createPool(poolSettings, dbLines(ctx.telemetry));
    ctx.onStop("database", () => pool.end());
    ctx.readiness.add("database", async () => {
      try {
        await poolQueryable(pool).query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    });
    poolStats = () => ({
      dbPoolTotal: pool.totalCount,
      dbPoolIdle: pool.idleCount,
      dbPoolWaiting: pool.waitingCount,
    });
    store = keyStore(poolQueryable(pool));
  }
  const memoryClock = overrides.clock ?? ctx.clock;
  const shed = { ...settings.shed, ...overrides.shed };
  const shedder = new Shedder(shed, memoryClock);
  const deps: KeyCheckDeps = {
    store,
    peppers,
    salt: settings.salt,
    shedder,
    lastUsed: new LastUsed(memoryClock, shed.maxEntries),
    clock: ctx.clock,
    docsOrigin,
    telemetry: ctx.telemetry,
  };
  const peers = new ConnectorPeers({
    services: ingress.connectorServices,
    resolver: ctx.resolver,
    clock: ctx.clock,
  });
  const options = {
    telemetry: ctx.telemetry,
    reporter: ctx.reporter,
    clock: ctx.clock,
    docsOrigin,
  };

  const app = new Hono<FinEnv>();
  app.onError((error, c) => {
    const errorId = ctx.reporter.reportError(error, { requestId: c.get("requestId") });
    c.set("errorId", errorId);
    c.set("outcome", "error");
    c.set("reason", "internal");
    return problemAnswer(c, docsOrigin, { code: "internal" });
  });
  app.notFound((c) => {
    c.set("outcome", "refused");
    c.set("reason", "not_found");
    return problemAnswer(c, docsOrigin, { code: "not_found" });
  });
  // 4 (and the line): the request unit, outermost, so every answer below writes its line.
  app.use(edgeRequestUnit(options));
  app.use(publicHeaders());
  app.use(
    apiHeaders({
      release: ctx.config.release,
      environment,
      defaultRole: "api",
      keepCors: true,
    }),
  );
  // 1: private health.
  app.use(
    privateHealth({
      readiness: ctx.readiness,
      peers,
      publicHosts: [new URL(apiOrigin).host],
      notFound: (c) => problemAnswer(c, docsOrigin, { code: "not_found" }),
    }),
  );
  // 2, 3: the ingress check, which also refuses a host other than the api host (421).
  app.use(
    ingressCheck({
      peers,
      proofs: new IngressProofs(ingress.proofs),
      origins: { api: apiOrigin },
      telemetry: ctx.telemetry,
      refuse: (c, status, code) => refuse(options, c, status, code),
    }),
  );
  app.use(async (c, next) => {
    if (!isSafeTarget(rawTarget(c))) {
      c.set("outcome", "refused");
      c.set("reason", "target");
      return problemAnswer(c, docsOrigin, { code: "invalid_request" });
    }
    await next();
  });
  // 5: load shedding, before any database work.
  app.use(async (c, next) => {
    if (!shedder.admit(addressKey(c.get("ingress")?.clientIp))) {
      c.set("outcome", "shed");
      c.set("reason", "shed");
      return problemAnswer(c, docsOrigin, {
        code: "rate_limited",
        headers: { "retry-after": "1" },
      });
    }
    await next();
  });
  // 6: plain http.
  app.use(async (c, next) => {
    if (c.get("ingress")?.scheme !== "https") {
      c.set("outcome", "refused");
      c.set("reason", "https_required");
      return problemAnswer(c, docsOrigin, { code: "https_required" });
    }
    await next();
  });
  app.use(
    bodyLimit({
      maxSize: BODY_LIMIT_BYTES,
      onError: (c) => {
        c.set("outcome", "refused");
        c.set("reason", "body_limit");
        return problemAnswer(c, docsOrigin, { code: "body_too_large" });
      },
    }),
  );
  app.on(["GET", "HEAD"], "/health", (c) => c.json({ status: "ok" }, 200));
  // The request line's /v4 facts (spec 05 §10.1): a call from the docs origin (Try it, `fromDocs`)
  // and a preflight (`corsPreflight`), written before CORS answers a preflight itself, below.
  app.use("/v4/*", async (c, next) => {
    const facts = factsOf(c);
    if (c.req.header("origin") === docsOrigin) facts.fromDocs = true;
    if (c.req.method === "OPTIONS") facts.corsPreflight = true;
    await next();
  });
  // 9: CORS for the docs origin; a preflight is answered here and never forwarded.
  app.use(docsCors(docsOrigin));
  app.use("/v4/*", async (c, next) => {
    // 10: the route table; an unknown route is 404 before any key is read.
    const route = routeOf(c);
    if (route === undefined) {
      c.set("route", "/v4/*");
      c.set("outcome", "refused");
      c.set("reason", "not_found");
      return problemAnswer(c, docsOrigin, { code: "not_found" });
    }
    c.set("route", route.path);
    // 11: Fin-Version, when sent, is a supported date.
    const version = c.req.header("fin-version");
    if (version !== undefined) {
      if (!SUPPORTED_VERSIONS.includes(version)) {
        c.set("outcome", "refused");
        c.set("reason", "api_version_unknown");
        return problemAnswer(c, docsOrigin, { code: "api_version_unknown" });
      }
      factsOf(c).finVersion = version;
    }
    // 12 to 19.
    const checked = await checkKey(c, deps, route);
    if ("refused" in checked) return checked.refused;
    await next();
    for (const [name, value] of Object.entries(checked.headers)) c.res.headers.set(name, value);
  });
  // 21, 23.
  app.get("/v4/whoami", (c) => whoami(c, deps));

  return {
    fetch: app.fetch,
    peers,
    ...(poolStats === undefined
      ? {}
      : { health: async () => ({ ...poolStats?.(), shed: shedder.shed }) }),
  };
}

/** The edge's service definition; tests pass their own store or settings. */
export function defineEdgeService(overrides: EdgeOverrides = {}): ServiceDefinition {
  return { services: ["edge"], build: (ctx) => buildEdge(ctx, overrides) };
}

export const edgeService: ServiceDefinition = defineEdgeService();
