import { join } from "node:path";
import type { HostRequest, RawHeaders } from "@fin/server/testing/node-http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeApi, startFakeApi } from "../../test/fake-api.ts";
import {
  AccessStandIn,
  isLocalPath,
  type RunningAccessStandIn,
  startAccessStandIn,
} from "../access/stand-in.ts";
import { createStaticHost, type RequestLine, type StaticHostOptions } from "./host.ts";

const ROOT = join(import.meta.dirname, "../../test/fixtures/app");
const ORIGIN = "http://127.0.0.1:4101";
const PROOF = ["test", "proof", "value"].join("-");

function request(
  target: string,
  init: { method?: string; headers?: RawHeaders; body?: string } = {},
): HostRequest {
  return {
    method: init.method ?? "GET",
    target,
    headers: init.headers ?? [["Host", "127.0.0.1:4101"]],
    body: init.body === undefined ? null : new Response(init.body).body,
    remoteAddress: "127.0.0.1",
  };
}

let api: FakeApi;
beforeAll(async () => {
  api = await startFakeApi();
});
afterAll(async () => {
  await api.close();
});

function host(extra: Partial<StaticHostOptions> = {}) {
  const lines: RequestLine[] = [];
  const made = createStaticHost({
    app: "console",
    root: ROOT,
    api: { origin: api.origin, ingressProof: PROOF },
    log: (line) => lines.push(line),
    ...extra,
  });
  return { lines, handle: (r: HostRequest) => made.handle(r, ORIGIN) };
}

describe("the static deployment", () => {
  it("serves / with the profile's headers", async () => {
    const response = await host().handle(request("/"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("STATIC-OK");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains",
    );
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it("answers an unknown path with index.html and 200", async () => {
    const response = await host().handle(request("/settings/team"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("STATIC-OK");
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("serves an asset with the immutable value once", async () => {
    const response = await host().handle(request("/assets/app.js"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("adds the zone's no-store to an HTML answer under /assets/", async () => {
    const response = await host().handle(request("/assets/missing.js"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const cacheControl = response.headers.get("cache-control") ?? "";
    expect(cacheControl.split(", ")).toContain("no-store");
  });

  it("refuses every source map path with 404, even one the build left", async () => {
    for (const path of ["/assets/app.js.map", "/missing.map", "/api/x.map"]) {
      const response = await host().handle(request(path));
      expect(response.status).toBe(404);
      expect(response.headers.has("content-security-policy")).toBe(false);
    }
  });

  it("redirects to the canonical path with 307, keeping the query", async () => {
    const response = await host().handle(request("/about.html?x=1"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/about?x=1");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("never redirects off the host, however the path is written", async () => {
    const locations: string[] = [];
    for (const target of [
      "//elsewhere.example.org/guide/index.html",
      "/%09/guide/index.html",
      "/%2F%2Felsewhere.example.org/guide/index.html",
      "/\\elsewhere.example.org/guide/index.html",
      "/guide/index.html?next=//elsewhere.example.org",
    ]) {
      const location = (await host().handle(request(target))).headers.get("location");
      if (location !== null) locations.push(location);
    }
    expect(locations).toContain("/guide/?next=//elsewhere.example.org");
    for (const location of locations) expect(isLocalPath(location)).toBe(true);
  });

  it("answers HEAD without a body and other methods with 405", async () => {
    const head = await host().handle(request("/", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
    const post = await host().handle(request("/settings", { method: "POST", body: "{}" }));
    expect(post.status).toBe(405);
  });

  it("answers a matching If-None-Match with 304 and the same headers", async () => {
    const first = await host().handle(request("/assets/app.css"));
    const etag = first.headers.get("etag") ?? "";
    const again = await host().handle(
      request("/assets/app.css", { headers: [["If-None-Match", `W/${etag}`]] }),
    );
    expect(again.status).toBe(304);
    expect(again.body).toBeNull();
    expect(again.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("serves an overlay env.json under the general rule", async () => {
    const withEnv = host({ files: { "/env.json": '{"environment":"ci"}' } });
    const response = await withEnv.handle(request("/env.json"));
    expect(await response.json()).toEqual({ environment: "ci" });
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("refuses a target that is not origin-form", async () => {
    expect((await host().handle(request("*", { method: "OPTIONS" }))).status).toBe(400);
    expect((await host().handle(request("http://127.0.0.1/x"))).status).toBe(400);
  });

  it("needs a headers file unless told to serve none", () => {
    expect(() => createStaticHost({ app: "x", root: join(ROOT, "assets") })).toThrow("_headers");
    expect(() => createStaticHost({ app: "x", root: ROOT, headers: "/a\n" })).toThrow("not valid");
    expect(createStaticHost({ app: "x", root: ROOT, headers: null }).manifest.size).toBe(6);
  });
});

describe("the tunnel to the app's test server", () => {
  it("forwards /api/* with the configured Host, the ingress proof and Cloudflare's headers", async () => {
    const response = await host({
      api: { origin: api.origin, ingressProof: PROOF, host: "console.example.test" },
    }).handle(
      request("/api/auth/sign-in/email?x=1", {
        method: "POST",
        headers: [
          ["Host", "127.0.0.1:4101"],
          ["Content-Type", "application/json"],
          ["Origin", ORIGIN],
          ["X-Fin-App", "console"],
          ["Fin-Ingress-Proof", "forged"],
          ["CF-Connecting-IP", "203.0.113.9"],
          ["Connection", "keep-alive, X-Drop-Me"],
          ["X-Drop-Me", "1"],
          ["Cookie", "a=1"],
        ],
        body: '{"email":"asha.rao@example.com"}',
      }),
    );
    expect(response.status).toBe(200);
    const echo = (await response.json()) as {
      method: string;
      target: string;
      host: string;
      body: string;
      headers: [string, string][];
    };
    expect(echo.method).toBe("POST");
    expect(echo.target).toBe("/api/auth/sign-in/email?x=1");
    expect(echo.host).toBe("console.example.test");
    expect(echo.body).toBe('{"email":"asha.rao@example.com"}');
    const get = (name: string) =>
      echo.headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v);
    expect(get("fin-ingress-proof")).toEqual([PROOF]);
    expect(get("cf-connecting-ip")).toEqual(["127.0.0.1"]);
    expect(get("cf-visitor")).toEqual(['{"scheme":"https"}']);
    expect(get("x-forwarded-proto")).toEqual(["https"]);
    expect(get("origin")).toEqual([ORIGIN]);
    expect(get("x-fin-app")).toEqual(["console"]);
    expect(get("cookie")).toEqual(["a=1"]);
    expect(get("x-drop-me")).toEqual([]);
    expect(get("host")).toEqual(["console.example.test"]);
  });

  it("appends the peer to a client's X-Forwarded-For, as Cloudflare does, and keeps the forged part", async () => {
    const echoOf = async (headers: RawHeaders) => {
      const response = await host().handle(request("/api/ping", { headers }));
      const echo = (await response.json()) as { headers: [string, string][] };
      return (name: string) =>
        echo.headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v);
    };
    const forged = await echoOf([
      ["Host", "127.0.0.1:4101"],
      ["X-Forwarded-For", "203.0.113.66"],
      ["CF-Connecting-IP", "203.0.113.67"],
    ]);
    expect(forged("x-forwarded-for")).toEqual(["203.0.113.66,127.0.0.1"]);
    expect(forged("cf-connecting-ip")).toEqual(["127.0.0.1"]);
    const twoLines = await echoOf([
      ["Host", "127.0.0.1:4101"],
      ["X-Forwarded-For", "203.0.113.66, 198.51.100.7"],
      ["x-forwarded-for", "198.51.100.8"],
    ]);
    expect(twoLines("x-forwarded-for")).toEqual([
      "203.0.113.66, 198.51.100.7,198.51.100.8,127.0.0.1",
    ]);
    const none = await echoOf([["Host", "127.0.0.1:4101"]]);
    expect(none("x-forwarded-for")).toEqual(["127.0.0.1"]);
  });

  it("defaults the Host to the one the browser used", async () => {
    const response = await host().handle(request("/api/ping"));
    expect(((await response.json()) as { host: string }).host).toBe("127.0.0.1:4101");
  });

  it("passes the answer through untouched, every Set-Cookie apart", async () => {
    const response = await host().handle(request("/api/missing"));
    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([
      "__Host-a=1; Path=/; Secure; HttpOnly; SameSite=Strict",
      "__Host-b=2; Path=/; Secure; HttpOnly; SameSite=Lax",
    ]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("connection")).toBe(false);
    expect(response.headers.has("transfer-encoding")).toBe(false);
    expect(response.headers.has("content-security-policy")).toBe(false);
    const empty = await host().handle(request("/api/no-content"));
    expect(empty.status).toBe(204);
  });

  it("sends the raw target the client sent, as the zone does", async () => {
    const response = await host().handle(request("/%61pi/ping"));
    expect(((await response.json()) as { target: string }).target).toBe("/%61pi/ping");
  });

  it("answers the tunnel's catch-all 404 for a path only normalisation made /api/", async () => {
    const before = api.received.length;
    for (const target of ["//api/ping", "/x/../api/ping"]) {
      const response = await host().handle(request(target));
      expect(response.status).toBe(404);
    }
    expect(api.received.length).toBe(before);
  });

  it("serves the SPA for /api, /API/ping and /api%2Fping (S-01 (j))", async () => {
    for (const target of ["/api", "/API/ping", "/api%2Fping", "/api/../settings"]) {
      const response = await host().handle(request(target));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("STATIC-OK");
    }
  });

  it("serves the SPA for /api/* on a host with no API half (the docs site)", async () => {
    const docs = createStaticHost({ app: "docs", root: ROOT });
    const response = await docs.handle(request("/api/ping"), ORIGIN);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("STATIC-OK");
  });

  it("answers 502 when the test server is down", async () => {
    const down = host({ api: { origin: "http://127.0.0.1:9", ingressProof: PROOF } });
    expect((await down.handle(request("/api/ping"))).status).toBe(502);
  });
});

describe("request lines", () => {
  it("writes one line per request with the route kind, never the path", async () => {
    const made = host();
    await made.handle(request("/settings/team?email=asha.rao@example.com"));
    await made.handle(request("/api/ping"));
    expect(made.lines.map((l) => [l.route, l.status, l.level])).toEqual([
      ["spa-fallback", 200, "info"],
      ["api", 200, "info"],
    ]);
    expect(JSON.stringify(made.lines)).not.toContain("example.com");
    expect(made.lines[0]).toMatchObject({
      event: "request",
      message: "request",
      service: "static-host",
      app: "console",
    });
  });
});

describe("Access in front of the host", () => {
  let access: RunningAccessStandIn;
  beforeAll(async () => {
    access = await startAccessStandIn(new AccessStandIn({ audience: "aud-for-tests" }));
  });
  afterAll(async () => {
    await access.close();
  });

  const gated = () => host({ access: access.standIn.gate() });

  it("sends a visitor without a token to the stand-in's login", async () => {
    for (const target of ["/", "/api/staff", "/assets/app.js"]) {
      const response = await gated().handle(request(target));
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe(access.origin);
      expect(location.searchParams.get("app")).toBe(ORIGIN);
    }
  });

  it("takes the token at /cdn-cgi/access/authorized and sets CF_Authorization", async () => {
    const token = access.standIn.issue({ email: "grace.hall@example.com" });
    const response = await gated().handle(
      request(`/cdn-cgi/access/authorized?token=${token}&redirect_url=/staff`),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/staff");
    expect(response.headers.get("set-cookie")).toBe(
      `CF_Authorization=${token}; Path=/; HttpOnly; SameSite=Lax`,
    );
    const offsite = await gated().handle(
      request(`/cdn-cgi/access/authorized?token=${token}&redirect_url=//elsewhere.example.org/`),
    );
    expect(offsite.headers.get("location")).toBe("/");
    for (const redirect of [
      "%2F%09%2Felsewhere.example.org%2F",
      "%2F%0A%2Felsewhere.example.org",
    ]) {
      const stripped = await gated().handle(
        request(`/cdn-cgi/access/authorized?token=${token}&redirect_url=${redirect}`),
      );
      expect(stripped.headers.get("location")).toBe("/");
    }
    const bad = await gated().handle(request("/cdn-cgi/access/authorized?token=x.y.z"));
    expect(bad.status).toBe(403);
  });

  it("lets a valid token through and adds Access's headers, replacing a forged one", async () => {
    const token = access.standIn.issue({ email: "grace.hall@example.com" });
    const page = await gated().handle(
      request("/", { headers: [["Cookie", `CF_Authorization=${token}`]] }),
    );
    expect(page.status).toBe(200);
    const response = await gated().handle(
      request("/api/staff", {
        headers: [
          ["Cookie", `x=1; CF_Authorization=${token}`],
          ["Cf-Access-Jwt-Assertion", "forged"],
          ["Cf-Access-Authenticated-User-Email", "someone@example.org"],
        ],
      }),
    );
    const echo = (await response.json()) as { headers: [string, string][] };
    const get = (name: string) =>
      echo.headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v);
    expect(get("cf-access-jwt-assertion")).toEqual([token]);
    expect(get("cf-access-authenticated-user-email")).toEqual(["grace.hall@example.com"]);
  });

  it("refuses an expired token", async () => {
    const expired = access.standIn.issue({ email: "grace.hall@example.com", expiresAt: 1 });
    const response = await gated().handle(
      request("/", { headers: [["Cookie", `CF_Authorization=${expired}`]] }),
    );
    expect(response.status).toBe(302);
  });
});
