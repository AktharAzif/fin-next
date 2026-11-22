// The keys schema on Postgres 18 (spec 05 §4.9; spec 02 §13.5, §13.7, §13.8): every login's grants
// (each forbidden statement fails with 42501), the audit guard (a key made or changed with no event is
// refused at commit, FA010), "last used" at most once a minute ([BC-05], T05-16's database half), and
// the edge's one statement: the record, the refused-key window and the live_keys switch together, on
// the primary key's index, with a deleted organisation's key read as unknown.
import { randomBytes } from "node:crypto";
import { createKeyring } from "@fin/crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createKeysPlatform,
  type KeysPlatform,
  type PlatformClient,
  seedOrganization,
} from "../test/platform.mjs";
import { fixtureId, inUnit } from "../test/unit.ts";
import { createKey, createKeys, type KeyActor } from "./lifecycle.ts";
import { keyStore, keyWindowKey, LOOKUP_SQL, refusedWindowKey } from "./lookup.ts";
import { saltFor } from "./salts.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const ORG = fixtureId("org", 2);
const OWNER = { userId: fixtureId("usr", 11), memberId: fixtureId("mem", 11) };
const peppers = createKeyring("API_KEY_PEPPER", new Map([[1, new Uint8Array(randomBytes(32))]]), 1);
const keys = createKeys({
  clock: { now: () => new Date() },
  peppers,
  salt: saltFor("ci"),
  lines: { write: () => {} },
});

let platform: KeysPlatform;
let su: PlatformClient;
const logins = new Map<string, PlatformClient>();
let keyId = "";

async function as(login: string): Promise<PlatformClient> {
  const known = logins.get(login);
  if (known !== undefined) return known;
  const client = await platform.login(login);
  logins.set(login, client);
  return client;
}

async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

const actor: KeyActor = {
  userId: OWNER.userId,
  organizationId: ORG,
  organizationName: "Grants Org",
  organizationLiveStatus: "sandbox",
  permissions: new Set(["apiKey.sandbox", "customers.read", "money.read"]),
  audit: { kind: "user", id: OWNER.userId, via: "console" },
  confirm: async () => {},
};

beforeAll(async () => {
  platform = await createKeysPlatform("keysschema");
  su = await platform.superuser();
  await seedOrganization(su, {
    orgId: ORG,
    name: "Grants Org",
    people: [
      { ...OWNER, name: "Grace Owner", email: "grace.owner@example.com", roleKey: "super_admin" },
    ],
  });
  const made = await inUnit(await as("fin_console_a"), (tx) =>
    createKey(keys, tx, actor, {
      name: "Grants key",
      mode: "test",
      kind: "rk",
      scopes: ["money:read"],
      ipAllowlist: ["8.8.8.0/24"],
      expiresIn: "never",
    }),
  );
  keyId = made.key.keyId;
});

afterAll(async () => {
  for (const client of logins.values()) await client.end();
  await su?.end();
  await platform?.drop();
});

describe("grants", () => {
  it("keeps the edge to the view and 'last used'", async () => {
    const edge = await as("fin_edge_a");
    expect(await sqlState(edge.query("SELECT id FROM keys.api_key LIMIT 1"))).toBe("42501");
    expect(await sqlState(edge.query("UPDATE keys.api_key SET name = 'x'"))).toBe("42501");
    const row = await edge.query<{ id: string }>("SELECT id FROM keys.key_lookup WHERE id = $1", [
      keyId,
    ]);
    expect(row.rows).toEqual([{ id: keyId }]);
    expect(await sqlState(edge.query("SELECT keys.touch_last_used($1)", [keyId]))).toBeNull();
    // The view carries no name and nothing a member typed.
    expect(await sqlState(edge.query("SELECT name FROM keys.key_lookup"))).toBe("42703");
  });

  it("never lets the console write a hash, a pepper version or 'last used'", async () => {
    const consoleLogin = await as("fin_console_a");
    for (const column of [
      "hash = hash",
      "pepper_versions = pepper_versions",
      "last_used_at = now()",
      "organization_id = organization_id",
      "mode = mode",
    ]) {
      expect(
        await sqlState(
          consoleLogin.query(`UPDATE keys.api_key SET ${column} WHERE id = $1`, [keyId]),
        ),
        column,
      ).toBe("42501");
    }
    expect(
      await sqlState(consoleLogin.query("DELETE FROM keys.api_key WHERE id = $1", [keyId])),
    ).toBe("42501");
    expect(await sqlState(consoleLogin.query("SELECT keys.touch_last_used($1)", [keyId]))).toBe(
      "42501",
    );
  });

  it("lets the worker re-hash and nothing more, and hides the hash from the operator", async () => {
    const worker = await as("fin_worker_a");
    expect(
      await sqlState(
        worker.query(
          "UPDATE keys.api_key SET hash = hash, pepper_versions = pepper_versions WHERE id = $1",
          [keyId],
        ),
      ),
    ).toBeNull();
    expect(
      await sqlState(
        worker.query("UPDATE keys.api_key SET revoked_at = now() WHERE id = $1", [keyId]),
      ),
    ).toBe("42501");
    expect(await sqlState(worker.query("SELECT name FROM keys.api_key"))).toBe("42501");
    // The operator's role has no password in tests: the superuser takes it for one transaction.
    const asReadonly = async (sql: string) => {
      await su.query("BEGIN");
      await su.query("SET LOCAL ROLE fin_readonly");
      try {
        return await sqlState(su.query(sql));
      } finally {
        await su.query("ROLLBACK");
      }
    };
    expect(await asReadonly("SELECT hash FROM keys.api_key")).toBe("42501");
    expect(await asReadonly("SELECT id, name, last_used_at FROM keys.api_key")).toBeNull();
  });

  it("gives api, admin and payments nothing on the table", async () => {
    for (const login of ["fin_api_a", "fin_admin_a", "fin_payments_a"]) {
      expect(
        await sqlState((await as(login)).query("SELECT id FROM keys.api_key LIMIT 1")),
        login,
      ).toBe("42501");
    }
    expect(
      await sqlState((await as("fin_payments_a")).query("SELECT id FROM keys.key_lookup LIMIT 1")),
    ).toBeNull();
    expect(
      await sqlState((await as("fin_api_a")).query("SELECT id FROM keys.key_lookup LIMIT 1")),
    ).toBe("42501");
  });
});

describe("the audit guard", () => {
  it("refuses a key change with no event at commit, whatever login writes it", async () => {
    const consoleLogin = await as("fin_console_a");
    for (const change of [
      "UPDATE keys.api_key SET revoked_at = now(), revoked_reason = 'member' WHERE id = $1",
      "UPDATE keys.api_key SET scopes = '{}'::text[], kind = kind WHERE id = $1",
      "UPDATE keys.api_key SET expires_at = now() + interval '1 day' WHERE id = $1",
      "UPDATE keys.api_key SET ip_allowlist = '{}' WHERE id = $1",
      "UPDATE keys.api_key SET name = 'Renamed quietly' WHERE id = $1",
    ]) {
      await consoleLogin.query("BEGIN");
      const state = await sqlState(
        consoleLogin.query(change, [keyId]).then(() => consoleLogin.query("COMMIT")),
      );
      await consoleLogin.query("ROLLBACK").catch(() => {});
      expect(["FA010", "42501", "23514"], change).toContain(state);
    }
    const still = await su.query<{ revoked_at: Date | null; name: string }>(
      "SELECT revoked_at, name FROM keys.api_key WHERE id = $1",
      [keyId],
    );
    expect(still.rows[0]).toEqual({ revoked_at: null, name: "Grants key" });
  });

  it("refuses even the superuser a key inserted with no event", async () => {
    const state = await sqlState(
      su.query(
        `INSERT INTO keys.api_key (id, organization_id, mode, kind, name, scopes, hash, pepper_versions,
           created_by, created_at, updated_at)
         VALUES ('ZZZZZZZZZZ', $1, 'test', 'sk', 'Quiet key', '{}', $2, '{1}', $3, now(), now())`,
        [ORG, Buffer.alloc(32), OWNER.userId],
      ),
    );
    expect(state).toBe("FA010");
  });
});

describe("last used", () => {
  it("is written rounded to the minute, at most once a minute per key", async () => {
    const edge = await as("fin_edge_a");
    const store = keyStore(edge);
    await su.query("UPDATE keys.api_key SET last_used_at = NULL WHERE id = $1", [keyId]);
    const first = await store.touch(keyId);
    const second = await store.touch(keyId);
    expect([first, second]).toEqual([true, false]);
    const row = await su.query<{ last_used_at: Date }>(
      "SELECT last_used_at FROM keys.api_key WHERE id = $1",
      [keyId],
    );
    expect(row.rows[0]?.last_used_at.getUTCSeconds()).toBe(0);
    expect(row.rows[0]?.last_used_at.getUTCMilliseconds()).toBe(0);
    await su.query(
      "UPDATE keys.api_key SET last_used_at = last_used_at - interval '2 minutes' WHERE id = $1",
      [keyId],
    );
    expect(await store.touch(keyId)).toBe(true);
    expect(await store.touch("ZZZZZZZZZZ")).toBe(false);
  });
});

describe("the edge's statement", () => {
  it("reads the record, the refused-key window and the live_keys switch in one statement", async () => {
    const store = keyStore(await as("fin_edge_a"));
    const window = refusedWindowKey("abc");
    const found = await store.lookup(keyId, window);
    expect(found.refusedCount).toBe(0);
    expect(found.liveKeysOn).toBe(false);
    expect(found.record).toMatchObject({
      id: keyId,
      organization_id: ORG,
      mode: "test",
      kind: "rk",
      scopes: ["money:read"],
      ip_allowlist: ["8.8.8.0/24"],
      pepper_versions: [1],
      revoked_at: null,
      org_live_status: "not_enabled",
    });
    expect(Buffer.isBuffer(found.record?.hash)).toBe(true);
    expect((await store.count(window)).count).toBe(1);
    expect((await store.count(window)).count).toBe(2);
    expect((await store.lookup(keyId, window)).refusedCount).toBe(2);
    const counted = await store.count(keyWindowKey(keyId));
    expect(counted.secondsLeft).toBeGreaterThanOrEqual(1);
    expect(counted.secondsLeft).toBeLessThanOrEqual(60);
    expect(counted.secondsLeft).toBe(Math.max(1, Math.ceil(counted.msLeft / 1000)));
    expect((await store.lookup("ZZZZZZZZZZ", window)).record).toBeNull();
  });

  it("answers a count's time left by the database's clock, rounded down, so it never runs past the window's end", async () => {
    const store = keyStore(await as("fin_edge_a"));
    const clockMs = async () =>
      Number(
        (
          await su.query<{ ms: string }>(
            "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS ms",
          )
        ).rows[0]?.ms,
      );
    // Read the database's clock either side of the count, in one minute (tried again if a minute
    // ends between them): the count ran between the two readings.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await clockMs();
      const counted = await store.count(refusedWindowKey(`clock-${attempt}`));
      const after = await clockMs();
      const minute = Math.floor(before / 60_000);
      if (Math.floor(after / 60_000) !== minute) continue;
      const end = (minute + 1) * 60_000;
      expect(before + counted.msLeft).toBeLessThanOrEqual(end);
      expect(after + counted.msLeft).toBeGreaterThanOrEqual(end - 1);
      return;
    }
    throw new Error("three minutes ended between the readings");
  });

  it("uses the key table's primary key (EXPLAIN)", async () => {
    const plan = await su.query<{ "QUERY PLAN": string }>(
      `EXPLAIN ${LOOKUP_SQL.replaceAll("$1", "'ABCDEFGHJK'").replaceAll("$2", "'w'")}`,
    );
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toMatch(/api_key_pkey/);
  });

  it("maps the organisation's live status, and reads a deleted organisation's key as unknown", async () => {
    const store = keyStore(await as("fin_edge_a"));
    await su.query("BEGIN");
    await su.query("SET LOCAL session_replication_role = replica");
    await su.query("UPDATE identity.organization SET live_status = 'approved' WHERE id = $1", [
      ORG,
    ]);
    await su.query("COMMIT");
    expect((await store.lookup(keyId, "w")).record?.org_live_status).toBe("enabled");
    await su.query("BEGIN");
    await su.query("SET LOCAL session_replication_role = replica");
    await su.query("UPDATE identity.organization SET live_status = 'paused' WHERE id = $1", [ORG]);
    await su.query("COMMIT");
    expect((await store.lookup(keyId, "w")).record?.org_live_status).toBe("paused");
    await su.query("BEGIN");
    await su.query("SET LOCAL session_replication_role = replica");
    await su.query("UPDATE identity.organization SET deleted_at = now() WHERE id = $1", [ORG]);
    await su.query("COMMIT");
    expect((await store.lookup(keyId, "w")).record).toBeNull();
  });
});
