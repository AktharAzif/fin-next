// Fin Admin's API half booted on a real socket, with a stand-in for Access's certs endpoint: the
// Access token is checked on every request before the origin gate (AC-P0-26's unit half: a forged
// Cf-Access-Jwt-Assertion from a non-connector peer gets 403; from the connector, a forged one 401).
import { bootApi, NEIGHBOUR_ADDRESS } from "@fin/web-host/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminService } from "./main.ts";

const HOST = "staff.example.net";
const ORIGIN = `https://${HOST}`;
const TEAM = "fin-team";
const AUD = "e".repeat(64);
let api: Awaited<ReturnType<typeof bootApi>>;
let token: string;
const certsFetched: string[] = [];

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const random = (bytes: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

/**
 * The staff realm's and the pool's settings, made at run time (L-SAT-04). The pool opens no
 * connection until a request needs the database, which /api/health does not.
 */
function realmTestEnv(): Record<string, string> {
  return {
    BETTER_AUTH_SECRETS: `2:${random(32)},1:${random(32)}`,
    FIN_LIMIT_KEY_1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
    FIN_DB_HOST: "127.0.0.1",
    FIN_DB_PORT: "5432",
    FIN_DB_NAME: "fin",
    FIN_DB_USER: "fin_admin_a",
    FIN_DB_PASSWORD: random(24),
  };
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as { privateKey: CryptoKey; publicKey: CryptoKey };
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", kid: "k1" });
  const body = b64({
    iss: `https://${TEAM}.cloudflareaccess.com`,
    aud: [AUD],
    sub: "access-sub",
    email: "staff.member@example.com",
    type: "app",
    nbf: now,
    exp: now + 600,
  });
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  token = `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
  const certs = (async (url: string) => {
    certsFetched.push(url);
    return new Response(
      JSON.stringify({ keys: [{ kid: "k1", kty: "RSA", alg: "RS256", n: jwk.n, e: jwk.e }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  api = await bootApi(adminService, {
    service: "admin",
    roles: ["admin"],
    env: {
      FIN_PUBLIC_ORIGIN: ORIGIN,
      FIN_CONNECTOR_SERVICES: "cloudflared-admin,cloudflared-admin-b",
      FIN_ACCESS_TEAM: TEAM,
      FIN_ACCESS_AUD: AUD,
      ...realmTestEnv(),
    },
    fetch: certs,
  });
});

afterAll(async () => {
  await api.stop();
  expect(api.exits).toEqual([0]);
});

describe("Fin Admin's API half", () => {
  it("answers /api/health only with a valid Access token, and reads the team's certs", async () => {
    expect(
      (
        await api.send({
          host: HOST,
          path: "/api/health",
          headers: { "cf-access-jwt-assertion": token },
        })
      ).status,
    ).toBe(200);
    expect(certsFetched).toEqual([`https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`]);
    const missing = await api.send({ host: HOST, path: "/api/health" });
    expect(missing.status).toBe(401);
    expect(missing.json()).toMatchObject({ code: "access_required" });
    const forged = await api.send({
      host: HOST,
      path: "/api/health",
      headers: { "cf-access-jwt-assertion": `${token.slice(0, -4)}AAAA` },
    });
    expect(forged.status).toBe(401);
  });

  it("refuses a forged token, or none, from a non-connector peer at the ingress check: 403", async () => {
    const untrusted = () => api.stdout.filter((l) => l.event === "ingress.untrusted_peer").length;
    const jwtRefused = () => api.stdout.filter((l) => l.event === "access.jwt_refused").length;
    const [untrustedBefore, jwtBefore] = [untrusted(), jwtRefused()];
    for (const headers of [
      { "cf-access-jwt-assertion": `${token.slice(0, -4)}AAAA` },
      {} as Record<string, string>,
    ]) {
      const res = await api.send({
        host: HOST,
        path: "/api/health",
        from: NEIGHBOUR_ADDRESS,
        headers,
      });
      expect(res.status).toBe(403);
    }
    expect(untrusted() - untrustedBefore).toBe(2);
    expect(jwtRefused()).toBe(jwtBefore);
  });

  it("checks Access before the path check and the origin gate: a tokenless request is 401 wherever it goes", async () => {
    const refusalsBefore = api.stdout.filter((l) => l.event === "csrf.refused").length;
    const crossSite = await api.send({
      host: HOST,
      path: "/api/staff",
      method: "POST",
      headers: {
        origin: "https://evil.example.com",
        "sec-fetch-site": "cross-site",
        "content-type": "text/plain",
      },
      body: "{}",
    });
    expect(crossSite.status).toBe(401);
    expect(crossSite.json()).toMatchObject({ code: "access_required" });
    for (const path of ["/sign-in", "/"]) {
      const res = await api.send({ host: HOST, path });
      expect(res.status, path).toBe(401);
    }
    expect(api.stdout.filter((l) => l.event === "csrf.refused")).toHaveLength(refusalsBefore);
  });

  it("runs the origin gate after Access: X-Fin-App must be admin", async () => {
    const headers = {
      "cf-access-jwt-assertion": token,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-fin-app": "console",
    };
    const res = await api.send({
      host: HOST,
      path: "/api/staff",
      method: "POST",
      headers,
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ code: "invalid_origin", reason: "app_header" });
    expect(api.stdout.some((l) => l.event === "access.jwt_refused" && l.reason === "missing")).toBe(
      true,
    );
    expect(JSON.stringify(api.stdout)).not.toContain("staff.member@example.com");
  });

  it("answers private health without Access", async () => {
    expect(
      (await api.send({ host: "[::1]", path: "/healthz", from: NEIGHBOUR_ADDRESS, proof: null }))
        .status,
    ).toBe(200);
  });
});
