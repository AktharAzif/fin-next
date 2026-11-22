// Starts the admin API stand-in where a journey run expects Fin Admin's API half: on loopback at
// the role's API port (the static host's `/api/` route proxies there with the ingress proof and the
// Access JWT), and its control port beside it, which only Node-side test code calls. The listener
// is @fin/testing's (Node built-ins, plain http on loopback).
import {
  ACCESS_STAND_IN_PORT,
  appOrigin,
  EMAIL_SINK_PORT,
  e2eClock,
  STATIC_APPS,
  testAccessAudience,
  testIngressProof,
} from "@fin/testing";
// @fin/testing does not export its listener yet (L-SAT-08 is asked to); its file, by path.
import { type Listening, listen } from "../../../../packages/testing/src/http/node.ts";
import { AdminApiStandIn, controlHandler } from "./admin-api.ts";

/** The control port: one above the API's (4212 for Fin Admin's 4202). */
export const CONTROL_PORT = (STATIC_APPS.admin.apiPort ?? 4202) + 10;

export interface RunningAdminApi {
  readonly api: AdminApiStandIn;
  readonly server: Listening;
  readonly control: Listening;
  close(): Promise<void>;
}

export async function startAdminApi(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunningAdminApi> {
  const clock = e2eClock(env.FIN_E2E_CLOCK);
  const accessOrigin = env.FIN_E2E_ACCESS_STAND_IN ?? `http://127.0.0.1:${ACCESS_STAND_IN_PORT}`;
  const api = new AdminApiStandIn({
    appOrigin: appOrigin("admin"),
    ingressProof: testIngressProof("admin", env),
    accessCertsUrl: `${accessOrigin}/cdn-cgi/access/certs`,
    accessIssuer: accessOrigin,
    accessAudience: testAccessAudience(),
    emailSink: env.FIN_E2E_EMAIL_SINK ?? `http://127.0.0.1:${EMAIL_SINK_PORT}`,
    now: clock.now,
    environment: env.FIN_E2E_ADMIN_ENVIRONMENT === "production" ? "production" : "staging",
  });
  const onError = () => process.stderr.write("admin-api stand-in: a request failed inside it\n");
  const server = await listen((request) => api.handle(request), {
    port: STATIC_APPS.admin.apiPort ?? 4202,
    anyHost: true,
    onError,
  });
  const control = await listen((request) => controlHandler(api, request), {
    port: CONTROL_PORT,
    onError,
  });
  return {
    api,
    server,
    control,
    async close() {
      await Promise.all([server.close(), control.close()]);
    },
  };
}
