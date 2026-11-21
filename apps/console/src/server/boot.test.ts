// The console's API half booted on a real socket: its health routes, its public /api/health
// through the tunnel, the ingress check, and the origin gate's three refusals that FW-S2 names (a
// cross-site POST, a POST without X-Fin-App, a text/plain POST), each 403 invalid_origin.
import { bootApi, NEIGHBOUR_ADDRESS } from "@fin/web-host/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consoleService } from "./main.ts";

const HOST = "console.example.net";
const ORIGIN = `https://${HOST}`;
let api: Awaited<ReturnType<typeof bootApi>>;

beforeAll(async () => {
  api = await bootApi(consoleService, {
    service: "console",
    roles: ["console"],
    env: {
      FIN_PUBLIC_ORIGIN: ORIGIN,
      FIN_CONNECTOR_SERVICES: "cloudflared-public,cloudflared-public-b",
    },
  });
});

afterAll(async () => {
  await api.stop();
  expect(api.exits).toEqual([0]);
});

const json = {
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
  "x-fin-app": "console",
  "content-type": "application/json",
};

describe("the console's API half", () => {
  it("answers /healthz and /readyz to a private caller, and 404 through the tunnel", async () => {
    expect(
      (
        await api.send({ host: "[::1]", path: "/healthz", from: NEIGHBOUR_ADDRESS, proof: null })
      ).json(),
    ).toEqual({ status: "ok" });
    expect(
      (await api.send({ host: "[::1]", path: "/readyz", from: NEIGHBOUR_ADDRESS, proof: null }))
        .status,
    ).toBe(200);
    expect((await api.send({ host: HOST, path: "/readyz" })).status).toBe(404);
    expect(
      (await api.send({ host: HOST, path: "/healthz", from: NEIGHBOUR_ADDRESS, proof: null }))
        .status,
    ).toBe(404);
  });

  it("answers GET /api/health through the tunnel with the API headers", async () => {
    const res = await api.send({ host: HOST, path: "/api/health" });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["fin-release"]).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(res.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
  });

  it("refuses a neighbour with the proof: 403 and ingress.untrusted_peer", async () => {
    const res = await api.send({ host: HOST, path: "/api/health", from: NEIGHBOUR_ADDRESS });
    expect(res.status).toBe(403);
    expect(
      api.stdout.some((l) => l.event === "ingress.untrusted_peer" && l.reason === "peer_unknown"),
    ).toBe(true);
  });

  it("gives 403 invalid_origin to a cross-site POST, a POST without X-Fin-App and a text/plain POST", async () => {
    const cases: [Record<string, string>, string][] = [
      [
        { ...json, origin: "https://evil.example.com", "sec-fetch-site": "cross-site" },
        "origin_mismatch",
      ],
      [
        { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" },
        "app_header",
      ],
      [{ ...json, "content-type": "text/plain;charset=UTF-8" }, "content_type"],
    ];
    for (const [headers, reason] of cases) {
      const res = await api.send({
        host: HOST,
        path: "/api/auth/sign-in/email-otp",
        method: "POST",
        headers,
        body: "{}",
      });
      expect(res.status, reason).toBe(403);
      expect(res.json()).toMatchObject({
        type: "https://docs.example.net/errors/invalid_origin",
        code: "invalid_origin",
        reason,
      });
    }
    const refused = api.stdout.filter((l) => l.event === "csrf.refused").map((l) => l.reason);
    expect(refused).toEqual(cases.map(([, reason]) => reason));
  });

  it("lets a body-less POST or DELETE with no content type through the gate, and refuses a body without JSON", async () => {
    const { "content-type": _json, ...bare } = json;
    for (const method of ["POST", "DELETE"]) {
      const res = await api.send({ host: HOST, path: "/api/nothing-here", method, headers: bare });
      expect(res.status, method).toBe(404);
    }
    const refusalsBefore = api.stdout.filter((l) => l.event === "csrf.refused").length;
    const refused: { headers: Record<string, string>; body?: string }[] = [
      { headers: { ...bare, "content-length": "0", "content-type": "text/plain" } },
      { headers: { ...bare, "transfer-encoding": "chunked" }, body: "{}" },
      { headers: bare, body: "{}" },
    ];
    for (const { headers, body } of refused) {
      const res = await api.send({
        host: HOST,
        path: "/api/nothing-here",
        method: "POST",
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.json()).toMatchObject({ code: "invalid_origin", reason: "content_type" });
    }
    expect(api.stdout.filter((l) => l.event === "csrf.refused").length - refusalsBefore).toBe(3);
  });

  it("lets a well-formed same-origin JSON POST through the gate to the router", async () => {
    const res = await api.send({
      host: HOST,
      path: "/api/nothing-here",
      method: "POST",
      headers: json,
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});
