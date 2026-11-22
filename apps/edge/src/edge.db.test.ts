// The edge against Postgres 18 as its own login (fin_edge_a), with keys made, rolled and revoked by
// the lifecycle as the console's login: `GET /v4/whoami` with a working key; the same 401 for a
// revoked, a rolled (past its overlap), another environment's, an unknown and a malformed key
// (T05-08, A05-02); a revocation refused on the very next request (T05-09, no positive cache); a
// rolling key working until its overlap ends; the allowlist (T05-11); "last used" written after the
// answer, at most once a minute (T05-16); a key ID with no row answered the same 401s, then 429s, as
// a wrong secret by two replicas taking turns on one database (spec 05 §3.7's window in Postgres);
// and the timings of an unknown and a wrong key within a set bound of each other.
import { randomBytes } from "node:crypto";
import { createKeyring } from "@fin/crypto";
import {
  createKey,
  createKeys,
  type KeyActor,
  newKey,
  revokeKey,
  rollKey,
  saltFor,
} from "@fin/keys";
import { bootApi } from "@fin/web-host/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createKeysPlatform,
  type KeysPlatform,
  type PlatformClient,
  seedOrganization,
} from "../../../packages/keys/test/platform.mjs";
import { fixtureId, inUnit } from "../../../packages/keys/test/unit.ts";
import { defineEdgeService } from "./main.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const HOST = "gateway.example.net";
const HTTPS = { "cf-visitor": '{"scheme":"https"}', "cf-connecting-ip": "8.8.8.8" };
const ORG = fixtureId("org", 5);
const OWNER = { userId: fixtureId("usr", 51), memberId: fixtureId("mem", 51) };
const pepper = randomBytes(32);
const peppers = createKeyring("API_KEY_PEPPER", new Map([[1, new Uint8Array(pepper)]]), 1);
const keys = createKeys({
  clock: { now: () => new Date() },
  peppers,
  salt: saltFor("ci"),
  lines: { write: () => {} },
});
const owner: KeyActor = {
  userId: OWNER.userId,
  organizationId: ORG,
  organizationName: "Edge Org",
  organizationLiveStatus: "sandbox",
  permissions: new Set([
    "apiKey.sandbox",
    "customers.read",
    "money.read",
    "webhooks.read",
    "webhooks.manage",
    "webhooks.roll_secret",
    "webhooks.redeliver",
    "customers.create",
    "customers.restart",
    "customers.delete",
    "money.transfer",
    "money.beneficiaries",
    "simulator.use",
    "money.simulate",
    "sandbox.reset",
  ]),
  audit: { kind: "user", id: OWNER.userId, via: "console" },
  confirm: async () => {},
};

let platform: KeysPlatform;
let su: PlatformClient;
let consoleLogin: PlatformClient;
let api: Awaited<ReturnType<typeof bootApi>>;
/** The edge's settings on this database, for a second replica beside `api`. */
let edgeEnv: Record<string, string>;

const make = (over: Partial<Parameters<typeof createKey>[3]> = {}) =>
  inUnit(consoleLogin, (tx) =>
    createKey(keys, tx, owner, {
      name: "Edge key",
      mode: "test",
      kind: "rk",
      scopes: ["customers:read"],
      ipAllowlist: [],
      expiresIn: "90d",
      ...over,
    }),
  );

const whoami = (key: string | null, extra: Record<string, string> = {}) =>
  api.send({
    host: HOST,
    path: "/v4/whoami",
    headers: { ...HTTPS, ...(key === null ? {} : { authorization: `Bearer ${key}` }), ...extra },
  });

beforeAll(async () => {
  platform = await createKeysPlatform("keysedge");
  su = await platform.superuser();
  consoleLogin = await platform.login("fin_console_a");
  await seedOrganization(su, {
    orgId: ORG,
    name: "Edge Org",
    people: [
      { ...OWNER, name: "Eve Owner", email: "eve.owner@example.com", roleKey: "super_admin" },
    ],
  });
  edgeEnv = {
    FIN_PUBLIC_ORIGIN: `https://${HOST}`,
    FIN_CONNECTOR_SERVICES: "cloudflared-public",
    FIN_KEY_SALT: "fin-ci-1",
    API_KEY_PEPPER_1: pepper.toString("base64url"),
    API_KEY_PEPPER_IN_USE: "1",
    FIN_DB_HOST: platform.host,
    FIN_DB_PORT: String(platform.port),
    FIN_DB_NAME: platform.name,
    FIN_DB_USER: "fin_edge_a",
    FIN_DB_PASSWORD: platform.password("fin_edge_a"),
  };
  api = await bootApi(defineEdgeService(), { service: "edge", roles: ["api"], env: edgeEnv });
});

afterAll(async () => {
  await api?.stop();
  await consoleLogin?.end();
  await su?.end();
  await platform?.drop();
});

describe("the edge on Postgres 18", () => {
  it("answers whoami for a working key and writes 'last used' after it, once a minute", async () => {
    const made = await make();
    const res = await whoami(made.secret);
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      object: "api_key",
      id: made.key.keyId,
      livemode: false,
      kind: "restricted",
      scopes: ["customers:read"],
      organization: ORG,
    });
    await vi.waitFor(async () => {
      const row = await su.query<{ last_used_at: Date | null }>(
        "SELECT last_used_at FROM keys.api_key WHERE id = $1",
        [made.key.keyId],
      );
      expect(row.rows[0]?.last_used_at).not.toBeNull();
    });
    const first = (
      await su.query<{ t: Date }>("SELECT last_used_at AS t FROM keys.api_key WHERE id = $1", [
        made.key.keyId,
      ])
    ).rows[0]?.t;
    expect(first?.getUTCSeconds()).toBe(0);
    expect((await whoami(made.secret)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = (
      await su.query<{ t: Date }>("SELECT last_used_at AS t FROM keys.api_key WHERE id = $1", [
        made.key.keyId,
      ])
    ).rows[0]?.t;
    expect(second?.getTime()).toBe(first?.getTime());
  });

  it("refuses a revoked key on the very next request, with no positive cache", async () => {
    const made = await make();
    expect((await whoami(made.secret)).status).toBe(200);
    await inUnit(consoleLogin, (tx) => revokeKey(keys, tx, owner, made.key.keyId));
    expect((await whoami(made.secret)).status).toBe(401);
  });

  it("keeps a rolling key working until its overlap ends, and refuses it after", async () => {
    const made = await make();
    const rolled = await inUnit(consoleLogin, (tx) =>
      rollKey(keys, tx, owner, made.key.keyId, { overlap: "1h" }),
    );
    expect((await whoami(made.secret)).status).toBe(200);
    expect((await whoami(rolled.secret)).status).toBe(200);
    const ended = await make();
    const now = await inUnit(consoleLogin, (tx) =>
      rollKey(keys, tx, owner, ended.key.keyId, { overlap: "now" }),
    );
    expect((await whoami(ended.secret)).status).toBe(401);
    expect((await whoami(now.secret)).status).toBe(200);
  });

  it("answers every refused key with the same 401 body, whatever the reason", async () => {
    const revoked = await make();
    await inUnit(consoleLogin, (tx) => revokeKey(keys, tx, owner, revoked.key.keyId));
    const rolled = await make();
    await inUnit(consoleLogin, (tx) =>
      rollKey(keys, tx, owner, rolled.key.keyId, { overlap: "now" }),
    );
    const allowlisted = await make({ ipAllowlist: ["8.8.4.0/24"] });
    const cases: [string, string | null][] = [
      ["revoked", revoked.secret],
      ["rolled", rolled.secret],
      ["wrong environment", newKey("test", "rk", saltFor("staging")).key],
      ["unknown", newKey("test", "rk", saltFor("ci")).key],
      ["malformed", "fin_test_rk_short"],
      ["missing", null],
      ["outside its allowlist", allowlisted.secret],
    ];
    const bodies = new Set<string>();
    const reasons: unknown[] = [];
    for (const [label, key] of cases) {
      const res = await whoami(key, { "cf-connecting-ip": "8.8.7.7" });
      expect(res.status, label).toBe(401);
      bodies.add(JSON.stringify({ ...(res.json() as object), request_id: "x" }));
      reasons.push(
        (
          api.stdout.filter((l) => l.event === "request").at(-1) as unknown as Record<
            string,
            unknown
          >
        ).keyReason,
      );
    }
    expect(bodies.size).toBe(1);
    expect(reasons).toEqual([
      "revoked",
      "expired",
      "other_deployment",
      "unknown",
      "malformed",
      "missing",
      "ip_not_allowed",
    ]);
    // From an allowed address the same key works.
    expect((await whoami(allowlisted.secret, { "cf-connecting-ip": "8.8.4.9" })).status).toBe(200);
  });

  it("answers a key ID with no row the same 401s, then 429s, as a wrong secret, with two replicas taking turns", async () => {
    const twin = await bootApi(defineEdgeService(), {
      service: "edge",
      roles: ["api"],
      env: edgeEnv,
    });
    try {
      const made = await make();
      const withRow = newKey("test", "rk", saltFor("ci"), undefined, made.key.keyId).key;
      const noRow = newKey("test", "rk", saltFor("ci")).key;
      const send = (on: number, key: string, ip: string) =>
        (on % 2 === 0 ? api : twin).send({
          host: HOST,
          path: "/v4/whoami",
          headers: { ...HTTPS, "cf-connecting-ip": ip, authorization: `Bearer ${key}` },
        });
      const run = async (key: string, ip: string) => {
        const out: number[] = [];
        for (let i = 0; i < 36; i++) out.push((await send(i, key, ip)).status);
        return out;
      };
      // Each run's refusals fall in one window of the database's clock: start with time to spare.
      const left = Number(
        (
          await su.query<{ ms: string }>(
            `SELECT floor(extract(epoch FROM date_trunc('minute', clock_timestamp())
               + interval '1 minute' - clock_timestamp()) * 1000)::int::text AS ms`,
          )
        ).rows[0]?.ms,
      );
      if (left < 20_000) await new Promise((resolve) => setTimeout(resolve, left + 200));
      const withRowRun = await run(withRow, "8.8.230.1");
      const noRowRun = await run(noRow, "8.8.230.2");
      expect(withRowRun).toEqual([...Array<number>(30).fill(401), ...Array<number>(6).fill(429)]);
      expect(noRowRun).toEqual(withRowRun);
      // Once each replica had seen the window full, its filter answered with no statement.
      for (const replica of [api, twin]) {
        const line = replica.stdout
          .filter((l) => l.event === "request")
          .at(-1) as unknown as Record<string, unknown>;
        expect(line).toMatchObject({ status: 429, keyReason: "unknown", dbQueries: 0 });
      }
      // The filter's Retry-After is the window's own: a refused key with a row from the same
      // address, counted by Postgres a moment before, waits as long (a second apart at most, when
      // a second ends between the two).
      const counted = await send(0, withRow, "8.8.230.2");
      const filtered = await send(0, noRow, "8.8.230.2");
      expect([counted.status, filtered.status]).toEqual([429, 429]);
      const waits = [counted, filtered].map((res) => Number(res.headers["retry-after"]));
      expect(Math.abs((waits[0] as number) - (waits[1] as number))).toBeLessThanOrEqual(1);
    } finally {
      await twin.stop();
    }
  });

  it("takes about as long for an unknown key as for a wrong secret (the body is hashed either way)", async () => {
    const made = await make();
    const wrongKey = newKey("test", "rk", saltFor("ci"), undefined, made.key.keyId).key;
    const time = async (key: string) => {
      const started = performance.now();
      await whoami(key, { "cf-connecting-ip": `8.8.${Math.floor(Math.random() * 200)}.1` });
      return performance.now() - started;
    };
    const unknown: number[] = [];
    const mismatched: number[] = [];
    for (let i = 0; i < 20; i++) {
      unknown.push(await time(newKey("test", "rk", saltFor("ci")).key));
      mismatched.push(await time(wrongKey));
    }
    const median = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
    expect(Math.abs(median(unknown) - median(mismatched))).toBeLessThan(25);
  });
});
