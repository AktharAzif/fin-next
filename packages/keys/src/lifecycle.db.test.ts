// The key lifecycle on Postgres 18 as the console's own login (T05-15: each `api_keys` event written by
// its action, in the action's transaction; spec 02 §12.2, §12.3; spec 05 §4.6): create with the secret
// shown once and only the hash stored, an edit (a name alone included), a roll with its overlap, a
// revocation, the 50-key limit, the actor's role bounding every key they make, roll or re-point, the
// key's own mode's permission on every change, and the refusals that come before any step-up. A
// leaving member's keys include an old key still inside a roll's overlap, whose overlap the removal
// cuts so the edge (its own login, its own statement and check) refuses it. The step-up itself is the
// console's (apps/console/src/server/keys.db.test.ts); here `confirm` records that it was asked.
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
import { keyStore } from "./lookup.ts";
import { saltFor } from "./salts.ts";
import { judgeKey, precheck } from "./verify.ts";

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
// A second organisation, away from the first one's 50-key limit, for the leaving member's keys and
// the per-mode checks.
const ORG2 = fixtureId("org", 2);
const OWNER2 = { userId: fixtureId("usr", 3), memberId: fixtureId("mem", 3) };
const DEV2 = { userId: fixtureId("usr", 4), memberId: fixtureId("mem", 4) };
const LEAVER = { userId: fixtureId("usr", 5), memberId: fixtureId("mem", 5) };
const SELF_ROLLER = { userId: fixtureId("usr", 6), memberId: fixtureId("mem", 6) };
// A third, for the list's paging past 100 rows.
const ORG3 = fixtureId("org", 3);
const OWNER3 = { userId: OWNER2.userId, memberId: fixtureId("mem", 7) };
const LIVE_ONLY = ALL.filter((p) => p !== "apiKey.sandbox");
const SANDBOX_ONLY = ALL.filter((p) => p !== "apiKey.live");
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
let edge: PlatformClient;

beforeAll(async () => {
  platform = await createKeysPlatform("keyslife");
  su = await platform.superuser();
  console_ = await platform.login("fin_console_a");
  edge = await platform.login("fin_edge_a");
  await seedOrganization(su, {
    orgId: ORG,
    name: "Example Payments",
    people: [
      { ...OWNER, name: "Ada Owner", email: "ada.owner@example.com", roleKey: "super_admin" },
      { ...DEV, name: "Dev One", email: "dev.one@example.com", roleKey: "admin" },
    ],
  });
  await seedOrganization(su, {
    orgId: ORG2,
    name: "Example Remit",
    liveStatus: "approved",
    people: [
      { ...OWNER2, name: "Bo Owner", email: "bo.owner@example.org", roleKey: "super_admin" },
      { ...DEV2, name: "Dev Two", email: "dev.two@example.org", roleKey: "admin" },
      { ...LEAVER, name: "Lee Leaver", email: "lee.leaver@example.org", roleKey: "admin" },
      { ...SELF_ROLLER, name: "Sam Roller", email: "sam.roller@example.org", roleKey: "admin" },
    ],
  });
  await seedOrganization(su, {
    orgId: ORG3,
    name: "Example Ledger",
    people: [
      { ...OWNER3, name: "Bo Owner", email: "bo.owner@example.org", roleKey: "super_admin" },
    ],
  });
});

afterAll(async () => {
  await edge?.end();
  await console_?.end();
  await su?.end();
  await platform?.drop();
});

/** What the edge answers for this key now: its own statement as fin_edge, then its check. */
async function atTheEdge(secret: string) {
  const pre = precheck(`Bearer ${secret}`, saltFor("ci"));
  if (!pre.ok) throw new Error(pre.reason);
  const lookup = await keyStore(edge).lookup(pre.key.id, "edge:refused_keys:lifecycle-test");
  return judgeKey({
    key: pre.key,
    record: lookup.record,
    peppers,
    now: Date.now(),
    clientIp: "8.8.8.8",
  });
}

function actorOf(
  who: { userId: string },
  permissions: readonly string[],
  liveStatus = "sandbox",
  organizationId = ORG,
) {
  const asked: { body: Record<string, unknown>; target: string | null }[] = [];
  const actor: KeyActor & { asked: typeof asked } = {
    userId: who.userId,
    organizationId,
    organizationName:
      organizationId === ORG
        ? "Example Payments"
        : organizationId === ORG2
          ? "Example Remit"
          : "Example Ledger",
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
    `SELECT recipient, params FROM email_private.outbox
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
    // The mode's own permission is the first check, before the role bounds the key's scopes.
    await expect(
      inUnit(console_, (tx) =>
        createKey(keys, tx, actorOf(DEV, DEVELOPER, "approved"), { ...restricted, mode: "live" }),
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      lineReason: "policy.permission",
      extensions: { permission: "apiKey.live" },
    });
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
  it("lists a mode's keys the edge accepts first, each group newest first, with the role's abilities", async () => {
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
    const accepted = (status: string) => status === "active" || status === "rolling";
    const firstEnded = list.keys.findIndex((k) => !accepted(k.status));
    expect(firstEnded).toBeGreaterThan(0);
    expect(list.keys.slice(firstEnded).every((k) => !accepted(k.status))).toBe(true);
    for (const group of [list.keys.slice(0, firstEnded), list.keys.slice(firstEnded)]) {
      const created = group.map((k) => k.createdAt);
      expect([...created].sort().reverse()).toEqual(created);
    }
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

describe("a leaving member's key in a roll's overlap (SA-33, S2-42)", () => {
  const remover = { kind: "user" as const, id: OWNER2.userId, via: "console" as const };
  const org2 = { id: ORG2, name: "Example Remit" };

  it("lists a key the member made that someone rolled with 24 hours of overlap, and the removal cuts it at once", async () => {
    const made = await inUnit(console_, (tx) =>
      createKey(keys, tx, actorOf(LEAVER, DEVELOPER, "approved", ORG2), restricted),
    );
    const rolled = await inUnit(console_, (tx) =>
      rollKey(keys, tx, actorOf(OWNER2, ALL, "approved", ORG2), made.key.keyId, {
        overlap: "24h",
      }),
    );
    expect(await atTheEdge(made.secret)).toMatchObject({ ok: true });

    // The old key still works for a day, so it is listed; its replacement was made and seen by the
    // owner who rolled it, so it is not.
    const listed = await inUnit(console_, (tx) => keysOfMember(tx, ORG2, LEAVER.userId));
    expect(listed).toEqual([
      expect.objectContaining({ id: made.key.keyId, made: true, seen: true }),
    ]);
    const changed = await inUnit(console_, (tx) =>
      rollForMember(
        keys,
        tx,
        org2,
        listed.map((k) => k.id),
        "now",
        remover,
      ),
    );
    expect(changed).toBe(1);
    expect(await atTheEdge(made.secret)).toEqual({ ok: false, reason: "expired" });
    expect(await atTheEdge(rolled.secret)).toMatchObject({ ok: true });
    expect((await events(made.key.keyId)).at(-1)).toMatchObject({
      event: "api_key.rolled",
      ref_ids: [rolled.key.keyId],
      metadata: {
        key_id: made.key.keyId,
        new_key_id: rolled.key.keyId,
        overlap: "now",
        shown_to: null,
      },
    });
    const journal = await su.query<{ kind: string }>(
      "SELECT kind FROM audit.journal_entry je JOIN audit.event e ON e.id = je.audit_event_id WHERE e.target_id = $1 ORDER BY je.recorded_at",
      [made.key.keyId],
    );
    expect(journal.rows.map((r) => r.kind)).toEqual(["key_rolled", "key_rolled"]);
    // Every member is told of both rolls.
    expect((await outbox(made.key.keyId)).filter((m) => m.params.change === "rolled")).toHaveLength(
      8,
    );
    // Nothing is left for the member.
    expect(await inUnit(console_, (tx) => keysOfMember(tx, ORG2, LEAVER.userId))).toEqual([]);
  });

  it("cuts the 24 hours a member gave their own old key to the hour when the actor may not roll it", async () => {
    const self = actorOf(SELF_ROLLER, DEVELOPER, "approved", ORG2);
    const made = await inUnit(console_, (tx) => createKey(keys, tx, self, restricted));
    const rolled = await inUnit(console_, (tx) =>
      rollKey(keys, tx, self, made.key.keyId, { overlap: "24h" }),
    );
    const listed = await inUnit(console_, (tx) => keysOfMember(tx, ORG2, SELF_ROLLER.userId));
    expect(listed.map((k) => k.id)).toEqual([made.key.keyId, rolled.key.keyId]);
    const changed = await inUnit(console_, (tx) =>
      rollForMember(
        keys,
        tx,
        org2,
        listed.map((k) => k.id),
        "1h",
        remover,
      ),
    );
    expect(changed).toBe(2);
    const rows = await su.query<{ id: string; left: number }>(
      "SELECT id, extract(epoch FROM rolling_until - now())::float8 AS left FROM keys.api_key WHERE id = ANY ($1::text[]) ORDER BY created_at",
      [[made.key.keyId, rolled.key.keyId]],
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.left, row.id).toBeGreaterThan(55 * 60);
      expect(row.left, row.id).toBeLessThanOrEqual(3600);
    }
    // Both still work within the hour (S2-42: no outage in one act), then stop.
    expect(await atTheEdge(made.secret)).toMatchObject({ ok: true });
    expect(await atTheEdge(rolled.secret)).toMatchObject({ ok: true });
    expect((await events(made.key.keyId)).at(-1)).toMatchObject({
      event: "api_key.rolled",
      metadata: { new_key_id: rolled.key.keyId, overlap: "1h", shown_to: null },
    });
  });

  it("leaves an overlap that already ends within the hour as it is", async () => {
    const self = actorOf(SELF_ROLLER, DEVELOPER, "approved", ORG2);
    const made = await inUnit(console_, (tx) => createKey(keys, tx, self, restricted));
    await inUnit(console_, (tx) => rollKey(keys, tx, self, made.key.keyId, { overlap: "1h" }));
    const before = await su.query<{ rolling_until: Date }>(
      "SELECT rolling_until FROM keys.api_key WHERE id = $1",
      [made.key.keyId],
    );
    const eventsBefore = (await events(made.key.keyId)).length;
    const changed = await inUnit(console_, (tx) =>
      rollForMember(keys, tx, org2, [made.key.keyId], "1h", remover),
    );
    expect(changed).toBe(0);
    const after = await su.query<{ rolling_until: Date }>(
      "SELECT rolling_until FROM keys.api_key WHERE id = $1",
      [made.key.keyId],
    );
    expect(after.rows[0]?.rolling_until).toEqual(before.rows[0]?.rolling_until);
    expect(await events(made.key.keyId)).toHaveLength(eventsBefore);
  });

  it("cuts a key the edge still accepts that names a replacement but no overlap", async () => {
    // No action writes this (a roll sets both together), but the table allows it: every key listed
    // is rolled or cut, whatever its row holds.
    const made = await inUnit(console_, (tx) =>
      createKey(keys, tx, actorOf(LEAVER, DEVELOPER, "approved", ORG2), {
        ...restricted,
        name: "Replacement named",
      }),
    );
    const other = await inUnit(console_, (tx) =>
      createKey(keys, tx, actorOf(OWNER2, ALL, "approved", ORG2), {
        ...restricted,
        name: "The replacement",
      }),
    );
    await su.query("BEGIN");
    await su.query("SET LOCAL session_replication_role = replica");
    await su.query("UPDATE keys.api_key SET replaced_by = $2 WHERE id = $1", [
      made.key.keyId,
      other.key.keyId,
    ]);
    await su.query("COMMIT");
    expect(await atTheEdge(made.secret)).toMatchObject({ ok: true });
    const listed = await inUnit(console_, (tx) => keysOfMember(tx, ORG2, LEAVER.userId));
    expect(listed.map((k) => k.id)).toEqual([made.key.keyId]);
    const changed = await inUnit(console_, (tx) =>
      rollForMember(
        keys,
        tx,
        org2,
        listed.map((k) => k.id),
        "now",
        remover,
      ),
    );
    expect(changed).toBe(1);
    expect(await atTheEdge(made.secret)).toEqual({ ok: false, reason: "expired" });
    expect(await atTheEdge(other.secret)).toMatchObject({ ok: true });
    expect((await events(made.key.keyId)).at(-1)).toMatchObject({
      event: "api_key.rolled",
      metadata: { new_key_id: other.key.keyId, overlap: "now", shown_to: null },
    });
  });
});

describe("a roll's maker", () => {
  it("is the member who rolled the key: a Super admin's roll clears the 'maker lacks permissions' flag", async () => {
    const made = await inUnit(console_, (tx) =>
      createKey(keys, tx, actorOf(DEV2, DEVELOPER, "approved", ORG2), {
        ...restricted,
        name: "Maker check",
      }),
    );
    const rolled = await inUnit(console_, (tx) =>
      rollKey(keys, tx, actorOf(OWNER2, ALL, "approved", ORG2), made.key.keyId, {
        overlap: "1h",
      }),
    );
    expect(rolled.key.createdBy).toEqual({ userId: OWNER2.userId, name: "Bo Owner" });
    // With the first maker gone, only the key they made is flagged.
    const list = await inUnit(console_, (tx) =>
      listKeys(
        tx,
        actorOf(OWNER2, ALL, "approved", ORG2),
        { mode: "test", page: 1, size: 100 },
        async (ids) => new Map(ids.map((id) => [id, id === OWNER2.userId ? new Set(ALL) : null])),
      ),
    );
    const byId = new Map(list.keys.map((k) => [k.keyId, k]));
    expect(byId.get(rolled.key.keyId)?.flags).toEqual({
      makerLacksPermissions: false,
      secretUnseen: false,
    });
    expect(byId.get(made.key.keyId)?.flags.makerLacksPermissions).toBe(true);
    // The first maker's departure lists the key they made (still in its overlap), never the
    // successor someone else rolled and holds.
    const theirs = await inUnit(console_, (tx) => keysOfMember(tx, ORG2, DEV2.userId));
    expect(theirs.map((k) => k.id)).toContain(made.key.keyId);
    expect(theirs.map((k) => k.id)).not.toContain(rolled.key.keyId);
  });

  it("is whoever removed the member when the removal rolled it, and nobody is shown its secret", async () => {
    const made = await inUnit(console_, (tx) =>
      createKey(keys, tx, actorOf(DEV2, DEVELOPER, "approved", ORG2), {
        ...restricted,
        name: "Removal maker",
      }),
    );
    await inUnit(console_, (tx) =>
      rollForMember(keys, tx, { id: ORG2, name: "Example Remit" }, [made.key.keyId], "now", {
        kind: "user",
        id: OWNER2.userId,
        via: "console",
      }),
    );
    const replacement = await su.query<{ created_by: string; seen_by: string[] }>(
      "SELECT n.created_by, n.seen_by FROM keys.api_key o JOIN keys.api_key n ON n.id = o.replaced_by WHERE o.id = $1",
      [made.key.keyId],
    );
    expect(replacement.rows[0]).toEqual({ created_by: OWNER2.userId, seen_by: [] });
  });
});

describe("the key's own mode, and the role behind an allowlist change", () => {
  it("refuses an edit, a roll and a revocation of a key whose mode the role cannot manage, before any step-up", async () => {
    const owner = actorOf(OWNER2, ALL, "approved", ORG2);
    const live = await inUnit(console_, (tx) =>
      createKey(keys, tx, owner, { ...restricted, mode: "live", name: "Live mode check" }),
    );
    const sandbox = await inUnit(console_, (tx) =>
      createKey(keys, tx, owner, { ...restricted, name: "Sandbox mode check" }),
    );
    const sandboxOnly = actorOf(DEV2, SANDBOX_ONLY, "approved", ORG2);
    const liveOnly = actorOf(DEV2, LIVE_ONLY, "approved", ORG2);
    const cases = [
      [sandboxOnly, live.key.keyId, "apiKey.live"],
      [liveOnly, sandbox.key.keyId, "apiKey.sandbox"],
    ] as const;
    for (const [actor, keyId, permission] of cases) {
      const refused = {
        code: "forbidden",
        lineReason: "policy.permission",
        extensions: { permission },
      };
      await expect(
        inUnit(console_, (tx) => updateKey(keys, tx, actor, keyId, { name: "Renamed" })),
      ).rejects.toMatchObject(refused);
      await expect(
        inUnit(console_, (tx) => rollKey(keys, tx, actor, keyId, { overlap: "now" })),
      ).rejects.toMatchObject(refused);
      await expect(
        inUnit(console_, (tx) => revokeKey(keys, tx, actor, keyId)),
      ).rejects.toMatchObject(refused);
      expect(actor.asked).toEqual([]);
    }
    // Each may change a key of the mode it manages.
    const renamed = await inUnit(console_, (tx) =>
      updateKey(keys, tx, sandboxOnly, sandbox.key.keyId, { name: "Renamed sandbox" }),
    );
    expect(renamed.name).toBe("Renamed sandbox");
    const revoked = await inUnit(console_, (tx) => revokeKey(keys, tx, liveOnly, live.key.keyId));
    expect(revoked.status).toBe("revoked");
  });

  it("refuses an allowlist change on a key beyond the editor's role, before any step-up; a rename stays open", async () => {
    const owner = actorOf(OWNER2, ALL, "approved", ORG2);
    const money = await inUnit(console_, (tx) =>
      createKey(keys, tx, owner, {
        ...restricted,
        mode: "live",
        name: "Payouts live",
        scopes: ["customers:read", "money:write"],
        ipAllowlist: ["8.8.8.0/24"],
      }),
    );
    const id = money.key.keyId;
    const noTransfers = actorOf(
      DEV2,
      ALL.filter((p) => p !== "money.transfer"),
      "approved",
      ORG2,
    );
    await expect(
      inUnit(console_, (tx) =>
        updateKey(keys, tx, noTransfers, id, { ipAllowlist: ["8.8.4.0/24"] }),
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      lineReason: "keys.beyond_role",
      extensions: { permission: "money.transfer", reason: "beyond_role" },
    });
    expect(noTransfers.asked).toEqual([]);
    // A rename, and an allowlist change on the key as narrowed to what the role holds, are theirs.
    const renamed = await inUnit(console_, (tx) =>
      updateKey(keys, tx, noTransfers, id, { name: "Payouts live two" }),
    );
    expect(renamed.ipAllowlist).toEqual(["8.8.8.0/24"]);
    const narrowed = await inUnit(console_, (tx) =>
      updateKey(keys, tx, noTransfers, id, {
        scopes: ["customers:read"],
        ipAllowlist: ["8.8.4.0/24"],
      }),
    );
    expect(narrowed).toMatchObject({ scopes: ["customers:read"], ipAllowlist: ["8.8.4.0/24"] });
    // A role that holds the key may re-point it.
    const other = await inUnit(console_, (tx) =>
      createKey(keys, tx, owner, {
        ...restricted,
        mode: "live",
        name: "Payouts live three",
        scopes: ["money:write"],
        ipAllowlist: ["8.8.8.0/24"],
      }),
    );
    const moved = await inUnit(console_, (tx) =>
      updateKey(keys, tx, owner, other.key.keyId, { ipAllowlist: ["8.8.4.0/24"] }),
    );
    expect(moved.ipAllowlist).toEqual(["8.8.4.0/24"]);
  });
});

describe("the edit's own rules, before any step-up", () => {
  it("refuses an edit of a key that is rolling, rolled away or revoked", async () => {
    const owner = actorOf(OWNER2, ALL, "approved", ORG2);
    const rolling = await inUnit(console_, (tx) =>
      createKey(keys, tx, owner, { ...restricted, name: "Edit rolling" }),
    );
    await inUnit(console_, (tx) => rollKey(keys, tx, owner, rolling.key.keyId, { overlap: "1h" }));
    const ended = await inUnit(console_, (tx) =>
      createKey(keys, tx, owner, { ...restricted, name: "Edit ended" }),
    );
    await inUnit(console_, (tx) => rollKey(keys, tx, owner, ended.key.keyId, { overlap: "now" }));
    const revoked = await inUnit(console_, (tx) =>
      createKey(keys, tx, owner, { ...restricted, name: "Edit revoked" }),
    );
    await inUnit(console_, (tx) => revokeKey(keys, tx, owner, revoked.key.keyId));
    const editor = actorOf(OWNER2, ALL, "approved", ORG2);
    for (const id of [rolling.key.keyId, ended.key.keyId, revoked.key.keyId]) {
      // An old key in its overlap keeps the allowlist it was rolled with: nobody re-points it.
      await expect(
        inUnit(console_, (tx) => updateKey(keys, tx, editor, id, { ipAllowlist: ["8.8.8.0/24"] })),
        id,
      ).rejects.toMatchObject({
        code: "conflict",
        lineReason: "keys.not_active",
        extensions: { reason: "not_active" },
      });
    }
    expect(editor.asked).toEqual([]);
  });

  it("refuses an expiry that is unreadable or already past", async () => {
    const owner = actorOf(OWNER2, ALL, "approved", ORG2);
    const made = await inUnit(console_, (tx) =>
      createKey(keys, tx, owner, { ...restricted, name: "Edit expiry" }),
    );
    const editor = actorOf(OWNER2, ALL, "approved", ORG2);
    await expect(
      inUnit(console_, (tx) =>
        updateKey(keys, tx, editor, made.key.keyId, {
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid",
      extensions: { fields: [{ path: "expiresAt", code: "in_the_past" }] },
    });
    await expect(
      inUnit(console_, (tx) =>
        updateKey(keys, tx, editor, made.key.keyId, { expiresAt: "next Tuesday" }),
      ),
    ).rejects.toMatchObject({
      code: "invalid",
      extensions: { fields: [{ path: "expiresAt", code: "invalid_format" }] },
    });
    expect(editor.asked).toEqual([]);
    expect(await atTheEdge(made.secret)).toMatchObject({ ok: true });
  });

  it("keeps the allowlist on a Production key that can move money, a full-access one included ([MO-20])", async () => {
    const owner = actorOf(OWNER2, ALL, "approved", ORG2);
    const full = await inUnit(console_, (tx) =>
      createKey(keys, tx, owner, {
        ...restricted,
        mode: "live",
        kind: "sk",
        scopes: [],
        name: "Live full access",
        ipAllowlist: ["8.8.8.0/24"],
      }),
    );
    const money = await inUnit(console_, (tx) =>
      createKey(keys, tx, owner, {
        ...restricted,
        mode: "live",
        scopes: ["customers:read", "money:write"],
        name: "Live transfers",
        ipAllowlist: ["8.8.8.0/24"],
      }),
    );
    const editor = actorOf(OWNER2, ALL, "approved", ORG2);
    for (const id of [full.key.keyId, money.key.keyId]) {
      await expect(
        inUnit(console_, (tx) => updateKey(keys, tx, editor, id, { ipAllowlist: [] })),
        id,
      ).rejects.toMatchObject({
        code: "invalid",
        extensions: { fields: [{ path: "ipAllowlist", code: "required_for_money" }] },
      });
    }
    expect(editor.asked).toEqual([]);
    // The rule reads the key as edited: once it can no longer move money, the allowlist may go.
    const narrowed = await inUnit(console_, (tx) =>
      updateKey(keys, tx, editor, money.key.keyId, { scopes: ["customers:read"], ipAllowlist: [] }),
    );
    expect(narrowed).toMatchObject({ scopes: ["customers:read"], ipAllowlist: [] });
  });
});

describe("the list past one page", () => {
  it("keeps an old working key on the first page whatever ended keys came after it, and pages the rest", async () => {
    const owner = actorOf(OWNER3, ALL, "sandbox", ORG3);
    const old = await inUnit(console_, (tx) =>
      createKey(keys, tx, owner, { ...restricted, name: "Long lived", expiresIn: "never" }),
    );
    // 120 newer keys that ended (revoked), written directly: the list's order is under test here.
    await su.query("BEGIN");
    await su.query("SET LOCAL session_replication_role = replica");
    await su.query(
      `INSERT INTO keys.api_key (id, organization_id, mode, kind, name, scopes, ip_allowlist, hash,
         pepper_versions, created_by, created_at, updated_at, expires_at, revoked_at, revoked_reason,
         seen_by)
       SELECT 'RV' || lpad(i::text, 8, '0'), $1, 'test', 'rk', 'Ended ' || i, ARRAY['customers:read'],
              '{}', decode(repeat('00', 32), 'hex'), ARRAY[1]::smallint[], $2,
              now() + i * interval '1 second', now(), NULL, now(), 'member', ARRAY[$2]
         FROM generate_series(1, 120) AS i`,
      [ORG3, OWNER3.userId],
    );
    await su.query("COMMIT");
    const page = (n: number) =>
      inUnit(console_, (tx) =>
        listKeys(
          tx,
          owner,
          { mode: "test", page: n, size: 100 },
          async (ids) => new Map(ids.map((id) => [id, new Set(ALL)])),
        ),
      );
    const first = await page(1);
    expect(first.total).toBe(121);
    expect(first.keys).toHaveLength(100);
    expect(first.keys[0]).toMatchObject({ keyId: old.key.keyId, status: "active" });
    const second = await page(2);
    expect(second.keys).toHaveLength(21);
    expect(second.keys.every((k) => k.status === "revoked")).toBe(true);
    const seen = new Set([...first.keys, ...second.keys].map((k) => k.keyId));
    expect(seen.size).toBe(121);
  });
});
