// The edge (spec 01 §4.5; ARCHITECTURE §5.5, §5.6, §13): Hono on Node at [::]:8080, reached only by
// the public tunnel on api.<zone>. Phase 0's skeleton, in this order:
//   private health (/healthz, /readyz: 404 through the tunnel);
//   the ingress check (connector peer and the api host's proof);
//   plain http refused with 403 https_required (CF-Visitor, trusted only for tunnel traffic; the key
//   revocation of [FD-03] comes with API keys);
//   a 256 KB body limit;
//   CORS for the docs origin only, without credentials;
//   GET /health (200) and GET /v4/whoami (401 with Fin's problem type until API keys land).
// Everything else is 404. Every answer carries the API headers.

import type { BuiltService, ServiceContext, ServiceDefinition } from "@fin/server";
import { loadDocsOrigin, loadIngressConfig } from "@fin/server/config";
import { privateHealth } from "@fin/server/health";
import {
  apiHeaders,
  errorHandler,
  type FinEnv,
  notFoundHandler,
  type RequestOptions,
  refuse,
  requestUnit,
} from "@fin/server/http";
import { ConnectorPeers, IngressProofs, ingressCheck } from "@fin/server/ingress";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { docsCors } from "./cors.ts";

export const BODY_LIMIT_BYTES = 256 * 1024;

export function buildEdge(ctx: ServiceContext): BuiltService {
  const ingress = loadIngressConfig(ctx.env, ctx.config.environment, ["api"]);
  const docsOrigin = loadDocsOrigin(ctx.env, ctx.config.environment);
  const apiOrigin = ingress.origins.api as string;
  const peers = new ConnectorPeers({
    services: ingress.connectorServices,
    resolver: ctx.resolver,
    clock: ctx.clock,
  });
  const options: RequestOptions = {
    telemetry: ctx.telemetry,
    reporter: ctx.reporter,
    clock: ctx.clock,
    docsOrigin,
  };
  const notFound = notFoundHandler(options);

  const app = new Hono<FinEnv>();
  app.onError(errorHandler(options));
  app.notFound(notFound);
  app.use(requestUnit(options));
  app.use(
    apiHeaders({
      release: ctx.config.release,
      environment: ctx.config.environment,
      defaultRole: "api",
      keepCors: true,
    }),
  );
  app.use(
    privateHealth({
      readiness: ctx.readiness,
      peers,
      publicHosts: [new URL(apiOrigin).host],
      notFound,
    }),
  );
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
    if (c.get("ingress")?.scheme !== "https") {
      c.set("outcome", "refused");
      c.set("reason", "https_required");
      return refuse(options, c, 403, "https_required");
    }
    await next();
  });
  app.use(
    bodyLimit({
      maxSize: BODY_LIMIT_BYTES,
      onError: (c) => {
        c.set("outcome", "refused");
        c.set("reason", "body_limit");
        return refuse(options, c, 413, "payload_too_large");
      },
    }),
  );
  app.use(docsCors(docsOrigin));
  app.on(["GET", "HEAD"], "/health", (c) => c.json({ status: "ok" }, 200));
  app.get("/v4/whoami", (c) => {
    c.set("outcome", "refused");
    c.set("reason", "key.missing");
    return refuse(options, c, 401, "unauthenticated", undefined, { "www-authenticate": "Bearer" });
  });
  return { fetch: app.fetch, peers };
}

export const edgeService: ServiceDefinition = { services: ["edge"], build: buildEdge };
