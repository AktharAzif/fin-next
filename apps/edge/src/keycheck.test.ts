// The key check's route policy (spec 05 §2.1 step 18), driven directly: `GET /v4/whoami` takes any
// working key, so no route in the edge's table yet asks for a full-access key, a scope or a Sandbox
// key, and the boot tests cannot reach those refusals. Here a route of each kind is checked with the
// keys that pass it and the keys it refuses, after a key that passed every earlier step: a restricted
// key on a full-access route, a key without the route's scope, and a Production key on a Sandbox-only
// route are each refused before the key's window is counted.
import { createManualClock } from "@fin/core";
import type { FinEnv } from "@fin/server/http";
import { Telemetry } from "@fin/server/telemetry";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { FakeStore, PEPPERS, SALT } from "../test/fake-store.ts";
import { checkKey, type EdgeRoute, type KeyCheckDeps } from "./keycheck.ts";
import { LastUsed } from "./last-used.ts";
import { factsOf } from "./request-line.ts";
import { SHED_DEFAULTS, Shedder } from "./shed.ts";

const DOCS = "https://docs.example.net";

function route(over: Partial<EdgeRoute>): EdgeRoute {
  return {
    operationId: "testOperation",
    method: "GET",
    path: "/v4/test",
    keyKind: "any",
    scopes: [],
    mode: "any",
    ...over,
  };
}

function harness() {
  const clock = createManualClock(Date.parse("2026-11-22T10:00:05.000Z"));
  const store = new FakeStore();
  const lines: Record<string, unknown>[] = [];
  const telemetry = new Telemetry({
    service: "edge",
    environment: "ci",
    release: "test-release",
    replica: "test",
    clock,
    stdout: (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  const deps: KeyCheckDeps = {
    store,
    peppers: PEPPERS,
    salt: SALT,
    shedder: new Shedder(SHED_DEFAULTS, clock),
    lastUsed: new LastUsed(clock, 100),
    clock,
    docsOrigin: DOCS,
    telemetry,
  };
  /** Runs the check for `policy` with this key; answers the status, the facts and the reason. */
  const check = async (policy: EdgeRoute, key: string) => {
    const app = new Hono<FinEnv>();
    let seen: { facts: ReturnType<typeof factsOf>; reason: string | undefined } | undefined;
    app.use(async (c, next) => {
      c.set("requestId", "req_01jd0000000000000000000000");
      c.set("ingress", {
        role: "api",
        host: "gateway.example.net",
        publicUrl: "https://gateway.example.net/v4/test",
        clientIp: "8.8.8.8",
        country: undefined,
        scheme: "https",
        cfRay: undefined,
      });
      await next();
    });
    app.get("/v4/test", async (c) => {
      const checked = await checkKey(c, deps, policy);
      seen = { facts: { ...factsOf(c) }, reason: c.get("reason") };
      if ("refused" in checked) return checked.refused;
      return c.json({ keyId: checked.key.id }, 200);
    });
    const res = await app.request("/v4/test", { headers: { authorization: `Bearer ${key}` } });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
      facts: seen?.facts ?? {},
      reason: seen?.reason,
    };
  };
  return { store, check, lines };
}

describe("the route's policy (step 18)", () => {
  it("lets only a full-access key through a full-access route", async () => {
    const { store, check } = harness();
    const full = store.add("test", "sk");
    const restricted = store.add("test", "rk");
    const policy = route({ keyKind: "full_access" });
    expect((await check(policy, full)).status).toBe(200);
    const refused = await check(policy, restricted);
    expect(refused).toMatchObject({
      status: 403,
      body: { code: "forbidden", detail: "Use a full-access key for this." },
      reason: "policy.full_access",
    });
    // Refused before the key's window: the lookup was the only statement.
    expect(refused.facts.dbQueries).toBe(1);
  });

  it("asks a restricted key for every scope the route names; a full-access key holds them all", async () => {
    const { store, check } = harness();
    const reader = store.add("test", "rk", { scopes: ["customers:read"] });
    const both = store.add("test", "rk", { scopes: ["customers:read", "money:read"] });
    const full = store.add("test", "sk");
    const policy = route({ scopes: ["customers:read", "money:read"] });
    const refused = await check(policy, reader);
    expect(refused).toMatchObject({
      status: 403,
      body: { code: "forbidden", detail: "This key needs the money:read scope." },
      reason: "policy.scope",
    });
    expect(refused.facts.dbQueries).toBe(1);
    expect((await check(policy, both)).status).toBe(200);
    expect((await check(policy, full)).status).toBe(200);
  });

  it("refuses a Production key on a Sandbox-only route, and lets a Sandbox key through", async () => {
    const { store, check } = harness();
    const live = store.add("live", "sk", { org_live_status: "enabled" });
    const sandbox = store.add("test", "sk");
    const policy = route({ mode: "sandbox_only" });
    const refused = await check(policy, live);
    expect(refused).toMatchObject({
      status: 403,
      body: { code: "sandbox_only" },
      reason: "sandbox_only",
      facts: { mode: "live" },
    });
    expect(refused.facts.dbQueries).toBe(1);
    expect((await check(policy, sandbox)).status).toBe(200);
  });
});
