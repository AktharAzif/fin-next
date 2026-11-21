// The edge booted on a real socket (spec 01 §4.5; AC-P0-07's /health and /readyz, AC-P0-34's plain
// http refusal, R16's CORS for the docs origin only).
import { bootApi, NEIGHBOUR_ADDRESS } from "@fin/web-host/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { edgeService } from "./main.ts";

const HOST = "gateway.example.net";
const DOCS = "https://docs.example.net";
const HTTPS = { "cf-visitor": '{"scheme":"https"}' };
let api: Awaited<ReturnType<typeof bootApi>>;

beforeAll(async () => {
  api = await bootApi(edgeService, {
    service: "edge",
    roles: ["api"],
    env: {
      FIN_PUBLIC_ORIGIN: `https://${HOST}`,
      FIN_CONNECTOR_SERVICES: "cloudflared-public,cloudflared-public-b",
    },
  });
});

afterAll(async () => {
  await api.stop();
  expect(api.exits).toEqual([0]);
});

describe("the edge", () => {
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

  it("answers GET /v4/whoami with 401 and Fin's problem type until API keys land", async () => {
    const res = await api.send({ host: HOST, path: "/v4/whoami", headers: HTTPS });
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toBe("application/problem+json");
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(res.json()).toMatchObject({
      type: `${DOCS}/errors/unauthenticated`,
      status: 401,
      code: "unauthenticated",
    });
  });

  it("refuses plain http with 403 https_required", async () => {
    const res = await api.send({
      host: HOST,
      path: "/v4/whoami",
      headers: { "cf-visitor": '{"scheme":"http"}' },
    });
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ code: "https_required" });
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
      "access-control-allow-headers": "authorization, content-type, idempotency-key",
      "access-control-max-age": "7200",
      vary: "Origin",
    });
    expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();
    for (const headers of [
      { origin: "https://evil.example.com", "access-control-request-method": "GET" },
      { origin: DOCS, "access-control-request-method": "PUT" },
      {
        origin: DOCS,
        "access-control-request-method": "GET",
        "access-control-request-headers": "cookie",
      },
    ]) {
      const refused = await api.send({
        host: HOST,
        path: "/v4/whoami",
        method: "OPTIONS",
        headers: { ...HTTPS, ...headers },
      });
      expect(refused.status).toBe(204);
      expect(Object.keys(refused.headers).filter((k) => k.startsWith("access-control-"))).toEqual(
        [],
      );
    }
    const simple = await api.send({
      host: HOST,
      path: "/v4/whoami",
      headers: { ...HTTPS, origin: DOCS },
    });
    expect(simple.headers["access-control-allow-origin"]).toBe(DOCS);
    const other = await api.send({
      host: HOST,
      path: "/v4/whoami",
      headers: { ...HTTPS, origin: "https://evil.example.com" },
    });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    expect(
      (await api.send({ host: HOST, path: "/health", headers: { ...HTTPS, origin: DOCS } }))
        .headers["access-control-allow-origin"],
    ).toBeUndefined();
  });

  it("refuses a neighbour at the ingress check", async () => {
    expect(
      (await api.send({ host: HOST, path: "/health", from: NEIGHBOUR_ADDRESS, headers: HTTPS }))
        .status,
    ).toBe(403);
  });

  it("runs its layers in order: ingress, then plain http, then the 256 KB body limit", async () => {
    const big = "x".repeat(256 * 1024 + 1);
    const json = { "content-type": "application/json" };
    const tooLarge = await api.send({
      host: HOST,
      path: "/v4/whoami",
      method: "POST",
      headers: { ...HTTPS, ...json },
      body: big,
    });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.json()).toMatchObject({ code: "payload_too_large" });
    const plain = await api.send({
      host: HOST,
      path: "/v4/whoami",
      method: "POST",
      headers: { "cf-visitor": '{"scheme":"http"}', ...json },
      body: big,
    });
    expect(plain.status).toBe(403);
    expect(plain.json()).toMatchObject({ code: "https_required" });
    const untrusted = api.stdout.filter((l) => l.event === "ingress.untrusted_peer").length;
    const neighbour = await api.send({
      host: HOST,
      path: "/v4/whoami",
      method: "POST",
      from: NEIGHBOUR_ADDRESS,
      headers: { "cf-visitor": '{"scheme":"http"}', ...json },
      body: big,
    });
    expect(neighbour.status).toBe(403);
    expect(neighbour.json()).not.toMatchObject({ code: "https_required" });
    expect(api.stdout.filter((l) => l.event === "ingress.untrusted_peer")).toHaveLength(
      untrusted + 1,
    );
  });
});
