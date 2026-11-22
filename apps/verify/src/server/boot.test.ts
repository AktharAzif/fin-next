// verify's API half booted on a real socket: both hosts, each with its own proof and origin, the
// origin gate's three refusals, and no /api/auth at all.
import { bootApi, NEIGHBOUR_ADDRESS } from "@fin/web-host/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyService } from "./main.ts";

const VERIFY = "onboard.example.net";
const SELFIE = "selfie.example.net";
let api: Awaited<ReturnType<typeof bootApi>>;

beforeAll(async () => {
  api = await bootApi(verifyService, {
    service: "verify",
    roles: ["verify", "selfie"],
    env: {
      FIN_PUBLIC_ORIGIN: JSON.stringify({
        verify: `https://${VERIFY}`,
        selfie: `https://${SELFIE}`,
      }),
      FIN_CONNECTOR_SERVICES: "cloudflared-public,cloudflared-public-b",
    },
  });
});

afterAll(async () => {
  await api.stop();
  expect(api.exits).toEqual([0]);
});

const json = (origin: string) => ({
  origin,
  "sec-fetch-site": "same-origin",
  "x-fin-app": "verify",
  "content-type": "application/json",
});

describe("verify's API half", () => {
  it("answers /api/health on both hosts, each with its own proof", async () => {
    expect((await api.send({ host: VERIFY, path: "/api/health", role: "verify" })).status).toBe(
      200,
    );
    expect((await api.send({ host: SELFIE, path: "/api/health", role: "selfie" })).status).toBe(
      200,
    );
    expect(
      (await api.send({ host: SELFIE, path: "/api/health", proof: api.proofs.verify ?? "" }))
        .status,
    ).toBe(403);
  });

  it("answers private health to a private caller only", async () => {
    expect(
      (await api.send({ host: "[::1]", path: "/healthz", from: NEIGHBOUR_ADDRESS, proof: null }))
        .status,
    ).toBe(200);
    expect((await api.send({ host: SELFIE, path: "/readyz", role: "selfie" })).status).toBe(404);
  });

  it("gives 403 invalid_origin to a cross-site POST, a POST without X-Fin-App and a text/plain POST", async () => {
    const origin = `https://${VERIFY}`;
    const cases: [Record<string, string>, string][] = [
      [{ ...json(origin), origin: `https://${SELFIE}` }, "origin_mismatch"],
      [
        { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
        "app_header",
      ],
      [{ ...json(origin), "content-type": "text/plain" }, "content_type"],
    ];
    for (const [headers, reason] of cases) {
      const res = await api.send({
        host: VERIFY,
        path: "/api/link/open",
        method: "POST",
        headers,
        body: "{}",
        role: "verify",
      });
      expect(res.status, reason).toBe(403);
      expect(res.json()).toMatchObject({ code: "invalid_origin", reason });
    }
  });

  it("has no /api/auth routes", async () => {
    const res = await api.send({ host: VERIFY, path: "/api/auth/get-session", role: "verify" });
    expect(res.status).toBe(404);
  });
});
