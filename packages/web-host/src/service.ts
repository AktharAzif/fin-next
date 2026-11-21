// defineApiService: an app's API half as a runnable service. It reads the app's settings once
// (FIN_PUBLIC_ORIGIN, FIN_CONNECTOR_SERVICES, FIN_INGRESS_PROOFS, FIN_DOCS_ORIGIN, and on Fin Admin
// FIN_ACCESS_TEAM and FIN_ACCESS_AUD; exit 78 naming any bad one), resolves its connector services
// through the private-DNS cache, and builds the shared API host with the app's hooks.

import type { BuiltService, ServiceContext, ServiceDefinition } from "@fin/server";
import { loadAccessConfig, loadDocsOrigin, loadIngressConfig } from "@fin/server/config";
import { ConnectorPeers } from "@fin/server/ingress";
import { APP_ROLES, type ApiHostOptions, type AppName, createApiHost } from "./api-host.ts";

export type ApiServiceHooks = Pick<ApiHostOptions, "auth" | "routes" | "uploads">;

export function buildApiService(
  app: AppName,
  ctx: ServiceContext,
  hooks: ApiServiceHooks = {},
): BuiltService {
  const roles = APP_ROLES[app];
  const ingress = loadIngressConfig(ctx.env, ctx.config.environment, roles);
  const docsOrigin = loadDocsOrigin(ctx.env, ctx.config.environment);
  const access = app === "admin" ? loadAccessConfig(ctx.env) : undefined;
  const peers = new ConnectorPeers({
    services: ingress.connectorServices,
    resolveAll: (hostname) => ctx.resolver.resolveAll(hostname),
    clock: ctx.clock,
  });
  const host = createApiHost({
    app,
    environment: ctx.config.environment,
    release: ctx.config.release,
    docsOrigin,
    ingress,
    ...(access !== undefined ? { access } : {}),
    telemetry: ctx.telemetry,
    reporter: ctx.reporter,
    clock: ctx.clock,
    readiness: ctx.readiness,
    peers,
    fetch: ctx.fetch,
    ...hooks,
  });
  return { fetch: host.fetch, peers };
}

/** The service definition an app's server.node.ts hands to runService. */
export function defineApiService(app: AppName, hooks: ApiServiceHooks = {}): ServiceDefinition {
  return { services: [app], build: (ctx) => buildApiService(app, ctx, hooks) };
}
