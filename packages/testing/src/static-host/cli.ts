// node packages/testing/src/static-host/cli.ts --app <role> [options]
//
// Serves one built app as its zone would, for Playwright's webServer and for local runs, over
// https with a throwaway certificate, at https://<role>.localhost:<port> (bound to 127.0.0.1):
//   --app <role>          console, admin, verify, selfie or docs (sets the defaults below)
//   --root <dir>          the static output (default: the role's dist folder)
//   --headers <file>      the rendered _headers (default: <root>/_headers; required to exist)
//   --env-json <file>     served as /env.json, as the deploy would render it
//   --port <n>            (default: the role's journey port)
//   --name <host>         the host name browsers use (default: <role>.localhost)
//   --cert-out <file>     writes the host's certificate (public, PEM) there, for a Node client
//                         that wants to trust it; the private key never leaves the process
//   --api <origin>        the API half's test server (default: http://127.0.0.1:<the role's API port>)
//   --api-host <host>     the Host the tunnel sets (default: the host the browser used)
//   --no-api              serve no /api/ route
//   --access-port <n>     with Access in front (default for admin), the stand-in's port
//   --clock <when>        the time the Access stand-in signs and checks tokens at: canon (the
//                         default, CANON_TIME), wall, or an ISO 8601 time; FIN_E2E_CLOCK sets the
//                         same, and the API halves' test servers must check tokens at that time
//
// The ingress proof comes from FIN_E2E_INGRESS_PROOF or the role's derived test value; it is
// never printed. One JSON `request` line per request goes to stdout.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AccessStandIn,
  type RunningAccessStandIn,
  startAccessStandIn,
} from "../access/stand-in.ts";
import { e2eClock, type RunClock } from "../clock.ts";
import {
  ACCESS_STAND_IN_PORT,
  appHostName,
  type HostRole,
  STATIC_APPS,
  testAccessAudience,
  testIngressProof,
} from "./apps.ts";
import { startStaticHost } from "./server.ts";

const ROLES = new Set<string>(Object.keys(STATIC_APPS));

function fail(message: string): never {
  process.stderr.write(`static-host: ${message}\n`);
  process.exit(78);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      app: { type: "string" },
      root: { type: "string" },
      headers: { type: "string" },
      "env-json": { type: "string" },
      port: { type: "string" },
      name: { type: "string" },
      "cert-out": { type: "string" },
      api: { type: "string" },
      "api-host": { type: "string" },
      "no-api": { type: "boolean", default: false },
      "access-port": { type: "string" },
      clock: { type: "string" },
    },
    strict: true,
  });
  const role = values.app;
  if (role === undefined || !ROLES.has(role))
    fail("--app is one of console, admin, verify, selfie, docs");
  const app = STATIC_APPS[role as HostRole];
  const port = Number(values.port ?? app.port);
  if (!Number.isInteger(port) || port < 0) fail("--port is a port number");
  let clock: RunClock;
  try {
    clock = e2eClock(values.clock ?? process.env.FIN_E2E_CLOCK);
  } catch {
    fail("--clock (or FIN_E2E_CLOCK) is canon, wall, or an ISO 8601 time");
  }
  const root = resolve(values.root ?? app.dist);
  const headers = readFileSync(resolve(values.headers ?? `${root}/_headers`), "utf8");

  let access: RunningAccessStandIn | undefined;
  if (app.access || values["access-port"] !== undefined) {
    const standIn = new AccessStandIn({ audience: testAccessAudience(), now: clock.now });
    access = await startAccessStandIn(standIn, {
      port: Number(values["access-port"] ?? ACCESS_STAND_IN_PORT),
    });
  }

  const apiOrigin =
    values.api ?? (app.apiPort === undefined ? undefined : `http://127.0.0.1:${app.apiPort}`);
  const withApi = !values["no-api"] && apiOrigin !== undefined;
  const envJson = values["env-json"];
  const host = await startStaticHost({
    app: role as string,
    root,
    headers,
    port,
    name: values.name ?? appHostName(role as HostRole),
    ...(envJson === undefined ? {} : { files: { "/env.json": readFileSync(resolve(envJson)) } }),
    ...(withApi
      ? {
          api: {
            origin: apiOrigin,
            ingressProof: testIngressProof(role as HostRole),
            ...(values["api-host"] === undefined ? {} : { host: values["api-host"] }),
          },
        }
      : {}),
    ...(access === undefined ? {} : { access: access.standIn.gate() }),
    log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
    onError: () => process.stderr.write("static-host: a request failed inside the host\n"),
  });
  const certOut = values["cert-out"];
  if (certOut !== undefined && host.certificate !== undefined) {
    writeFileSync(resolve(certOut), host.certificate, { mode: 0o644 });
  }
  process.stdout.write(
    `${JSON.stringify({
      event: "process.start",
      service: "static-host",
      app: role,
      origin: host.origin,
      access: access?.origin ?? null,
      clock: clock.setting,
    })}\n`,
  );
  const stop = () => {
    void Promise.all([host.close(), access?.close()]).finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "could not start");
});
