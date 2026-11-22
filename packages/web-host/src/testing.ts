// Test helpers for an app's API half: boot the real service on a real socket, with the connector
// services resolving to 127.0.0.1, so requests from 127.0.0.1 are connector traffic and requests
// from ::1 are a neighbour on the private network. Imported only by *.test.ts files.
import { type RunningService, runService, type ServiceDefinition } from "@fin/server";
import type { ServiceName } from "@fin/server/config";
import { baseEnv, type Line, randomProof } from "@fin/server/testing";
import { loopbackPortFree, type RawResponse, rawRequest } from "@fin/server/testing/http";

export const CONNECTOR_ADDRESS = "127.0.0.1";
export const NEIGHBOUR_ADDRESS = "::1";

// The service listens on `::` at a port below the ports any system hands to a listener that asks
// for port 0 (macOS's start at 49152, Linux's at 32768). On macOS a listener on 127.0.0.1 may share
// the port of one on `::`, and then takes the connections sent to 127.0.0.1: with port 0, another
// test's listener on 127.0.0.1 was given the service's port inside a busy `pnpm check`, and its 404s
// came back for the service's. A port in this range is never handed to port 0; one a listener on
// 127.0.0.1 or 0.0.0.0 already holds is skipped, and one another test's service took is tried again.
const FIRST_PORT = 20_000;
const PORTS = 12_000;
const TRIES = 20;

export interface BootedApi {
  service: RunningService;
  stdout: Line[];
  exits: number[];
  proofs: Record<string, string>;
  /** From a connector (127.0.0.1) with the host's proof unless told otherwise. */
  send(init: {
    host: string;
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    from?: string;
    proof?: string | null;
    role?: string;
  }): Promise<RawResponse>;
  stop(): Promise<void>;
}

export async function bootApi(
  definition: ServiceDefinition,
  options: {
    service: ServiceName;
    roles: readonly string[];
    env: Record<string, string>;
    fetch?: typeof fetch;
  },
): Promise<BootedApi> {
  const proofs = Object.fromEntries(options.roles.map((role) => [role, randomProof()]));
  let stdout: Line[] = [];
  let exits: number[] = [];
  let service: RunningService | undefined;
  for (let tries = 1; service === undefined && tries <= TRIES; tries++) {
    const port = FIRST_PORT + Math.floor(Math.random() * PORTS);
    if (!(await loopbackPortFree(port))) continue;
    const lines: Line[] = [];
    const codes: number[] = [];
    [stdout, exits] = [lines, codes];
    service = await runService(definition, {
      env: {
        ...baseEnv(options.service, { FIN_DRAIN_SECONDS: "5" }),
        FIN_DOCS_ORIGIN: "https://docs.example.net",
        FIN_INGRESS_PROOFS: JSON.stringify(
          Object.fromEntries(options.roles.map((r) => [r, [proofs[r]]])),
        ),
        ...options.env,
      },
      exit: (code) => codes.push(code),
      processHandlers: false,
      host: "::",
      port,
      stdout: (text) => lines.push(JSON.parse(text) as Line),
      resolve: async () => [{ address: CONNECTOR_ADDRESS, family: 4 }],
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    });
    const taken = lines.some(
      (line) => line.event === "process.start_failed" && line.errorCode === "EADDRINUSE",
    );
    if (service === undefined && !taken) {
      throw new Error(`the service did not start: ${JSON.stringify(lines)}`);
    }
  }
  if (service === undefined) throw new Error(`no free port for the service in ${TRIES} tries`);
  const started = service;
  return {
    service: started,
    stdout,
    exits,
    proofs,
    send: (init) => {
      const headers: Record<string, string> = { host: init.host, ...init.headers };
      const proof =
        init.proof === undefined ? proofs[init.role ?? options.roles[0] ?? ""] : init.proof;
      if (proof !== null && proof !== undefined) headers["fin-ingress-proof"] = proof;
      // A body is framed by its length, unless the test asks for chunked framing (node:http then
      // writes the chunks itself, and a request may not carry both).
      if (init.body !== undefined && headers["transfer-encoding"] === undefined) {
        headers["content-length"] = String(Buffer.byteLength(init.body));
      }
      return rawRequest({
        port: started.port,
        address: init.from ?? CONNECTOR_ADDRESS,
        method: init.method ?? "GET",
        path: init.path,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    },
    stop: () => started.shutdown.begin("SIGTERM"),
  };
}
