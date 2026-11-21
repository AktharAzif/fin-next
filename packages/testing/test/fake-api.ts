// A stand-in for an app's API test server in the harness's own tests: it answers every request
// with what it received, so a test can see exactly what the static host forwarded.
import { headerValue, type Listening, listen } from "../src/http/node.ts";

export interface Echo {
  readonly method: string;
  readonly target: string;
  readonly host: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: string;
  readonly peer: string;
}

export interface FakeApi extends Listening {
  readonly received: Echo[];
}

export async function startFakeApi(): Promise<FakeApi> {
  const received: Echo[] = [];
  const listening = await listen(async (request) => {
    const body = request.body === null ? "" : await new Response(request.body).text();
    const echo: Echo = {
      method: request.method,
      target: request.target,
      host: headerValue(request.headers, "host") ?? "",
      headers: request.headers,
      body,
      peer: request.remoteAddress,
    };
    received.push(echo);
    if (request.target.startsWith("/api/no-content")) return new Response(null, { status: 204 });
    const headers = new Headers({ "cache-control": "no-store", "fin-release": "0".repeat(40) });
    headers.append("set-cookie", "__Host-a=1; Path=/; Secure; HttpOnly; SameSite=Strict");
    headers.append("set-cookie", "__Host-b=2; Path=/; Secure; HttpOnly; SameSite=Lax");
    return Response.json(echo, {
      status: request.target.startsWith("/api/missing") ? 404 : 200,
      headers,
    });
  });
  return { ...listening, received };
}
