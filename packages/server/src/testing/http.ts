// A raw HTTP client for tests: it sends exactly the headers it is given (Host and Origin included,
// which fetch would not let a caller set) from a chosen local address, so a test can be a connector
// peer or a neighbour. node:http lives in packages/server; apps' tests use it through here.
import { createServer, request } from "node:http";

export interface RawRequest {
  port: number;
  /** The address to connect to: 127.0.0.1 or ::1. */
  address: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json(): unknown;
}

export function rawRequest(options: RawRequest): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: options.address,
        family: options.address.includes(":") ? 6 : 4,
        port: options.port,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers ?? {},
        agent: false,
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body) as unknown,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

/**
 * Whether no listener on this machine holds `port` on 127.0.0.1 or on 0.0.0.0: a test about to
 * serve on `::` at that port asks first, since on macOS such a listener would share the port and
 * take the connections sent to 127.0.0.1.
 */
export async function loopbackPortFree(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "0.0.0.0"]) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, host, () => probe.close(() => resolve(true)));
    });
    if (!free) return false;
  }
  return true;
}
