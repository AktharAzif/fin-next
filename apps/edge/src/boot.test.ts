// The edge booted on a real socket (spec 01 §4.5; spec 05 §2.1, §3.2, §3.3, §4.7): the private health
// and the plain-http refusal of Phase 0 (AC-P0-07, AC-P0-34), CORS for the docs origin only, and the
// key check against an in-memory store: a working key's `GET /v4/whoami`, every refusal the same 401
// apart from `request_id` (T05-08), the reason only in the request line, load shedding and the
// negative filter before any statement (T05-10), a docs-origin live key refused before any lookup
// (T05-42), the live gate (T05-12), both windows, "last used" after the answer and at most once a
// minute per key (T05-16), a key ID with no row answered the same 401s, then 429s with the same
// Retry-After, as one with a row, on one replica or two sharing a store, and the request line's
// preflight and docs facts. The real statements on Postgres 18 are edge.db.test.ts's.
import { newKey } from "@fin/keys";
import { bootApi, NEIGHBOUR_ADDRESS } from "@fin/web-host/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeStore, ORG, PEPPERS, SALT } from "../test/fake-store.ts";
import { defineEdgeService } from "./main.ts";

const HOST = "gateway.example.net";
const DOCS = "https://docs.example.net";
const HTTPS = { "cf-visitor": '{"scheme":"https"}', "cf-connecting-ip": "8.8.8.8" };
const ENV = {
  FIN_PUBLIC_ORIGIN: `https://${HOST}`,
  FIN_CONNECTOR_SERVICES: "cloudflared-public,cloudflared-public-b",
  FIN_KEY_SALT: "fin-ci-1",
};

const store = new FakeStore();
let api: Awaited<ReturnType<typeof bootApi>>;

beforeAll(async () => {
  api = await bootApi(
    defineEdgeService({ store, peppers: PEPPERS, shed: { addressBurst: 400, addressRate: 1 } }),
    { service: "edge", roles: ["api"], env: ENV },
  );
});

afterAll(async () => {
  await api.stop();
  expect(api.exits).toEqual([0]);
});

/** The key with its last checksum character changed. */
const flip = (key: string) => `${key.slice(0, 59)}${key.endsWith("0") ? "1" : "0"}`;
const bearer = (key: string) => ({ ...HTTPS, authorization: `Bearer ${key}` });
const whoami = (headers: Record<string, string>) =>
  api.send({ host: HOST, path: "/v4/whoami", headers });

function lastRequestLine(): Record<string, unknown> {
  const lines = api.stdout.filter((l) => l.event === "request");
  return lines.at(-1) as unknown as Record<string, unknown>;
}

describe("the edge's Phase 0 layers", () => {
  it("answers GET /health through the tunnel, and /readyz only privately", async () => {
    const res = await api.send({ host: HOST, path: "/health", headers: HTTPS });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect((await api.send({ host: HOST, path: "/readyz", headers: HTTPS })).status).toBe(404);
    expect(
      (await api.send({ host: "[::1]", path: "/readyz", from: NEIGHBOUR_ADDRESS, proof: null }))
        .status,
    ).toBe(200);
  });

  it("refuses plain http with 403 https_required", async () => {
    const res = await api.send({
      host: HOST,
      path: "/v4/whoami",
      headers: { "cf-visitor": '{"scheme":"http"}' },
    });
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ code: "https_required", title: "Call the API over https" });
    expect((await api.send({ host: HOST, path: "/health" })).status).toBe(403);
  });

  it("answers the docs origin's preflight, without credentials, and nobody else's", async () => {
    const preflight = await api.send({
      host: HOST,
      path: "/v4/whoami",
      method: "OPTIONS",
      headers: {
        ...HTTPS,
        origin: DOCS,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers).toMatchObject({
      "access-control-allow-origin": DOCS,
      "access-control-allow-methods": "GET, POST, PATCH, DELETE",
      "access-control-max-age": "7200",
    });
    expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();
    const refused = await api.send({
      host: HOST,
      path: "/v4/whoami",
      method: "OPTIONS",
      headers: {
        ...HTTPS,
        origin: "https://evil.example.com",
        "access-control-request-method": "GET",
      },
    });
    expect(Object.keys(refused.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
  });

  it("writes corsPreflight on a preflight's request line, and fromDocs for the docs origin", async () => {
    const preflight = (origin: string) =>
      api.send({
        host: HOST,
        path: "/v4/whoami",
        method: "OPTIONS",
        headers: { ...HTTPS, origin, "access-control-request-method": "GET" },
      });
    expect((await preflight(DOCS)).status).toBe(204);
    expect(lastRequestLine()).toMatchObject({
      method: "OPTIONS",
      status: 204,
      corsPreflight: true,
      fromDocs: true,
    });
    expect((await preflight("https://evil.example.com")).status).toBe(204);
    const refused = lastRequestLine();
    expect(refused).toMatchObject({ corsPreflight: true, reason: "cors_refused" });
    expect(refused).not.toHaveProperty("fromDocs");
    // A Try-it call refused before the key check is still a docs call, and no preflight.
    const unknown = await api.send({
      host: HOST,
      path: "/v4/customers",
      headers: { ...HTTPS, origin: DOCS },
    });
    expect(unknown.status).toBe(404);
    expect(lastRequestLine()).toMatchObject({ status: 404, fromDocs: true });
    expect(lastRequestLine()).not.toHaveProperty("corsPreflight");
  });

  it("refuses a neighbour at the ingress check", async () => {
    expect(
      (await api.send({ host: HOST, path: "/health", from: NEIGHBOUR_ADDRESS, headers: HTTPS }))
        .status,
    ).toBe(403);
  });

  it("refuses a body over 256 KB with 413 body_too_large", async () => {
    const res = await api.send({
      host: HOST,
      path: "/v4/whoami",
      method: "POST",
      headers: { ...HTTPS, "content-type": "application/json" },
      body: "x".repeat(256 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(res.json()).toMatchObject({ code: "body_too_large" });
  });
});

describe("the public API's answers", () => {
  it("carry Fin-Version, Request-Id, no-store and the security headers, and never Fin-Release", async () => {
    const res = await whoami(HTTPS);
    expect(res.headers["fin-version"]).toBe("2026-11-23");
    expect(res.headers["request-id"]).toMatch(/^req_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(res.headers["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers.vary).toContain("Origin");
    expect(res.headers["fin-release"]).toBeUndefined();
  });

  it("answer an RFC 9457 problem with the docs URL, the title, next_actor and the request ID", async () => {
    const res = await whoami(HTTPS);
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toBe("application/problem+json");
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(res.json()).toEqual({
      type: `${DOCS}/errors/unauthenticated`,
      title: "Send a valid API key",
      status: 401,
      detail:
        "Send a valid API key as `Authorization: Bearer fin_test_...` or `fin_live_...`. A key with an address allowlist works only from those addresses.",
      code: "unauthenticated",
      next_actor: "developer",
      request_id: res.headers["request-id"],
    });
  });

  it("answers an unknown /v4 route with 404 before reading any key, and an unknown Fin-Version with 400", async () => {
    const before = store.statements;
    const key = store.add("test", "rk");
    const missing = await api.send({ host: HOST, path: "/v4/customers", headers: bearer(key) });
    expect(missing.status).toBe(404);
    expect(missing.json()).toMatchObject({ code: "not_found" });
    expect((await api.send({ host: HOST, path: "/v3/whoami", headers: HTTPS })).status).toBe(404);
    const version = await whoami({ ...bearer(key), "fin-version": "2020-01-01" });
    expect(version.status).toBe(400);
    expect(version.json()).toMatchObject({ code: "api_version_unknown" });
    expect(store.statements).toBe(before);
  });
});

describe("the key check", () => {
  it("answers GET /v4/whoami for a working key, then writes 'last used' after the answer", async () => {
    const key = store.add("test", "rk");
    const id = key.slice(12, 22);
    const res = await whoami(bearer(key));
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      object: "api_key",
      id,
      livemode: false,
      kind: "restricted",
      scopes: ["customers:read", "events:read"],
      organization: ORG,
    });
    expect(res.headers.ratelimit).toBe('"key";r=599;t=17');
    expect(res.headers["ratelimit-policy"]).toBe('"key";q=600;w=60');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.touched).toContain(id);
    expect(lastRequestLine()).toMatchObject({
      route: "/v4/whoami",
      status: 200,
      actor: "api_key",
      outcome: "ok",
      keyId: id,
      orgId: ORG,
      mode: "sandbox",
      dbQueries: 2,
    });
    const full = store.add("test", "sk");
    expect((await whoami(bearer(full))).json()).toMatchObject({ kind: "secret", scopes: ["*"] });
  });

  it("refuses every bad key with the same 401 body apart from request_id, the reason only in the line", async () => {
    const past = new Date(Date.now() - 60_000);
    const cases: [string, Record<string, string>][] = [
      ["missing", HTTPS],
      ["malformed", bearer("fin_test_rk_nope")],
      ["checksum", bearer(flip(store.add("test", "rk")))],
      ["other_deployment", bearer(store.add("test", "rk", {}, "fin-stg-1"))],
      ["unknown", bearer(store.add("test", "rk", { id: "ZZZZZZZZZZ" }))],
      ["revoked", bearer(store.add("test", "rk", { revoked_at: past }))],
      ["expired", bearer(store.add("test", "rk", { expires_at: past }))],
      ["expired", bearer(store.add("test", "rk", { rolling_until: past }))],
      ["ip_not_allowed", bearer(store.add("test", "rk", { ip_allowlist: ["8.8.4.0/24"] }))],
      ["pepper_missing", bearer(store.add("test", "rk", { pepper_versions: [1, 4] }))],
    ];
    const bodies = new Set<string>();
    for (const [reason, headers] of cases) {
      const res = await whoami(headers);
      expect(res.status, reason).toBe(401);
      const body = res.json() as Record<string, unknown>;
      bodies.add(JSON.stringify({ ...body, request_id: "x" }));
      const line = lastRequestLine();
      if (reason === "checksum") expect(["checksum", "malformed"]).toContain(line.keyReason);
      else expect(line.keyReason, reason).toBe(reason);
      expect(line.outcome).toBe("refused");
      expect(JSON.stringify(line)).not.toContain("fin_test_rk_");
    }
    expect(bodies.size).toBe(1);
    expect(api.stdout.some((l) => l.event === "key.pepper_missing")).toBe(true);
  });

  it("refuses a key found not to exist without a statement once its address's window is full (the negative filter)", async () => {
    const key = store.add("test", "rk");
    store.records.delete(key.slice(12, 22));
    const from = (k: string) => ({ ...bearer(k), "cf-connecting-ip": "8.8.6.6" });
    // Until the window in Postgres is full, each refusal reaches the store, as any refused key's does.
    let before = store.statements;
    for (let i = 0; i < 30; i++) expect((await whoami(from(key))).status).toBe(401);
    expect(store.statements - before).toBe(60);
    expect((await whoami(from(key))).status).toBe(429);
    // Then a flood of the same key ID leaves the statement counter flat (T05-10).
    before = store.statements;
    for (let i = 0; i < 20; i++) {
      const res = await whoami(from(key));
      expect(res.status).toBe(429);
      expect(res.json()).toMatchObject({ violated_policies: ["refused_keys"] });
      expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(17);
    }
    expect(store.statements).toBe(before);
    // Only a key ID found not to exist is answered so: a refused key with a row from the same
    // address is still looked up and counted, and a working key never meets the window.
    const revoked = store.add("test", "rk", { revoked_at: new Date() });
    expect((await whoami(from(revoked))).status).toBe(429);
    expect(store.statements - before).toBe(2);
    expect((await whoami(from(store.add("test", "rk")))).status).toBe(200);
  });

  it("refuses a live key, a malformed one and another deployment's from the docs origin before any lookup", async () => {
    const before = store.statements;
    for (const key of [
      store.add("live", "rk", { org_live_status: "enabled" }),
      "garbage",
      store.add("test", "rk", {}, "fin-prod-1"),
    ]) {
      const res = await whoami({ ...bearer(key), origin: DOCS });
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({ code: "sandbox_key_required" });
      expect(res.headers["access-control-allow-origin"]).toBe(DOCS);
    }
    expect(store.statements).toBe(before);
    const sandbox = await whoami({ ...bearer(store.add("test", "rk")), origin: DOCS });
    expect(sandbox.status).toBe(200);
    const noKey = await whoami({ ...HTTPS, origin: DOCS });
    expect(noKey.json()).toMatchObject({
      detail: expect.stringContaining("Try it calls from your browser's address."),
    });
  });

  it("gates a live key on go-live, a pause and the live_keys switch, and leaves Sandbox keys alone", async () => {
    const notLive = await whoami(bearer(store.add("live", "rk")));
    expect(notLive.status).toBe(403);
    expect(notLive.json()).toMatchObject({ code: "live_not_enabled" });
    const paused = await whoami(bearer(store.add("live", "rk", { org_live_status: "paused" })));
    expect(paused.json()).toMatchObject({ code: "live_paused" });
    const enabled = store.add("live", "rk", { org_live_status: "enabled" });
    expect((await whoami(bearer(enabled))).json()).toMatchObject({ livemode: true });
    store.liveKeysOn = true;
    const stopped = await whoami(bearer(enabled));
    expect(stopped.status).toBe(503);
    expect(stopped.json()).toMatchObject({ code: "temporarily_unavailable" });
    expect(stopped.headers["retry-after"]).toBe("5");
    expect((await whoami(bearer(store.add("test", "rk")))).status).toBe(200);
    store.liveKeysOn = false;
  });

  it("answers 429 past the address's refused-key window, and past the key's 600 calls", async () => {
    const revoked = store.add("test", "rk", { revoked_at: new Date() });
    const headers = { ...bearer(revoked), "cf-connecting-ip": "8.8.2.2" };
    let last = await whoami(headers);
    for (let i = 0; i < 31; i++) last = await whoami(headers);
    expect(last.status).toBe(429);
    expect(last.json()).toMatchObject({
      code: "rate_limited",
      violated_policies: ["refused_keys"],
    });
    expect(last.headers["retry-after"]).toBe("17");
    const busy = store.add("test", "rk");
    store.windows.set(`edge:key:${busy.slice(12, 22)}`, 600);
    const over = await whoami(bearer(busy));
    expect(over.status).toBe(429);
    expect(over.json()).toMatchObject({ violated_policies: ["key"] });
  });

  it("refuses with 503 when the statement fails, never letting a key through", async () => {
    store.failing = true;
    const res = await whoami(bearer(store.add("test", "rk")));
    store.failing = false;
    expect(res.status).toBe(503);
    expect(res.json()).toMatchObject({ code: "temporarily_unavailable" });
    expect(api.stdout.some((l) => l.event === "key.lookup_failed")).toBe(true);
  });
});

describe("load shedding", () => {
  it("sheds an address past its bucket before any statement, with Retry-After: 1", async () => {
    const shedApi = await bootApi(
      defineEdgeService({ store, peppers: PEPPERS, shed: { addressBurst: 3, addressRate: 1 } }),
      { service: "edge", roles: ["api"], env: ENV },
    );
    try {
      const before = store.statements;
      const key = store.add("test", "rk");
      store.records.delete(key.slice(12, 22));
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) {
        const res = await shedApi.send({
          host: HOST,
          path: "/v4/whoami",
          headers: { ...bearer(key), "cf-connecting-ip": "8.8.3.3" },
        });
        statuses.push(res.status);
        if (res.status === 429) {
          expect(res.headers["retry-after"]).toBe("1");
          expect(res.json()).not.toHaveProperty("violated_policies");
        }
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(6);
      // Only the requests the bucket let through reached the store (a lookup and a count each); it
      // shed the rest before any statement.
      expect(store.statements - before).toBe(2 * statuses.filter((s) => s === 401).length);
      const line = shedApi.stdout.filter((l) => l.event === "request").at(-1) as unknown as Record<
        string,
        unknown
      >;
      expect(line.outcome).toBe("shed");
    } finally {
      await shedApi.stop();
    }
  });
});

describe("on a clock the test moves, two replicas sharing one store", () => {
  let now = Date.parse("2026-11-22T10:00:01.000Z");
  const clock = { now: () => now };
  // The store's windows are fixed minutes of the same clock, as Postgres's are of its own.
  const own = new FakeStore(clock);
  const replicas: Awaited<ReturnType<typeof bootApi>>[] = [];

  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      replicas.push(
        await bootApi(
          defineEdgeService({
            store: own,
            peppers: PEPPERS,
            clock,
            shed: { addressBurst: 400, addressRate: 1 },
          }),
          { service: "edge", roles: ["api"], env: ENV },
        ),
      );
    }
  });

  afterAll(async () => {
    for (const replica of replicas) await replica.stop();
  });

  const replica = (i: number) => replicas[i] as Awaited<ReturnType<typeof bootApi>>;
  const call = (key: string, ip = "8.8.8.8", on = 0) =>
    replica(on).send({
      host: HOST,
      path: "/v4/whoami",
      headers: { ...HTTPS, "cf-connecting-ip": ip, authorization: `Bearer ${key}` },
    });
  /** Lets the work registered after each answer run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  /** `count` calls from `ip`, the first `spread` replicas taking turns: each status, a 429's Retry-After. */
  const answers = async (key: string, ip: string, count: number, spread: number) => {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const res = await call(key, ip, i % spread);
      out.push(res.status === 429 ? `429 ${res.headers["retry-after"]}` : String(res.status));
    }
    return out;
  };
  const lastLine = (on: number) =>
    replica(on)
      .stdout.filter((l) => l.event === "request")
      .at(-1) as unknown as Record<string, unknown>;
  /** A wrong secret for a key ID with a row, and a key ID with none. */
  const pair = () => {
    const existing = own.add("test", "rk");
    return {
      withRow: newKey("test", "rk", SALT, undefined, existing.slice(12, 22)).key,
      noRow: newKey("test", "rk", SALT).key,
    };
  };

  it("touches 'last used' once a minute per key, not on every request", async () => {
    const key = own.add("test", "rk");
    const id = key.slice(12, 22);
    for (let i = 0; i < 3; i++) expect((await call(key)).status).toBe(200);
    await settle();
    expect(own.touched.filter((t) => t === id)).toHaveLength(1);
    now += 60_000;
    expect((await call(key)).status).toBe(200);
    await settle();
    expect(own.touched.filter((t) => t === id)).toHaveLength(2);
  });

  it.each([
    [1, "one replica"],
    [2, "two replicas taking turns"],
  ])(
    "answers a key ID with no row the same 401s, then 429s, as a key ID with a row (%i: %s)",
    async (spread) => {
      const keys = pair();
      const withRow = await answers(keys.withRow, `8.8.9.${spread}`, 40, spread);
      const before = own.statements;
      const withoutRow = await answers(keys.noRow, `8.8.10.${spread}`, 40, spread);
      // 10:01:01 on the test's clock: 59 seconds left in the window, by Postgres and by the filter.
      expect(withRow).toEqual([
        ...Array<string>(30).fill("401"),
        ...Array<string>(10).fill("429 59"),
      ]);
      expect(withoutRow).toEqual(withRow);
      // Postgres counted every refusal of the ID with no row until its window was full, and each
      // replica's first after that (a lookup and a count each); the filter answered the rest.
      expect(own.statements - before).toBe(2 * (30 + spread));
      for (let on = 0; on < spread; on++) {
        expect(lastLine(on)).toMatchObject({
          status: 429,
          keyReason: "unknown",
          rateLimited: true,
          violatedPolicies: ["refused_keys"],
          dbQueries: 0,
        });
      }
      const limited = await call(keys.noRow, `8.8.10.${spread}`, 0);
      expect(limited.json()).toMatchObject({
        code: "rate_limited",
        violated_policies: ["refused_keys"],
      });
    },
  );

  it("keeps a full window no longer than Postgres does: the next minute starts at 401 for both", async () => {
    const keys = pair();
    for (const [key, ip] of [
      [keys.withRow, "8.8.11.1"],
      [keys.noRow, "8.8.11.2"],
    ] as const) {
      expect((await answers(key, ip, 32, 2)).slice(29)).toEqual(["401", "429 59", "429 59"]);
    }
    // The window's last millisecond: still full for both, with a second to wait.
    now += 58_999;
    expect(await answers(keys.withRow, "8.8.11.1", 2, 2)).toEqual(["429 1", "429 1"]);
    const before = own.statements;
    expect(await answers(keys.noRow, "8.8.11.2", 2, 2)).toEqual(["429 1", "429 1"]);
    expect(own.statements).toBe(before);
    // The next minute: Postgres's window starts again, and so does the filter, on either replica.
    now += 1;
    expect(await answers(keys.withRow, "8.8.11.1", 2, 2)).toEqual(["401", "401"]);
    expect(await answers(keys.noRow, "8.8.11.2", 2, 2)).toEqual(["401", "401"]);
    expect(own.statements - before).toBe(8);
  });
});

describe("configuration", () => {
  it("refuses to start with another environment's salt, or none (exit 78)", async () => {
    for (const salt of ["fin-prod-1", ""]) {
      await expect(
        bootApi(defineEdgeService({ store, peppers: PEPPERS }), {
          service: "edge",
          roles: ["api"],
          env: { ...ENV, FIN_KEY_SALT: salt },
        }),
      ).rejects.toThrow(/did not start/);
    }
  });
});
