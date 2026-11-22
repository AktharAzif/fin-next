// Test helpers for an app's API half: boot the real service on a real socket, with the connector
// services resolving to 127.0.0.1, so requests from 127.0.0.1 are connector traffic and requests
// from ::1 are a neighbour on the private network. Imported only by *.test.ts files.
import { type RunningService, runService, type ServiceDefinition } from "@fin/server";
import type { ServiceName } from "@fin/server/config";
import { baseEnv, type Line, randomProof } from "@fin/server/testing";
import { type RawResponse, rawRequest } from "@fin/server/testing/http";

export const CONNECTOR_ADDRESS = "127.0.0.1";
export const NEIGHBOUR_ADDRESS = "::1";

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
  const stdout: Line[] = [];
  const exits: number[] = [];
  const service = await runService(definition, {
    env: {
      ...baseEnv(options.service, { FIN_DRAIN_SECONDS: "5" }),
      FIN_DOCS_ORIGIN: "https://docs.example.net",
      FIN_INGRESS_PROOFS: JSON.stringify(
        Object.fromEntries(options.roles.map((r) => [r, [proofs[r]]])),
      ),
      ...options.env,
    },
    exit: (code) => exits.push(code),
    processHandlers: false,
    host: "::",
    port: 0,
    stdout: (text) => stdout.push(JSON.parse(text) as Line),
    resolve: async () => [{ address: CONNECTOR_ADDRESS, family: 4 }],
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  if (service === undefined)
    throw new Error(`the service did not start: ${JSON.stringify(stdout)}`);
  return {
    service,
    stdout,
    exits,
    proofs,
    send: (init) => {
      const headers: Record<string, string> = { host: init.host, ...init.headers };
      const proof =
        init.proof === undefined ? proofs[init.role ?? options.roles[0] ?? ""] : init.proof;
      if (proof !== null && proof !== undefined) headers["fin-ingress-proof"] = proof;
      if (init.body !== undefined) headers["content-length"] = String(Buffer.byteLength(init.body));
      return rawRequest({
        port: service.port,
        address: init.from ?? CONNECTOR_ADDRESS,
        method: init.method ?? "GET",
        path: init.path,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    },
    stop: () => service.shutdown.begin("SIGTERM"),
  };
}
