// The key lifecycle on Postgres 18 as the console's own login (T05-15: each `api_keys` event written by
// its action, in the action's transaction; spec 02 §12.2, §12.3; spec 05 §4.6): create with the secret
// shown once and only the hash stored, an edit (a name alone included), a roll with its overlap, a
// revocation, the 50-key limit, the maker's role bounding every key, and the refusals that come before
// any step-up. The step-up itself is the console's (apps/console/src/server/keys.db.test.ts); here
// `confirm` records that it was asked, and when.
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
import { verifyChecksum } from "./format.ts";
import { matchesStored } from "./hash.ts";
import {
  createKey,
  createKeys,
  type KeyActor,
  keysOfMember,
  listKeys,
  revokeKey,
  rollForMember,
  rollKey,
  updateKey,
  WORKING_KEY_LIMIT,
} from "./lifecycle.ts";
import { saltFor } from "./salts.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const ALL = [
  "customers.read",
  "customers.create",
  "customers.restart",
  "customers.delete",
  "simulator.use",
  "sandbox.reset",
  "money.read",
  "money.beneficiaries",
  "money.transfer",
  "money.simulate",
  "webhooks.read",
  "webhooks.manage",
  "webhooks.roll_secret",
  "webhooks.redeliver",
  "apiKey.read",
  "apiKey.sandbox",
  "apiKey.live",
  "member.read",
  "member.invite",
  "member.role",
  "role.manage",
  "auditLog.read",
  "organization.update",
  "organization.delete",
  "golive.edit",
  "golive.submit",
];
const DEVELOPER = ALL.filter(
  (p) =>
    !["customers.delete", "sandbox.reset", "apiKey.live"].includes(p) && !p.startsWith("member.i"),
);

const ORG = fixtureId("org", 1);
const OWNER = { userId: fixtureId("usr", 1), memberId: fixtureId("mem", 1) };
const DEV = { userId: fixtureId("usr", 2), memberId: fixtureId("mem", 2) };
const peppers = createKeyring("API_KEY_PEPPER", new Map([[1, new Uint8Array(randomBytes(32))]]), 1);
const lines: { event: string; fields: Record<string, unknown> }[] = [];
const keys = createKeys({
  clock: { now: () => new Date() },
  peppers,
  salt: saltFor("ci"),
  lines: { write: (event, _level, fields) => lines.push({ event, fields }) },
});

let platform: KeysPlatform;
let su: PlatformClient;
let console_: PlatformClient;

beforeAll(async () => {
  platform = await createKeysPlatform("keyslife");
  su = await platform.superuser();
  console_ = await platform.login("fin_console_a");
  await seedOrganization(su, {
    orgId: ORG,
    name: "Example Payments",
    people: [
      { ...OWNER, name: "Ada Owner", email: "ada.owner@example.com", roleKey: "super_admin" },
      { ...DEV, name: "Dev One", email: "dev.one@example.com", roleKey: "admin" },
    ],
  });
});

afterAll(async () => {
  await console_?.end();
  await su?.end();
  await platform?.drop();
});

function actorOf(who: { userId: string }, permissions: readonly string[], liveStatus = "sandbox") {
  const asked: { body: Record<string, unknown>; target: string | null }[] = [];
  const actor: KeyActor & { asked: typeof asked } = {
    userId: who.userId,
    organizationId: ORG,
    organizationName: "Example Payments",
    organizationLiveStatus: liveStatus,
    permissions: new Set(permissions),
    audit: { kind: "user", id: who.userId, via: "console" },
    context: { clientIp: "2001:db8::7", userAgent: "Vitest" },
    asked,
    confirm: async (binding) => {
      asked.push({ body: { ...binding.body }, target: binding.target });
      actor.audit.stepUp = { kind: "intent", method: "totp", ref: fixtureId("sti", asked.length) };
    },
  };
  return actor;
}

const restricted = {
  name: "Payout worker",
  mode: "test" as const,
  kind: "rk" as const,
  scopes: ["money:read", "customers:read"],
  ipAllowlist: [],
  expiresIn: "90d" as const,
};

async function events(target: string) {
  const result = await su.query<{
    event: string;
    metadata: Record<string, unknown>;
    ref_ids: string[];
    step_up_ref: string | null;
    mode: string;
  }>(
    "SELECT event, metadata, ref_ids, step_up_ref, mode FROM audit.event WHERE target_id = $1 ORDER BY id",
    [target],
  );
  return result.rows;
}

async function outbox(keyId: string) {
  const result = await su.query<{ recipient: string; params: Record<string, unknown> }>(
    `SELECT recipient, params FROM email.outbox
      WHERE template = 'api-keys/key-changed' AND params ->> 'keyId' = $1 ORDER BY recipient, id`,
    [keyId],
  );
  return result.rows;
}

describe("create", () => {
  it("shows the secret once, stores only its hash, audits and tells every member", async () => {
    const actor = actorOf(OWNER, ALL);
    const made = await inUnit(console_, (tx) => createKey(keys, tx, actor, restricted));
    expect(verifyChecksum(made.secret, saltFor("ci"))).toBe(true);
    expect(made.key).toMatchObject({
      name: "Payout worker",
      mode: "test",
      kind: "rk",
      access: "Restricted · 2 scopes",
      scopes: ["customers:read", "money:read"],
      status: "active",
      createdBy: { userId: OWNER.userId, name: "Ada Owner" },
      flags: { makerLacksPermissions: false, secretUnseen: false },
    });
    expect(made.key.prefix).toBe(`fin_test_rk_${made.key.keyId}`);
    expect(made.key.expiresAt).not.toBeNull();
    expect(actor.asked).toEqual([{ body: restricted, target: null }]);

    const row = (
      await su.query<{ hash: Buffer; pepper_versions: number[]; seen_by: string[] }>(
        "SELECT hash, pepper_versions, seen_by FROM keys.api_key WHERE id = $1",
        [made.key.keyId],
      )
    ).rows[0];
    expect(row?.seen_by).toEqual([OWNER.userId]);
    expect(
      matchesStored(
        peppers,
        made.secret.slice(0, -6),
        new Uint8Array(row?.hash as Buffer),
        row?.pepper_versions as number[],
      ),
    ).toBe(true);
    const dump = JSON.stringify((await su.query("SELECT * FROM keys.api_key")).rows);
    expect(dump).not.toContain(made.secret.slice(12, 54));

    const audit = await events(made.key.keyId);
    expect(audit.map((e) => e.event)).toEqual(["api_key.created"]);
    expect(audit[0]?.metadata).toEqual({
      key_id: made.key.keyId,
      mode: "test",
      kind: "rk",
      scopes: ["customers:read", "money:read"],
      expires_at: made.key.expiresAt,
      allowlist_count: 0,
      shown_to: OWNER.userId,
    });
    expect(audit[0]?.step_up_ref).toBe(fixtureId("sti", 1));
    expect(audit[0]?.mode).toBe("sandbox");
    const mail = await outbox(made.key.keyId);
    expect(mail.map((m) => m.recipient)).toEqual(["ada.owner@example.com", "dev.one@example.com"]);
    expect(mail[0]?.params).toMatchObject({
      change: "created",
      keyName: "Payout worker",
      mode: "sandbox",
    });
    expect(JSON.stringify(mail)).not.toContain(made.secret);
  });

  it("refuses beyond the maker's role, before any step-up", async () => {
    const actor = actorOf(DEV, DEVELOPER);
    await expect(
      inUnit(console_, (tx) =>
        createKey(keys, tx, actor, { ...restricted, kind: "sk", scopes: [] }),
      ),
    ).rejects.toMatchObject({ code: "forbidden", lineReason: "keys.beyond_role" });
    await expect(
      inUnit(console_, (tx) =>
        createKey(keys, tx, actor, { ...restricted, scopes: ["customers:write"] }),
      ),
    ).rejects.toMatchObject({ code: "forbidden", extensions: { permission: "customers.delete" } });
    expect(actor.asked).toEqual([]);
  });

  it("refuses a Production key before go-live, and one without apiKey.live", async () => {
    await expect(
      inUnit(console_, (tx) =>
        createKey(keys, tx, actorOf(OWNER, ALL), { ...restricted, mode: "live" }),
      ),
    ).rejects.toMatchObject({ code: "forbidden", lineReason: "keys.live_not_enabled" });
    await expect(
      inUnit(console_, (tx) =>
        createKey(keys, tx, actorOf(DEV, DEVELOPER, "approved"), { ...restricted, mode: "live" }),
      ),
    ).rejects.toMatchObject({ code: "forbidden", extensions: { permission: "apiKey.live" } });
  });

  it("makes a Production key once approved, and needs an allowlist on one that moves money", async () => {
    const owner = actorOf(OWNER, ALL, "approved");
    await expect(
      inUnit(console_, (tx) =>
        createKey(keys, tx, owner, { ...restricted, mode: "live", scopes: ["money:write"] }),
      ),
    ).rejects.toMatchObject({
      code: "invalid",
      extensions: { fields: [{ path: "ipAllowlist", code: "required_for_money" }] },
    });
    const made = await inUnit(console_, (tx) =>
      createKey(keys, tx, owner, {
        ...restricted,
        mode: "live",
        scopes: ["money:write"],
        ipAllowlist: ["8.8.8.9/24"],
      }),
    );
    expect(made.secret.startsWith("fin_live_rk_")).toBe(true);
    expect(made.key.ipAllowlist).toEqual(["8.8.8.0/24"]);
  });

  it("refuses a name that reads as a web address, and a refused allowlist entry with its position", async () => {
    const actor = actorOf(OWNER, ALL);
    await expect(
      inUnit(console_, (tx) => createKey(keys, tx, actor, { ...restricted, name: "ledger.sync" })),
    ).rejects.toMatchObject({ extensions: { fields: [{ path: "name", code: "web_address" }] } });
    await expect(
      inUnit(console_, (tx) =>
        createKey(keys, tx, actor, { ...restricted, ipAllowlist: ["8.8.8.8", "127.0.0.1"] }),
      ),
    ).rejects.toMatchObject({
      extensions: { fields: [{ path: "ipAllowlist.1", code: "loopback" }] },
    });
    expect(actor.asked).toEqual([]);
  });
});

describe("edit, roll and revoke", () => {
  it("audits and emails an edit of the name alone; scopes only narrow; expiry only shortens", async () => {
    const owner = actorOf(OWNER, ALL);
    const made = await inUnit(console_, (tx) => createKey(keys, tx, owner, restricted));
    const id = made.key.keyId;
    const renamed = await inUnit(console_, (tx) =>
      updateKey(keys, tx, owner, id, { name: "Payouts" }),
    );
    expect(renamed.name).toBe("Payouts");
    await expect(
      inUnit(console_, (tx) =>
        updateKey(keys, tx, owner, id, { scopes: ["money:read", "events:read"] }),
      ),
    ).rejects.toMatchObject({ extensions: { fields: [{ path: "scopes", code: "not_narrower" }] } });
    const far = new Date(Date.now() + 400 * 86_400_000).toISOString();
    await expect(
      inUnit(console_, (tx) => updateKey(keys, tx, owner, id, { expiresAt: far })),
    ).rejects.toMatchObject({
      extensions: { fields: [{ path: "expiresAt", code: "not_shorter" }] },
    });
    await expect(
      inUnit(console_, (tx) => updateKey(keys, tx, owner, id, { name: "Payouts" })),
    ).rejects.toMatchObject({ extensions: { fields: [{ path: "body", code: "no_change" }] } });
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const narrowed = await inUnit(console_, (tx) =>
      updateKey(keys, tx, owner, id, { scopes: ["money:read"], expiresAt: soon }),
    );
    expect(narrowed.scopes).toEqual(["money:read"]);
    expect(narrowed.expiresAt).toBe(soon);
    const audit = await events(id);
    expect(audit.map((e) => e.event)).toEqual([
      "api_key.created",
      "api_key.updated",
      "api_key.updated",
    ]);
    expect(audit[1]?.metadata).toMatchObject({
      changed: ["name"],
      scopes_removed: [],
      expiry_shortened: false,
    });
    expect(audit[2]?.metadata).toMatchObject({
      changed: ["scopes", "expires_at"],
      scopes_removed: ["customers:read"],
      expiry_shortened: true,
    });
    expect((await outbox(id)).filter((m) => m.params.change === "edited")).toHaveLength(4);
  });

  it("rolls a key: a new key with the same access and life, the old one working for the overlap", async () => {
    const owner = actorOf(OWNER, ALL);
    const made = await inUnit(console_, (tx) =>
      createKey(keys, tx, owner, { ...restricted, ipAllowlist: ["8.8.8.0/24"] }),
    );
    const rolled = await inUnit(console_, (tx) =>
      rollKey(keys, tx, owner, made.key.keyId, { overlap: "1h" }),
    );
    expect(rolled.secret).not.toBe(made.secret);
    expect(rolled.key).toMatchObject({
      name: made.key.name,
      scopes: made.key.scopes,
      ipAllowlist: ["8.8.8.0/24"],
      expiresAt: made.key.expiresAt,
      status: "active",
    });
    expect(rolled.replaced).toMatchObject({ status: "rolling", replacedBy: rolled.key.keyId });
    const until = Date.parse(rolled.replaced.rollingUntil as string);
    expect(until - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(until - Date.now()).toBeLessThan(61 * 60_000);
    const audit = await events(made.key.keyId);
    expect(audit.at(-1)).toMatchObject({
      event: "api_key.rolled",
      ref_ids: [rolled.key.keyId],
      metadata: {
        key_id: made.key.keyId,
        new_key_id: rolled.key.keyId,
        overlap: "1h",
        shown_to: OWNER.userId,
      },
    });
    const journal = await su.query(
      "SELECT kind FROM audit.journal_entry je JOIN audit.event e ON e.id = je.audit_event_id WHERE e.target_id = $1",
      [made.key.keyId],
    );
    expect(journal.rows).toEqual([{ kind: "key_rolled" }]);
    // A key already rolled cannot be rolled again; its replacement can.
    await expect(
      inUnit(console_, (tx) => rollKey(keys, tx, owner, made.key.keyId, { overlap: "now" })),
    ).rejects.toMatchObject({ code: "conflict" });
    const again = await inUnit(console_, (tx) =>
      rollKey(keys, tx, owner, rolled.key.keyId, { overlap: "now" }),
    );
    expect(again.replaced.status).toBe("expired");
  });

  it("never keeps the old key past its own expiry, and refuses a roll beyond the roller's role", async () => {
    const owner = actorOf(OWNER, ALL);
    const full = await inUnit(console_, (tx) =>
      createKey(keys, tx, owner, { ...restricted, kind: "sk", scopes: [], expiresIn: "30d" }),
    );
    await inUnit(console_, (tx) =>
      updateKey(keys, tx, owner, full.key.keyId, {
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    );
    await expect(
      inUnit(console_, (tx) =>
        rollKey(keys, tx, actorOf(DEV, DEVELOPER), full.key.keyId, { overlap: "24h" }),
      ),
    ).rejects.toMatchObject({ code: "forbidden", lineReason: "keys.beyond_role" });
    const rolled = await inUnit(console_, (tx) =>
      rollKey(keys, tx, owner, full.key.keyId, { overlap: "24h" }),
    );
    const until = Date.parse(rolled.replaced.rollingUntil as string);
    expect(until).toBeLessThanOrEqual(Date.parse(rolled.replaced.expiresAt as string));
  });

  it("revokes at once, writes the journal entry, and answers already_done the second time", async () => {
    const owner = actorOf(OWNER, ALL);
    const made = await inUnit(console_, (tx) => createKey(keys, tx, owner, restricted));
    const revoked = await inUnit(console_, (tx) => revokeKey(keys, tx, owner, made.key.keyId));
    expect(revoked).toMatchObject({ status: "revoked", revokedReason: "member" });
    const audit = await events(made.key.keyId);
    expect(audit.at(-1)).toMatchObject({
      event: "api_key.revoked",
      metadata: { key_id: made.key.keyId, reason: "member", source: null },
    });
    const journal = await su.query(
      "SELECT kind FROM audit.journal_entry je JOIN audit.event e ON e.id = je.audit_event_id WHERE e.target_id = $1",
      [made.key.keyId],
    );
    expect(journal.rows).toEqual([{ kind: "key_revoked" }]);
    await expect(
      inUnit(console_, (tx) => revokeKey(keys, tx, owner, made.key.keyId)),
    ).rejects.toMatchObject({ code: "already_done" });
    expect((await outbox(made.key.keyId)).map((m) => m.params.change)).toContain("revoked");
  });

  it("answers another organisation's key as an unknown one", async () => {
    const other = { ...actorOf(OWNER, ALL), organizationId: fixtureId("org", 99) };
    const made = await inUnit(console_, (tx) =>
      createKey(keys, tx, actorOf(OWNER, ALL), restricted),
    );
    await expect(
      inUnit(console_, (tx) => revokeKey(keys, tx, other, made.key.keyId)),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("the list, the limit and a leaving member's keys", () => {
  it("lists a mode's keys newest first with their statuses and the role's abilities", async () => {
    const actor = actorOf(OWNER, ALL);
    const list = await inUnit(console_, (tx) =>
      listKeys(
        tx,
        actor,
        { mode: "test", page: 1, size: 100 },
        async (ids) => new Map(ids.map((id) => [id, new Set(ALL)])),
      ),
    );
    expect(list.keys.length).toBeGreaterThan(3);
    expect(list.total).toBe(list.keys.length);
    const created = list.keys.map((k) => k.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
    expect(new Set(list.keys.map((k) => k.status))).toEqual(
      new Set(["active", "rolling", "expired", "revoked"]),
    );
    expect(list.can.test).toMatchObject({ manage: true, fullAccess: true });
    expect(list.can.live).toMatchObject({ manage: true, approved: false });
    expect(list.limit).toBe(WORKING_KEY_LIMIT);
    const flagged = await inUnit(console_, (tx) =>
      listKeys(
        tx,
        actor,
        { mode: "test", page: 1, size: 100 },
        async (ids) => new Map(ids.map((id) => [id, null])),
      ),
    );
    expect(flagged.keys.every((k) => k.flags.makerLacksPermissions)).toBe(true);
  });

  it("refuses the 51st working key, a rolling old key not counted", async () => {
    const actor = actorOf(OWNER, ALL);
    const working = Number(
      (
        await su.query<{ n: string }>(
          "SELECT count(*) AS n FROM keys.api_key WHERE organization_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND rolling_until IS NULL",
          [ORG],
        )
      ).rows[0]?.n,
    );
    for (let i = working; i < WORKING_KEY_LIMIT; i++) {
      await inUnit(console_, (tx) =>
        createKey(keys, tx, actor, { ...restricted, name: `Bulk ${i}` }),
      );
    }
    await expect(
      inUnit(console_, (tx) => createKey(keys, tx, actor, { ...restricted, name: "One too many" })),
    ).rejects.toMatchObject({ code: "limit_reached", extensions: { limit: WORKING_KEY_LIMIT } });
    expect(actor.asked.length).toBe(WORKING_KEY_LIMIT - working);
  });

  it("lists what a member made or saw, and rolls it with nobody shown the new secrets", async () => {
    const mine = await inUnit(console_, (tx) => keysOfMember(tx, ORG, OWNER.userId));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]?.label).toMatch(
      /^(Sandbox|Production) key fin_(test|live)_(sk|rk)_[0-9A-Z]{10}$/,
    );
    const first = mine.slice(0, 2);
    const rolled = await inUnit(console_, (tx) =>
      rollForMember(
        keys,
        tx,
        { id: ORG, name: "Example Payments" },
        first.map((k) => k.id),
        "1h",
        {
          kind: "user",
          id: DEV.userId,
          via: "console",
        },
      ),
    );
    expect(rolled).toBe(2);
    const audit = await events(first[0]?.id as string);
    expect(audit.at(-1)).toMatchObject({
      event: "api_key.rolled",
      metadata: { overlap: "1h", shown_to: null },
    });
    const replacement = (
      await su.query<{ seen_by: string[] }>(
        "SELECT n.seen_by FROM keys.api_key o JOIN keys.api_key n ON n.id = o.replaced_by WHERE o.id = $1",
        [first[0]?.id],
      )
    ).rows[0];
    expect(replacement?.seen_by).toEqual([]);
  });
});
