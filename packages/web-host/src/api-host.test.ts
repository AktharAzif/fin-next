// spec 02 §2.2's front door, step by step, on the shared API host.
import { Readiness } from "@fin/server/health";
import type { FinEnv } from "@fin/server/http";
import { ConnectorPeers } from "@fin/server/ingress";
import { capture, randomProof } from "@fin/server/testing";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { type AccessResult, AccessVerifier } from "./access-jwt.ts";
import { type ApiHostOptions, type AppName, type AuthHook, createApiHost } from "./api-host.ts";

const CONNECTOR = "2001:db8::c1";
const NEIGHBOUR = "2001:db8::77";
const ORIGINS = {
  console: "https://console.example.net",
  admin: "https://staff.example.net",
  verify: "https://onboard.example.net",
  selfie: "https://selfie.example.net",
};
const DOCS = "https://docs.example.net";

class FakeVerifier extends AccessVerifier {
  result: AccessResult | "unavailable" = {
    ok: true,
    identity: { sub: "s", email: "a@example.com" },
  };
  override async verify(): Promise<AccessResult> {
    if (this.result === "unavailable") {
      const { AccessKeysUnavailable } = await import("./access-jwt.ts");
      throw new AccessKeysUnavailable();
    }
    return this.result;
  }
}

async function setup(
  app: AppName = "console",
  extra: Pick<Parameters<typeof createApiHost>[0], "auth" | "routes" | "uploads"> = {},
) {
  const captured = capture({ service: app });
  const roles = app === "verify" ? (["verify", "selfie"] as const) : ([app] as const);
  const proofs = Object.fromEntries(roles.map((role) => [role, [randomProof()]]));
  const origins = Object.fromEntries(roles.map((role) => [role, ORIGINS[role]]));
  const peers = new ConnectorPeers({
    services: ["cloudflared-public"],
    resolver: { resolveAll: async () => [{ address: CONNECTOR, family: 6 }] },
    clock: captured.clock,
  });
  await peers.start();
  const verifier = new FakeVerifier({
    team: "fin-team",
    aud: "a".repeat(64),
    clock: captured.clock,
  });
  const host = createApiHost({
    app,
    environment: "staging",
    release: "0123456789abcdef0123456789abcdef01234567",
    docsOrigin: DOCS,
    ingress: { origins, connectorServices: ["cloudflared-public"], proofs },
    telemetry: captured.telemetry,
    reporter: captured.reporter,
    clock: captured.clock,
    readiness: new Readiness(),
    peers,
    ...(app === "admin" ? { accessVerifier: verifier } : {}),
    ...extra,
  });
  const send = (
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      /** Bytes carry no implied Content-Type, as a string body would (text/plain). */
      body?: string | Uint8Array;
      peer?: string;
      role?: keyof typeof ORIGINS;
      proof?: string | null;
    } = {},
  ) => {
    const role = init.role ?? roles[0];
    const hostName = new URL(ORIGINS[role]).host;
    const headers: Record<string, string> = { host: hostName, ...init.headers };
    const proof = init.proof === undefined ? proofs[role]?.[0] : init.proof;
    if (proof !== null && proof !== undefined) headers["fin-ingress-proof"] = proof;
    if (
      init.body !== undefined &&
      headers["content-length"] === undefined &&
      headers["transfer-encoding"] === undefined
    ) {
      headers["content-length"] = String(
        typeof init.body === "string" ? Buffer.byteLength(init.body) : init.body.byteLength,
      );
    }
    return host.request(
      `http://${hostName}${path}`,
      {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
      },
      { incoming: { socket: { remoteAddress: init.peer ?? CONNECTOR }, url: path } } as never,
    );
  };
  const post = (
    path: string,
    headers: Record<string, string>,
    body = "{}",
    role?: keyof typeof ORIGINS,
  ) => send(path, { method: "POST", headers, body, ...(role ? { role } : {}) });
  const good = (role: keyof typeof ORIGINS = roles[0]) => ({
    origin: ORIGINS[role],
    "sec-fetch-site": "same-origin",
    "x-fin-app": app,
    "content-type": "application/json",
  });
  return { captured, send, post, good, verifier, proofs };
}

describe("createApiHost", () => {
  it("answers GET /api/health with the API headers and no CORS header", async () => {
    const { send } = await setup();
    const res = await send("/api/health", { headers: { origin: "https://evil.example.com" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("fin-release")).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains",
    );
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("request-id")).toMatch(/^req_[0-9a-hjkmnp-tv-z]{26}$/);
    expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
  });

  it("step 1: private health is 404 through a tunnel", async () => {
    const { send } = await setup();
    expect((await send("/healthz")).status).toBe(404);
    expect((await send("/readyz", { proof: null, peer: NEIGHBOUR })).status).toBe(404);
  });

  it("step 2: a neighbour, or a connector without the proof, gets 403 and ingress.untrusted_peer", async () => {
    const { send, captured } = await setup();
    expect((await send("/api/health", { peer: NEIGHBOUR })).status).toBe(403);
    expect((await send("/api/health", { proof: null })).status).toBe(403);
    expect((await send("/api/health", { proof: randomProof() })).status).toBe(403);
    expect(captured.events("ingress.untrusted_peer")).toHaveLength(3);
  });

  it("step 3: a body over 256 KB is 413", async () => {
    const { post, good } = await setup();
    const res = await post("/api/anything", good(), "x".repeat(256 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("payload_too_large");
  });

  it("step 2 runs before step 3: a neighbour's oversized body is refused at the ingress check", async () => {
    const { send, good, captured } = await setup();
    const res = await send("/api/anything", {
      method: "POST",
      headers: good(),
      body: "x".repeat(256 * 1024 + 1),
      peer: NEIGHBOUR,
    });
    expect(res.status).toBe(403);
    expect(captured.events("ingress.untrusted_peer")).toHaveLength(1);
  });

  it("step 5: nothing outside /api/ exists, /api without a slash included", async () => {
    const { send } = await setup();
    for (const path of ["/", "/api", "/sign-in", "/assets/a.js", "/apix"]) {
      const res = await send(path);
      expect(res.status, path).toBe(404);
      expect(((await res.json()) as { type: string }).type).toBe(`${DOCS}/errors/not_found`);
    }
  });

  it("step 5 runs before step 6: an unsafe request outside /api/ is 404 and never gated", async () => {
    const { post, good, captured } = await setup();
    const crossSite = {
      ...good(),
      origin: "https://evil.example.com",
      "sec-fetch-site": "cross-site",
    };
    for (const path of ["/", "/api", "/sign-in"]) {
      expect((await post(path, crossSite)).status, path).toBe(404);
    }
    expect(captured.events("csrf.refused")).toEqual([]);
  });

  it("step 6, check 4: a body-less POST or DELETE needs no content type; Content-Length and Transfer-Encoding say whether a body came", async () => {
    const seen: string[] = [];
    const { send, captured } = await setup("console", {
      routes: (api) => {
        api.post("/items/:id/archive", (c) => {
          seen.push("archive");
          return c.json({ archived: c.req.param("id") }, 200);
        });
        api.delete("/items/:id", (c) => {
          seen.push("delete");
          return c.body(null, 204);
        });
      },
    });
    const bare = {
      origin: ORIGINS.console,
      "sec-fetch-site": "same-origin",
      "x-fin-app": "console",
    };
    const archive = "/api/items/itm_1/archive";
    // No body: no Content-Length at all, or Content-Length 0; no content type, or JSON's.
    expect((await send(archive, { method: "POST", headers: bare })).status).toBe(200);
    expect((await send("/api/items/itm_1", { method: "DELETE", headers: bare })).status).toBe(204);
    expect(
      (await send(archive, { method: "POST", headers: { ...bare, "content-length": "0" } })).status,
    ).toBe(200);
    expect(
      (
        await send(archive, {
          method: "POST",
          headers: { ...bare, "content-length": "0", "content-type": "application/json" },
        })
      ).status,
    ).toBe(200);
    expect(seen).toEqual(["archive", "delete", "archive", "archive"]);
    // Refused: a body-less request with another type, and a body (by length or chunked) with none.
    const bytes = new TextEncoder().encode("{}");
    const refused: [Record<string, string>, Uint8Array | undefined][] = [
      [{ ...bare, "content-length": "0", "content-type": "text/plain" }, undefined],
      [bare, bytes],
      [{ ...bare, "transfer-encoding": "chunked" }, bytes],
    ];
    for (const [headers, body] of refused) {
      const res = await send(archive, {
        method: "POST",
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json()).toMatchObject({ code: "invalid_origin", reason: "content_type" });
    }
    expect(seen).toHaveLength(4);
    expect(captured.events("csrf.refused").map((l) => [l.reason, l.route])).toEqual(
      refused.map(() => ["content_type", "/api/items/:id/archive"]),
    );
  });

  it("step 6: a cross-site POST, a POST without X-Fin-App and a text/plain POST get 403 invalid_origin", async () => {
    const { post, good, captured } = await setup();
    const cases: [Record<string, string>, string][] = [
      [
        { ...good(), origin: "https://evil.example.com", "sec-fetch-site": "cross-site" },
        "origin_mismatch",
      ],
      [{ ...good(), origin: "" }, "origin_missing"],
      [{ ...good(), "sec-fetch-site": "same-site" }, "fetch_site"],
      [
        {
          origin: ORIGINS.console,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        "app_header",
      ],
      [{ ...good(), "content-type": "text/plain" }, "content_type"],
    ];
    for (const [headers, reason] of cases) {
      const res = await post("/api/auth/sign-in/email-otp", headers);
      expect(res.status, reason).toBe(403);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        type: `${DOCS}/errors/invalid_origin`,
        status: 403,
        code: "invalid_origin",
        reason,
      });
      expect(body.request_id).toMatch(/^req_/);
    }
    expect(captured.events("csrf.refused").map((l) => [l.reason, l.route])).toEqual(
      cases.map(([, reason]) => [reason, "/api/auth/*"]),
    );
    const lines = captured.events("request").filter((l) => l.status === 403);
    expect(lines.map((l) => l.reason)).toEqual(cases.map(([, reason]) => `origin_gate.${reason}`));
    expect(lines.every((l) => l.outcome === "refused")).toBe(true);
  });

  it("step 7: /api/auth/* reaches only the allowlist; anything unlisted is an empty 404", async () => {
    const seen: string[] = [];
    const auth: AuthHook = {
      realm: "developer",
      classify: (method, path) =>
        method === "POST" && path === "/sign-in/email-otp"
          ? "allow"
          : path === "/sign-up/email"
            ? "blocked"
            : "unlisted",
      handle: (c) => {
        seen.push(new URL(c.req.url).pathname);
        return c.json({ ok: true });
      },
    };
    const { post, good, send, captured } = await setup("console", { auth });
    expect((await post("/api/auth/sign-in/email-otp", good())).status).toBe(200);
    for (const path of [
      "/api/auth/sign-up/email",
      "/api/auth//sign-in/email-otp",
      "/api/auth/nothing",
    ]) {
      const res = await post(path, good());
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe("");
    }
    // An encoded alias of an allowed path never gets as far: the ingress check refuses a target
    // that is not canonical (400) before the allowlist runs (@fin/server's ingress check).
    expect((await post("/api/auth/sign-in/%65mail-otp", good())).status).toBe(400);
    expect((await send("/api/auth/sign-in/email-otp")).status).toBe(404);
    expect(seen).toEqual(["/api/auth/sign-in/email-otp"]);
    expect(captured.events("auth.endpoint_blocked").map((l) => l.class)).toEqual([
      "blocked",
      "unlisted",
      "unlisted",
      "unlisted",
    ]);
  });

  it("step 7 without a hook: every /api/auth/* path is 404", async () => {
    const { post, good } = await setup();
    expect((await post("/api/auth/sign-in/email-otp", good())).status).toBe(404);
  });

  it("step 8: the app's JSON routes, under /api, after the gate; uploads only where named", async () => {
    const { post, good, send } = await setup("console", {
      routes: (api) => {
        api.post("/items", async (c) => c.json(await c.req.json(), 201));
        api.post("/items/:id/document", (c) => c.json({ uploaded: c.req.param("id") }, 201));
        api.get("/boom", () => {
          throw new Error("someone@example.com");
        });
      },
      uploads: ["POST /api/items/:id/document"],
    });
    const created = await post("/api/items", good(), JSON.stringify({ a: 1 }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ a: 1 });
    const multipart = { ...good(), "content-type": "multipart/form-data; boundary=x" };
    expect((await post("/api/items/itm_1/document", multipart, "--x--")).status).toBe(201);
    expect((await post("/api/items", multipart, "--x--")).status).toBe(403);
    const boom = await send("/api/boom");
    expect(boom.status).toBe(500);
    const problem = (await boom.json()) as Record<string, unknown>;
    expect(problem).toMatchObject({ code: "internal", status: 500 });
    expect(JSON.stringify(problem)).not.toContain("example.com");
    expect((await send("/api/missing")).status).toBe(404);
  });

  it("step 6 runs before step 8: a cross-site POST to an app route never reaches it", async () => {
    const seen: string[] = [];
    const { post, good } = await setup("console", {
      routes: (api) => {
        api.post("/items", (c) => {
          seen.push("items");
          return c.json({}, 201);
        });
      },
    });
    const crossSite = {
      ...good(),
      origin: "https://evil.example.com",
      "sec-fetch-site": "cross-site",
    };
    expect((await post("/api/items", crossSite)).status).toBe(403);
    expect(seen).toEqual([]);
  });

  describe("check 4's upload exemption follows the route that runs", () => {
    const multipart = (good: () => Record<string, string>) => ({
      ...good(),
      "content-type": "multipart/form-data; boundary=x",
    });
    const crossSite = (good: () => Record<string, string>) => ({
      ...good(),
      origin: "https://evil.example.com",
      "sec-fetch-site": "cross-site",
    });

    it("a static route registered before an overlapping upload route gets no multipart body", async () => {
      const seen: string[] = [];
      const { post, good, captured } = await setup("console", {
        routes: (api) => {
          api.post("/files/new", (c) => {
            seen.push("new");
            return c.json({}, 201);
          });
          api.post("/files/:id", (c) => {
            seen.push("upload");
            return c.json({}, 201);
          });
        },
        uploads: ["POST /api/files/:id"],
      });
      const refused = await post("/api/files/new", multipart(good), "--x--");
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        code: "invalid_origin",
        reason: "content_type",
      });
      expect((await post("/api/files/new", crossSite(good))).status).toBe(403);
      expect((await post("/api/files/fil_1", multipart(good), "--x--")).status).toBe(201);
      expect((await post("/api/files/new", good())).status).toBe(201);
      expect(seen).toEqual(["upload", "new"]);
      expect(captured.events("csrf.refused").map((l) => [l.reason, l.route])).toEqual([
        ["content_type", "/api/files/new"],
        ["origin_mismatch", "/api/files/new"],
      ]);
      expect(captured.events("request").map((l) => [l.status, l.route])).toEqual([
        [403, "/api/files/new"],
        [403, "/api/files/new"],
        [201, "/api/files/:id"],
        [201, "/api/files/new"],
      ]);
    });

    it("an upload route registered first runs for the static path, and keeps its exemption", async () => {
      const seen: string[] = [];
      const { post, good, captured } = await setup("console", {
        routes: (api) => {
          api.post("/files/:id", (c) => {
            seen.push("upload");
            return c.json({}, 201);
          });
          api.post("/files/new", (c) => {
            seen.push("new");
            return c.json({}, 201);
          });
        },
        uploads: ["POST /api/files/:id"],
      });
      expect((await post("/api/files/new", multipart(good), "--x--")).status).toBe(201);
      expect(seen).toEqual(["upload"]);
      expect(captured.events("request").map((l) => l.route)).toEqual(["/api/files/:id"]);
    });

    it("an upload pattern that matches the path does not help the route that runs", async () => {
      const seen: string[] = [];
      const { post, good, captured } = await setup("console", {
        routes: (api) => {
          api.post("/files/:id", (c) => {
            seen.push("param");
            return c.json({}, 201);
          });
          api.post("/files/new", (c) => {
            seen.push("upload");
            return c.json({}, 201);
          });
        },
        uploads: ["POST /api/files/new"],
      });
      expect((await post("/api/files/new", multipart(good), "--x--")).status).toBe(403);
      expect((await post("/api/files/new", crossSite(good))).status).toBe(403);
      expect(seen).toEqual([]);
      expect(captured.events("csrf.refused").map((l) => [l.reason, l.route])).toEqual([
        ["content_type", "/api/files/:id"],
        ["origin_mismatch", "/api/files/:id"],
      ]);
    });

    it("Better Auth never gets a multipart body, even where an upload pattern overlaps /api/auth/*", async () => {
      const seen: string[] = [];
      const auth: AuthHook = {
        realm: "developer",
        classify: () => "allow",
        handle: (c) => {
          seen.push("auth");
          return c.json({ ok: true });
        },
      };
      const { post, good, captured } = await setup("console", {
        auth,
        routes: (api) => {
          api.post("/:area/:id", (c) => c.json({}, 201));
        },
        uploads: ["POST /api/:area/:id"],
      });
      const res = await post("/api/auth/sign-in", multipart(good), "--x--");
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ reason: "content_type" });
      expect(seen).toEqual([]);
      expect(captured.events("csrf.refused").map((l) => l.route)).toEqual(["/api/auth/*"]);
      expect((await post("/api/items/itm_1", multipart(good), "--x--")).status).toBe(201);
    });

    it("an upload route's own chain keeps the exemption; an entry registered without a method does not", async () => {
      const { post, good } = await setup("console", {
        routes: (api) => {
          api.post(
            "/docs/:id",
            async (_c, next) => {
              await next();
            },
            (c) => c.json({}, 201),
          );
          api.use("/media/*", async (_c, next) => {
            await next();
          });
          api.post("/media/:id", (c) => c.json({}, 201));
        },
        uploads: ["POST /api/docs/:id", "POST /api/media/:id"],
      });
      expect((await post("/api/docs/doc_1", multipart(good), "--x--")).status).toBe(201);
      expect((await post("/api/media/med_1", multipart(good), "--x--")).status).toBe(403);
      expect((await post("/api/media/med_1", good())).status).toBe(201);
    });

    it("refuses to start when an upload names no POST, PUT or PATCH route the app registers", async () => {
      const routes: ApiHostOptions["routes"] = (api) => {
        api.post("/items/:id/document", (c) => c.json({}, 201));
        api.get("/items/:id", (c) => c.json({}));
      };
      for (const entry of [
        "POST /api/items/:id/doc",
        "POST /api/items/itm_1/document",
        "POST /items/:id/document",
        "GET /api/items/:id",
        "ALL /api/items/:id/document",
        "post /api/items/:id/document",
      ]) {
        await expect(setup("console", { routes, uploads: [entry] }), entry).rejects.toThrow(
          /names no POST, PUT or PATCH route/,
        );
      }
      await expect(
        setup("console", { routes, uploads: ["POST /api/items/:id/document"] }),
      ).resolves.toBeDefined();
    });
  });

  describe("the route label names the route, never the app's middleware in front of it", () => {
    const crossSite = (good: () => Record<string, string>) => ({
      ...good(),
      origin: "https://evil.example.com",
      "sec-fetch-site": "cross-site",
    });
    const passthrough: MiddlewareHandler<FinEnv> = async (_c, next) => {
      await next();
    };
    const routeLines = (captured: { events(name: string): Record<string, unknown>[] }) =>
      captured.events("request").map((l) => [l.status, l.route]);

    it("a path-scoped middleware: the gate's refusal and the request lines name the route", async () => {
      const { post, good, captured } = await setup("console", {
        routes: (api) => {
          api.use("/items/*", passthrough);
          api.post("/items/:id", (c) => c.json({}, 201));
        },
      });
      expect((await post("/api/items/itm_1", crossSite(good))).status).toBe(403);
      expect((await post("/api/items/itm_1", good())).status).toBe(201);
      expect(captured.events("csrf.refused").map((l) => [l.reason, l.route])).toEqual([
        ["origin_mismatch", "/api/items/:id"],
      ]);
      expect(routeLines(captured)).toEqual([
        [403, "/api/items/:id"],
        [201, "/api/items/:id"],
      ]);
    });

    it("an app-wide middleware: a 2xx, a gate refusal and every earlier refusal name the route", async () => {
      const seen: string[] = [];
      const { send, post, good, captured } = await setup("console", {
        routes: (api) => {
          api.use(async (_c, next) => {
            seen.push("session");
            await next();
          });
          api.post("/files/:id", (c) => c.json({}, 201));
          api.post("/items", (c) => c.json({}, 201));
        },
      });
      expect((await post("/api/items", good())).status).toBe(201);
      expect((await post("/api/items", crossSite(good))).status).toBe(403);
      expect((await post("/api/items", good(), "x".repeat(256 * 1024 + 1))).status).toBe(413);
      expect(
        (await send("/api/items", { method: "POST", headers: good(), body: "{}", peer: NEIGHBOUR }))
          .status,
      ).toBe(403);
      expect(seen).toEqual(["session"]);
      expect(captured.events("csrf.refused").map((l) => [l.reason, l.route])).toEqual([
        ["origin_mismatch", "/api/items"],
      ]);
      expect(routeLines(captured)).toEqual([
        [201, "/api/items"],
        [403, "/api/items"],
        [413, "/api/items"],
        [403, "/api/items"],
      ]);
    });

    it("a middleware that answers: the request line names the route it stands in front of", async () => {
      const { send, post, good, captured } = await setup("console", {
        routes: (api) => {
          api.use("/items/*", async (c) => c.json({ error: "unauthenticated" }, 401));
          api.post("/items/:id/archive", (c) => c.json({}, 200));
          api.get("/items/:id", (c) => c.json({}));
        },
      });
      expect((await post("/api/items/itm_1/archive", good())).status).toBe(401);
      expect((await send("/api/items/itm_1")).status).toBe(401);
      expect(routeLines(captured)).toEqual([
        [401, "/api/items/:id/archive"],
        [401, "/api/items/:id"],
      ]);
    });

    it("Fin Admin's Access refusal names the route behind the app's middleware", async () => {
      const { post, good, verifier, captured } = await setup("admin", {
        routes: (api) => {
          api.use(passthrough);
          api.post("/staff", (c) => c.json({}, 201));
        },
      });
      verifier.result = { ok: false, reason: "aud" };
      expect((await post("/api/staff", good())).status).toBe(401);
      expect(routeLines(captured)).toEqual([[401, "/api/staff"]]);
    });

    it("/api/auth/* keeps its own label behind an app-wide middleware and over an overlapping route", async () => {
      const { post, good, captured } = await setup("console", {
        routes: (api) => {
          api.use(passthrough);
          api.post("/:area/:id", (c) => c.json({}, 201));
        },
      });
      expect((await post("/api/auth/sign-in", crossSite(good))).status).toBe(403);
      expect((await post("/api/auth/sign-in", good())).status).toBe(404);
      expect((await post("/api/items/itm_1", crossSite(good))).status).toBe(403);
      expect(captured.events("csrf.refused").map((l) => l.route)).toEqual([
        "/api/auth/*",
        "/api/:area/:id",
      ]);
      expect(routeLines(captured)).toEqual([
        [403, "/api/auth/*"],
        [404, "/api/auth/*"],
        [403, "/api/:area/:id"],
      ]);
    });

    it("a path only the app's middleware matches is named by the middleware's pattern, before and after the gate", async () => {
      const { send, post, good, captured } = await setup("console", {
        routes: (api) => {
          api.use("/items/*", passthrough);
          api.post("/items", (c) => c.json({}, 201));
        },
      });
      expect((await post("/api/items/nothing", crossSite(good))).status).toBe(403);
      expect((await post("/api/items/nothing", good())).status).toBe(404);
      expect((await send("/api/items/nothing")).status).toBe(404);
      expect((await send("/api/other")).status).toBe(404);
      expect(captured.events("csrf.refused").map((l) => l.route)).toEqual(["/api/items/*"]);
      expect(routeLines(captured)).toEqual([
        [403, "/api/items/*"],
        [404, "/api/items/*"],
        [404, "/api/items/*"],
        [404, "unmatched"],
      ]);
    });

    it("a route that hands the request on: the request line names the route that answered", async () => {
      const { post, good, captured } = await setup("console", {
        routes: (api) => {
          api.post("/files/new", passthrough);
          api.use("/files/*", passthrough);
          api.post("/files/:id", (c) => c.json({}, 201));
        },
      });
      expect((await post("/api/files/new", good())).status).toBe(201);
      expect((await post("/api/files/new", crossSite(good))).status).toBe(403);
      expect(captured.events("csrf.refused").map((l) => l.route)).toEqual(["/api/files/new"]);
      expect(routeLines(captured)).toEqual([
        [201, "/api/files/:id"],
        [403, "/api/files/new"],
      ]);
    });

    it("a body refused at a middleware in front of an upload route names the upload route", async () => {
      const { post, good, captured } = await setup("console", {
        routes: (api) => {
          api.use("/media/*", passthrough);
          api.post("/media/:id", (c) => c.json({}, 201));
        },
        uploads: ["POST /api/media/:id"],
      });
      const multipart = { ...good(), "content-type": "multipart/form-data; boundary=x" };
      expect((await post("/api/media/med_1", multipart, "--x--")).status).toBe(403);
      expect(captured.events("csrf.refused").map((l) => [l.reason, l.route])).toEqual([
        ["content_type", "/api/media/:id"],
      ]);
      expect(routeLines(captured)).toEqual([[403, "/api/media/:id"]]);
    });
  });

  it("verify answers both of its hosts, each with its own origin and proof, and runs no Better Auth", async () => {
    const { post, good, send } = await setup("verify");
    expect((await send("/api/health", { role: "selfie" })).status).toBe(200);
    expect((await send("/api/health", { role: "selfie" })).headers.get("referrer-policy")).toBe(
      "no-referrer",
    );
    expect((await post("/api/link/open", good("selfie"), "{}", "selfie")).status).toBe(404);
    const crossHost = { ...good("selfie"), origin: ORIGINS.verify };
    expect((await post("/api/link/open", crossHost, "{}", "selfie")).status).toBe(403);
    await expect(
      setup("verify", {
        auth: { realm: "developer", classify: () => "allow", handle: (c) => c.text("x") },
      }),
    ).rejects.toThrow(/no Better Auth/);
  });

  it("step 4: Fin Admin checks the Access token on every request, after the body limit and before the path check and the gate", async () => {
    const { send, post, good, verifier, captured } = await setup("admin");
    expect((await send("/api/health")).status).toBe(200);
    expect((await send("/sign-in")).status).toBe(404);
    verifier.result = { ok: false, reason: "aud" };
    const refused = await send("/api/health");
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { code: string }).code).toBe("access_required");
    expect(captured.events("access.jwt_refused")[0]).toMatchObject({ reason: "aud" });
    // Before step 5: a path outside /api/ is 401, not 404.
    for (const path of ["/sign-in", "/", "/assets/a.js"]) {
      expect((await send(path)).status, path).toBe(401);
    }
    // Before step 6: a cross-site text/plain POST without X-Fin-App is 401, and the gate never runs.
    const crossSite = await post("/api/staff", {
      origin: "https://evil.example.com",
      "sec-fetch-site": "cross-site",
      "content-type": "text/plain",
    });
    expect(crossSite.status).toBe(401);
    expect(((await crossSite.json()) as { code: string }).code).toBe("access_required");
    expect((await post("/sign-in", { origin: "https://evil.example.com" })).status).toBe(401);
    expect((await post("/api/auth/sign-in/email-otp", good())).status).toBe(401);
    expect(captured.events("csrf.refused")).toEqual([]);
    // After step 3: an oversized body is 413 before the token is read.
    const jwtRefusals = captured.events("access.jwt_refused").length;
    expect((await post("/api/staff", good(), "x".repeat(256 * 1024 + 1))).status).toBe(413);
    expect(captured.events("access.jwt_refused")).toHaveLength(jwtRefusals);
    verifier.result = "unavailable";
    const down = await send("/api/health");
    expect(down.status).toBe(503);
    expect(((await down.json()) as { code: string }).code).toBe("access_unavailable");
    expect(captured.events("access.keys_unavailable")).toHaveLength(1);
  });
});
