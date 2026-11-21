// The API host every app's API half shares (spec 02 §2.2; spec 01 §4.4; FW-C02, FW-C03 under the
// static shape). Cloudflare serves the static files; this host answers only `<app host>/api/*` and
// private health, in this order:
//   1. private health (/healthz, /readyz) for private callers only; 404 through a tunnel;
//   2. the ingress check: a connector peer with the host's proof, `Host` configured, the URL rebuilt
//      from the configured origin (403 ingress.untrusted_peer, 421, 400);
//   3. a body limit of 256 KB (413);
//   4. on Fin Admin only, a valid Cf-Access-Jwt-Assertion (401 access_required, 503);
//   5. the path starts with /api/ (404); GET /api/health answers here;
//   6. the origin gate on every method but GET, HEAD and OPTIONS (403 invalid_origin);
//   7. /api/auth/* only through the realm's exact allowlist hook (404 for anything unlisted, before
//      any limit is counted); no hook, no auth route;
//   8. the app's JSON routes, under Hono's basePath("/api");
//   9. anything else under /api/ is 404.
// Every answer carries Cache-Control: no-store, Fin-Release and ARCHITECTURE §7.12's API headers;
// errors are RFC 9457 problems; no CORS header is ever sent.
import type { Clock } from "@fin/core";
import type { AccessConfig, Environment, HostRole, IngressConfig } from "@fin/server/config";
import { privateHealth, type Readiness } from "@fin/server/health";
import {
  apiHeaders,
  errorHandler,
  type FinContext,
  type FinEnv,
  notFoundHandler,
  type RequestOptions,
  rawTarget,
  refuse,
  requestUnit,
} from "@fin/server/http";
import { type ConnectorPeers, IngressProofs, ingressCheck } from "@fin/server/ingress";
import type { Reporter } from "@fin/server/report";
import type { Telemetry } from "@fin/server/telemetry";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AccessVerifier, accessCheck } from "./access-jwt.ts";
import { originGate } from "./origin-gate.ts";

export type AppName = "console" | "admin" | "verify";

/** The hosts each app answers for (spec 01 §7.2): verify also answers the selfie host. */
export const APP_ROLES: Readonly<Record<AppName, readonly HostRole[]>> = {
  console: ["console"],
  admin: ["admin"],
  verify: ["verify", "selfie"],
};

export const BODY_LIMIT_BYTES = 256 * 1024;

export type AuthClass = "allow" | "unlisted" | "blocked";

/**
 * The realm's endpoint policy (spec 02 §4), filled by Saturday's identity lane. `classify` sees the
 * raw path after /api/auth, exactly as received (no decoding, no normalising), before any limit is
 * counted; only "allow" reaches `handle` (Better Auth behind its own origin check).
 */
export interface AuthHook {
  realm: "developer" | "staff";
  classify(method: string, rawPath: string): AuthClass;
  handle(c: FinContext): Response | Promise<Response>;
}

export interface ApiHostOptions {
  app: AppName;
  environment: Environment;
  release: string;
  docsOrigin: string;
  ingress: IngressConfig;
  /** Fin Admin only. */
  access?: AccessConfig;
  telemetry: Telemetry;
  reporter: Reporter;
  clock: Clock;
  readiness: Readiness;
  peers: ConnectorPeers;
  /** Injected in tests; otherwise built from `access`. */
  accessVerifier?: AccessVerifier;
  fetch?: typeof fetch;
  auth?: AuthHook;
  /** Registers the app's JSON routes on a Hono app whose basePath is /api. */
  routes?: (api: Hono<FinEnv>) => void;
  /** `METHOD /api/route/:template` entries whose bodies may be multipart uploads. */
  uploads?: readonly string[];
}

export function createApiHost(options: ApiHostOptions): Hono<FinEnv> {
  const roles = APP_ROLES[options.app];
  for (const role of roles) {
    if (options.ingress.origins[role] === undefined) {
      throw new TypeError(`the ${options.app} API host needs the ${role} origin`);
    }
  }
  if (options.app === "verify" && options.auth !== undefined) {
    throw new TypeError("verify runs no Better Auth: it has no /api/auth routes");
  }
  if (
    options.app === "admin" &&
    options.access === undefined &&
    options.accessVerifier === undefined
  ) {
    throw new TypeError("Fin Admin's API host checks the Access token on every request");
  }

  const requestOptions: RequestOptions = {
    telemetry: options.telemetry,
    reporter: options.reporter,
    clock: options.clock,
    docsOrigin: options.docsOrigin,
  };
  const problem = (
    c: FinContext,
    status: number,
    code: string,
    extensions?: Record<string, unknown>,
  ) => refuse(requestOptions, c, status, code, extensions);
  const notFound = notFoundHandler(requestOptions);
  const publicHosts = roles.map((role) => new URL(options.ingress.origins[role] as string).host);

  const app = new Hono<FinEnv>();
  app.onError(errorHandler(requestOptions));
  app.notFound(notFound);

  app.use(requestUnit(requestOptions));
  app.use(
    apiHeaders({
      release: options.release,
      environment: options.environment,
      defaultRole: roles[0] as HostRole,
    }),
  );
  // 1. Private health.
  app.use(
    privateHealth({ readiness: options.readiness, peers: options.peers, publicHosts, notFound }),
  );
  // 2. Ingress.
  app.use(
    ingressCheck({
      peers: options.peers,
      proofs: new IngressProofs(options.ingress.proofs),
      origins: Object.fromEntries(roles.map((role) => [role, options.ingress.origins[role]])),
      telemetry: options.telemetry,
      refuse: (c, status, code) => problem(c, status, code),
    }),
  );
  // 3. The body limit.
  app.use(
    bodyLimit({
      maxSize: BODY_LIMIT_BYTES,
      onError: (c) => {
        c.set("outcome", "refused");
        c.set("reason", "body_limit");
        return problem(c, 413, "payload_too_large");
      },
    }),
  );
  // 4. Fin Admin: the Access token on every request.
  if (options.app === "admin") {
    const verifier =
      options.accessVerifier ??
      new AccessVerifier({
        team: (options.access as AccessConfig).team,
        aud: (options.access as AccessConfig).aud,
        clock: options.clock,
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      });
    app.use(
      accessCheck({
        verifier,
        telemetry: options.telemetry,
        refuse: (c, status, code) => problem(c, status, code),
      }),
    );
  }
  // 5. Only /api/ paths exist here.
  app.use(async (c, next) => {
    if (!new URL(c.req.url).pathname.startsWith("/api/")) {
      c.set("route", "unmatched");
      return notFound(c);
    }
    await next();
  });
  // 6. The origin gate.
  const uploads = new Set(options.uploads ?? []);
  app.use(
    originGate({
      app: options.app,
      originFor: (c) => {
        const role = c.get("ingress")?.role;
        return role === undefined ? undefined : options.ingress.origins[role];
      },
      uploads,
      telemetry: options.telemetry,
      refuse: (c, code) => problem(c, 403, "invalid_origin", { reason: code }),
    }),
  );
  // 7. /api/auth/* through the realm's allowlist only.
  const auth = options.auth;
  app.all("/api/auth/*", async (c) => {
    const raw = rawTarget(c).split("?")[0] ?? "";
    const rest = raw.startsWith("/api/auth/") ? raw.slice("/api/auth".length) : "";
    const verdict: AuthClass =
      auth === undefined || rest === "" ? "unlisted" : auth.classify(c.req.method, rest);
    if (auth !== undefined && verdict === "allow") return auth.handle(c);
    options.telemetry.log(
      "auth.endpoint_blocked",
      { realm: auth?.realm ?? "none", class: verdict === "blocked" ? "blocked" : "unlisted" },
      "warn",
    );
    c.set("outcome", "refused");
    c.set("reason", "policy.blocked");
    return new Response(null, { status: 404 });
  });
  // 8. The app's JSON routes, under /api.
  const api = new Hono<FinEnv>().basePath("/api");
  api.on(["GET", "HEAD"], "/health", (c) => c.json({ status: "ok" }, 200));
  options.routes?.(api);
  app.route("/", api);
  // 9. Everything else: app.notFound.
  return app;
}
