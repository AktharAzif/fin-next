// spec 02 §2.2's front door, step by step, on the shared API host.
import { Readiness } from "@fin/server/health";
import { ConnectorPeers } from "@fin/server/ingress";
import { capture, randomProof } from "@fin/server/testing";
import { describe, expect, it } from "vitest";
import { type AccessResult, AccessVerifier } from "./access-jwt.ts";
import { type AppName, type AuthHook, createApiHost } from "./api-host.ts";

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
    resolveAll: async () => [{ address: CONNECTOR, family: 6 }],
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
      body?: string;
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
    if (init.body !== undefined && headers["content-length"] === undefined) {
      headers["content-length"] = String(Buffer.byteLength(init.body));
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

  it("step 5: nothing outside /api/ exists, /api without a slash included", async () => {
    const { send } = await setup();
    for (const path of ["/", "/api", "/sign-in", "/assets/a.js", "/apix"]) {
      const res = await send(path);
      expect(res.status, path).toBe(404);
      expect(((await res.json()) as { type: string }).type).toBe(`${DOCS}/errors/not_found`);
    }
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
      "/api/auth/sign-in/%65mail-otp",
      "/api/auth//sign-in/email-otp",
      "/api/auth/nothing",
    ]) {
      const res = await post(path, good());
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe("");
    }
    expect((await send("/api/auth/sign-in/email-otp")).status).toBe(404);
    expect(seen).toEqual(["/api/auth/sign-in/email-otp"]);
    expect(captured.events("auth.endpoint_blocked").map((l) => l.class)).toEqual([
      "blocked",
      "unlisted",
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

  it("step 4: Fin Admin checks the Access token on every request, before the gate", async () => {
    const { send, verifier, captured } = await setup("admin");
    expect((await send("/api/health")).status).toBe(200);
    verifier.result = { ok: false, reason: "aud" };
    const refused = await send("/api/health");
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { code: string }).code).toBe("access_required");
    expect(captured.events("access.jwt_refused")[0]).toMatchObject({ reason: "aud" });
    verifier.result = "unavailable";
    const down = await send("/api/health");
    expect(down.status).toBe(503);
    expect(((await down.json()) as { code: string }).code).toBe("access_unavailable");
    expect(captured.events("access.keys_unavailable")).toHaveLength(1);
  });
});
