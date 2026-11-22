// The console's API keys routes end to end (spec 02 §12.3; spec 05 §4.6; T-SAT-30 and T-SAT-31 for the
// key routes): the API half booted on a real socket behind the front door, on the keys platform
// (P0-E's, the identity realm's, the organisation area's and the keys area's migrations and grants)
// as the console's own login. A Super admin lists, creates (the secret shown once), edits, rolls and
// revokes keys, each after a step-up intent bound to the action, the key and its fields; every
// change writes its event (on the organisation's audit log) and its notice to every member. Then the
// refusal matrix of each key route (signed out, no organisation, another organisation, a role
// without the permission, no intent, another action's intent) and the step-up matrix (unproved, each
// bound field and the target changed, another session, expired, used, then passing once); a
// Developer's full-access key refused before any step-up; a key ID of another shape not found. Then
// the key's own mode on every change (a role that manages only the other mode refused before any
// step-up), an allowlist change refused to a role the key goes beyond, and a member who rolled their
// own key with 24 hours of overlap removed or demoted: the old key is listed and stops at once.
import { randomBytes } from "node:crypto";
import { judgeKey, keySettingsFromEnv, keyStore, precheck } from "@fin/keys";
import { bootApi } from "@fin/web-host/testing";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createKeysPlatform,
  type KeysPlatform,
  type PlatformClient,
} from "../../../../packages/keys/test/platform.mjs";
import { totpCode } from "../../../../packages/orgs/test/index.ts";
import {
  type Booted,
  Client,
  enrolAuthenticator,
  latestCode,
  ORIGIN,
  type Reply,
  steppedUp,
} from "../../test/client.ts";
import { defineConsoleService } from "./main.ts";
import { KEYS_ROUTES } from "./policy/keys.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let platform: KeysPlatform;
let su: PlatformClient;
let pool: Pool;
let api: Booted;
const tag = randomBytes(3).toString("hex");
const address = (label: string) => `${label}.${tag}@example.com`;
const KEY_SHAPE = /^fin_test_(sk|rk)_[0-9A-HJKMNP-TV-Z]{10}[0-9A-Za-z]{38}$/;
// The console's key settings, kept so a test can judge a key as the edge would.
const KEY_ENV = {
  FIN_KEY_SALT: "fin-ci-1",
  API_KEY_PEPPER_1: randomBytes(32).toString("base64url"),
  API_KEY_PEPPER_IN_USE: "1",
};

/** The superuser as the test client's helpers read it (they only call `query`). */
const admin = () => su as never;

async function signIn(email: string, factor: boolean): Promise<Client> {
  const client = new Client(api);
  await client.call("POST", "/api/auth/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  const signedIn = await client.call("POST", "/api/auth/sign-in/email-otp", {
    email,
    otp: await latestCode(admin(), email),
  });
  if (signedIn.status !== 200) throw new Error(`sign-in answered ${signedIn.status}`);
  if (factor) await enrolAuthenticator(client);
  return client;
}

async function prove(client: Client, intentId: string): Promise<void> {
  await su.query("UPDATE identity.totp_step SET last_step = 0");
  const proved = await client.call(
    "POST",
    "/api/auth/two-factor/verify-totp",
    { code: totpCode(client.secret as Uint8Array, new Date()) },
    { "fin-step-up-intent": intentId },
  );
  if (proved.status !== 200) throw new Error(`the proof answered ${proved.status}`);
}

interface Fixture {
  owner: Client;
  developer: Client;
  reader: Client;
  stranger: Client;
  orgId: string;
  otherOrgId: string;
}
let f: Fixture;

async function joinWithRole(owner: Client, orgId: string, label: string, permissions: string[]) {
  const role = await steppedUp(admin(), owner, (h) =>
    owner.org(orgId, "POST", "/api/roles", { name: `${label} role`, permissions }, h),
  );
  const email = address(label);
  const invited = await steppedUp(admin(), owner, (h) =>
    owner.org(orgId, "POST", "/api/team/invitations", { email, roleKey: role.done.json.roleId }, h),
  );
  const client = await signIn(email, true);
  const joined = await client.call(
    "POST",
    `/api/invitations/${String(invited.done.json.invitationId)}/accept`,
  );
  if (joined.status !== 200) {
    // A person with a factor accepts with an intent of their own.
    await steppedUp(admin(), client, (h) =>
      client.call(
        "POST",
        `/api/invitations/${String(invited.done.json.invitationId)}/accept`,
        undefined,
        h,
      ),
    );
  }
  return client;
}

beforeAll(async () => {
  platform = await createKeysPlatform("keysconsole");
  su = await platform.superuser();
  pool = new pg.Pool({
    host: platform.host,
    port: platform.port,
    database: platform.name,
    user: "fin_console_a",
    password: platform.password("fin_console_a"),
    max: 6,
  });
  pool.on("error", () => undefined);
  api = await bootApi(defineConsoleService({ pool }), {
    service: "console",
    roles: ["console"],
    env: {
      FIN_PUBLIC_ORIGIN: ORIGIN,
      FIN_CONNECTOR_SERVICES: "cloudflared-public",
      FIN_DOCS_ORIGIN: "https://developer.example.com",
      BETTER_AUTH_SECRETS: `1:${randomBytes(32).toString("base64url")}`,
      FIN_LIMIT_KEY_1: randomBytes(32).toString("hex"),
      ...KEY_ENV,
    },
  });
  const owner = await signIn(address("owner"), true);
  const first = await owner.call("POST", "/api/orgs/first");
  const orgId = String(first.json.orgId);
  const developer = await joinWithRole(owner, orgId, "developer", [
    "apiKey.read",
    "apiKey.sandbox",
    "customers.read",
    "money.read",
    "webhooks.read",
  ]);
  const reader = await joinWithRole(owner, orgId, "reader", ["webhooks.read"]);
  const other = await signIn(address("other"), true);
  const otherOrg = await other.call("POST", "/api/orgs/first");
  f = {
    owner,
    developer,
    reader,
    stranger: new Client(api),
    orgId,
    otherOrgId: String(otherOrg.json.orgId),
  };
  await su.query("DELETE FROM ops.rate_window");
});

afterAll(async () => {
  await api?.stop();
  await pool?.end();
  await su?.end();
  await platform?.drop();
});

const create = (
  client: Client,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) => client.org(f.orgId, "POST", "/api/keys", body, headers);

const restricted = {
  name: "Payout worker",
  mode: "test",
  kind: "rk",
  scopes: ["customers:read", "money:read"],
  ipAllowlist: [],
  expiresIn: "90d",
};

describe("the API keys journey", () => {
  it("lists, creates with the secret shown once, edits, rolls and revokes, each after its intent", async () => {
    const empty = await f.owner.org(f.orgId, "GET", "/api/keys?mode=test");
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({ keys: [], total: 0, limit: 50 });
    expect(empty.json.can).toMatchObject({
      test: { manage: true, fullAccess: true },
      live: { manage: true, approved: false },
    });

    const made = await steppedUp(admin(), f.owner, (h) => create(f.owner, restricted, h));
    expect(made.asked.json).toMatchObject({
      code: "step_up_required",
      step_up_kind: "intent",
      reason_key: "key.create",
    });
    expect(made.done.status).toBe(201);
    const secret = String(made.done.json.secret);
    expect(secret).toMatch(KEY_SHAPE);
    const key = made.done.json.key as Record<string, unknown>;
    const keyId = String(key.keyId);
    expect(key).toMatchObject({
      name: "Payout worker",
      status: "active",
      access: "Restricted · 2 scopes",
    });
    expect(made.done.cookies).toEqual([]);

    const listed = await f.owner.org(f.orgId, "GET", "/api/keys?mode=test");
    expect(JSON.stringify(listed.json)).not.toContain(secret.slice(22, 54));
    expect((listed.json.keys as { keyId: string }[]).map((k) => k.keyId)).toEqual([keyId]);

    const renamed = await steppedUp(admin(), f.owner, (h) =>
      f.owner.org(f.orgId, "PATCH", `/api/keys/${keyId}`, { name: "Payouts" }, h),
    );
    expect(renamed.asked.json.reason_key).toBe("key.update");
    expect(renamed.done.json.key).toMatchObject({ name: "Payouts" });

    const rolled = await steppedUp(admin(), f.owner, (h) =>
      f.owner.org(f.orgId, "POST", `/api/keys/${keyId}/roll`, { overlap: "1h" }, h),
    );
    expect(rolled.done.status).toBe(200);
    expect(String(rolled.done.json.secret)).toMatch(KEY_SHAPE);
    expect(rolled.done.json.secret).not.toBe(secret);
    expect(rolled.done.json.replaced).toMatchObject({ keyId, status: "rolling" });
    const newKeyId = String((rolled.done.json.key as { keyId: string }).keyId);

    const revoked = await steppedUp(admin(), f.owner, (h) =>
      f.owner.org(f.orgId, "POST", `/api/keys/${newKeyId}/revoke`, undefined, h),
    );
    expect(revoked.done.json.key).toMatchObject({ keyId: newKeyId, status: "revoked" });

    const events = await su.query<{ event: string; step_up_ref: string | null }>(
      "SELECT event, step_up_ref FROM audit.event WHERE category = 'api_keys' AND organization_id = $1 ORDER BY id",
      [f.orgId],
    );
    expect(events.rows.map((e) => e.event)).toEqual([
      "api_key.created",
      "api_key.updated",
      "api_key.rolled",
      "api_key.revoked",
    ]);
    expect(events.rows.every((e) => e.step_up_ref?.startsWith("sti_"))).toBe(true);
    const log = await f.owner.org(f.orgId, "GET", "/api/audit-log?type=api_keys&range=all");
    expect(log.status).toBe(200);
    expect(JSON.stringify(log.json)).toContain("api_key.revoked");
    const notices = await su.query<{ n: string }>(
      "SELECT count(*) AS n FROM email_private.outbox WHERE template = 'api-keys/key-changed'",
    );
    // Four changes, each to the three members.
    expect(Number(notices.rows[0]?.n)).toBe(12);
  });

  it("refuses a Developer's full-access key before any step-up, and a key ID of another shape", async () => {
    const full = await create(f.developer, { ...restricted, kind: "sk", scopes: [] });
    expect(full.status).toBe(403);
    expect(full.json).toMatchObject({ code: "forbidden", reason: "beyond_role" });
    expect(String(full.json.permission)).toContain("customers.delete");
    const ok = await steppedUp(admin(), f.developer, (h) => create(f.developer, restricted, h));
    expect(ok.done.status).toBe(201);
    const odd = await f.owner.org(f.orgId, "POST", "/api/keys/abcdefghjk/revoke");
    expect(odd.status).toBe(404);
  });
});

/** One sample request per key route, against a key made for it. */
async function sample(id: string): Promise<{ path: string; body?: unknown; method: string }> {
  const route = KEYS_ROUTES.find((r) => r.id === id);
  if (route === undefined) throw new Error(id);
  if (id === "keysList") return { method: "GET", path: "/api/keys?mode=test" };
  if (id === "keysCreate") return { method: "POST", path: "/api/keys", body: restricted };
  const made = await steppedUp(admin(), f.owner, (h) =>
    create(f.owner, { ...restricted, name: `For ${id}` }, h),
  );
  const keyId = String((made.done.json.key as { keyId: string }).keyId);
  if (id === "keysUpdate")
    return { method: "PATCH", path: `/api/keys/${keyId}`, body: { name: "Changed" } };
  if (id === "keysRoll")
    return { method: "POST", path: `/api/keys/${keyId}/roll`, body: { overlap: "24h" } };
  return { method: "POST", path: `/api/keys/${keyId}/revoke` };
}

describe("the refusal matrix of the key routes", () => {
  for (const route of KEYS_ROUTES) {
    it(`${route.id}: signed out, no organisation, another organisation, no permission, no intent`, async () => {
      await su.query("DELETE FROM ops.rate_window");
      const s = await sample(route.id);
      const send = (client: Client, orgId: string | null, headers: Record<string, string> = {}) =>
        orgId === null
          ? client.call(s.method, s.path, s.body, headers)
          : client.org(orgId, s.method, s.path, s.body, headers);
      expect((await send(f.stranger, f.orgId)).json.code).toBe("unauthenticated");
      expect((await send(f.owner, null)).json.code).toBe("organization_required");
      const foreign = await send(f.owner, f.otherOrgId);
      expect([foreign.status, foreign.json.code]).toEqual([404, "not_found"]);
      const denied = await send(f.reader, f.orgId);
      expect([denied.status, denied.json.code]).toEqual([403, "forbidden"]);
      if (route.method === "GET") {
        expect((await send(f.owner, f.orgId)).status).toBe(200);
        return;
      }
      const asked = await send(f.owner, f.orgId);
      expect(asked.json).toMatchObject({ code: "step_up_required", reason_key: route.action });
      const elsewhere = await f.owner.call("POST", "/api/orgs", { name: "Elsewhere" });
      await prove(f.owner, String(elsewhere.json.intent_id));
      const refused = await send(f.owner, f.orgId, {
        "fin-step-up-intent": String(elsewhere.json.intent_id),
      });
      expect(refused.json).toMatchObject({ code: "step_up_invalid", reason: "other_action" });
    });
  }
});

describe("the step-up matrix of the key routes", () => {
  async function refusal(send: (h: Record<string, string>) => Promise<Reply>, intent: string) {
    const res = await send({ "fin-step-up-intent": intent });
    expect(res.status, JSON.stringify(res.json)).toBe(403);
    expect(res.json.code).toBe("step_up_invalid");
    return String(res.json.reason);
  }

  it("binds a create to every field it makes the key with", async () => {
    await su.query("DELETE FROM ops.rate_window");
    const go = (body: Record<string, unknown>) => (h: Record<string, string>) =>
      create(f.owner, body, h);
    const asked = await go(restricted)({});
    const intent = String(asked.json.intent_id);
    expect(await refusal(go(restricted), intent)).toBe("unproved");
    await prove(f.owner, intent);
    for (const variant of [
      { name: "Other name" },
      { kind: "sk", scopes: [] },
      { scopes: ["customers:read"] },
      { ipAllowlist: ["8.8.8.0/24"] },
      { expiresIn: "30d" },
    ]) {
      expect(
        await refusal(go({ ...restricted, ...variant }), intent),
        JSON.stringify(variant),
      ).toBe("digest");
    }
    // Another session of the same person, past its factor step.
    const other = await signIn(address("owner"), false);
    other.secret = f.owner.secret;
    await su.query("UPDATE identity.totp_step SET last_step = 0");
    await other.call("POST", "/api/auth/two-factor/verify-totp", {
      code: totpCode(other.secret as Uint8Array, new Date()),
    });
    expect(await refusal((h) => create(other, restricted, h), intent)).toBe("other_session");
    const done = await go(restricted)({ "fin-step-up-intent": intent });
    expect(done.status).toBe(201);
    const again = await go(restricted)({ "fin-step-up-intent": intent });
    expect(again.json).toMatchObject({ code: "step_up_invalid", reason: "used" });
  });

  it("binds an edit, a roll and a revocation to their key and fields, and an expired intent serves none", async () => {
    await su.query("DELETE FROM ops.rate_window");
    const a = await steppedUp(admin(), f.owner, (h) =>
      create(f.owner, { ...restricted, name: "Key A" }, h),
    );
    const b = await steppedUp(admin(), f.owner, (h) =>
      create(f.owner, { ...restricted, name: "Key B" }, h),
    );
    const idA = String((a.done.json.key as { keyId: string }).keyId);
    const idB = String((b.done.json.key as { keyId: string }).keyId);
    const cases: [string, string, unknown, unknown][] = [
      ["PATCH", "", { name: "Edited" }, { name: "Edited twice" }],
      ["POST", "/roll", { overlap: "1h" }, { overlap: "24h" }],
      ["POST", "/revoke", undefined, undefined],
    ];
    for (const [method, suffix, body, otherBody] of cases) {
      const send = (id: string, payload: unknown) => (h: Record<string, string>) =>
        f.owner.org(f.orgId, method, `/api/keys/${id}${suffix}`, payload, h);
      const asked = await send(idA, body)({});
      const intent = String(asked.json.intent_id);
      await prove(f.owner, intent);
      expect(await refusal(send(idB, body), intent), `${method} ${suffix} target`).toBe("digest");
      if (otherBody !== undefined) {
        expect(await refusal(send(idA, otherBody), intent), `${method} ${suffix} body`).toBe(
          "digest",
        );
      }
      await su.query("BEGIN");
      await su.query("SET LOCAL session_replication_role = replica");
      await su.query(
        "UPDATE ops.step_up_intent SET created_at = now() - interval '6 minutes', expires_at = now() - interval '1 second' WHERE id = $1",
        [intent],
      );
      await su.query("COMMIT");
      expect(await refusal(send(idA, body), intent)).toBe("expired");
    }
  });
});

const keyIdOf = (reply: Reply) => String((reply.json.key as { keyId: string }).keyId);

async function stepUpIntents(): Promise<number> {
  return Number(
    (await su.query<{ n: string }>("SELECT count(*) AS n FROM ops.step_up_intent")).rows[0]?.n,
  );
}

async function memberIdOf(label: string): Promise<string> {
  const row = await su.query<{ id: string }>(
    `SELECT m.id FROM identity.member m JOIN identity."user" u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND u.email = $2`,
    [f.orgId, address(label)],
  );
  return String(row.rows[0]?.id);
}

/** What the edge answers for a key now: its own statement, then its check, with this pepper. */
async function atTheEdge(secret: string) {
  const pre = precheck(`Bearer ${secret}`, KEY_ENV.FIN_KEY_SALT);
  if (!pre.ok) throw new Error(pre.reason);
  const lookup = await keyStore(su).lookup(pre.key.id, "edge:refused_keys:console-test");
  return judgeKey({
    key: pre.key,
    record: lookup.record,
    peppers: keySettingsFromEnv(KEY_ENV, "ci").peppers,
    now: Date.now(),
    clientIp: "8.8.8.8",
  });
}

describe("the key's own mode and the role behind an allowlist change", () => {
  it("refuses an edit, a roll and a revocation to a role that manages only the other mode, before any step-up", async () => {
    await su.query("DELETE FROM ops.rate_window");
    // Production keys need an approved organisation: set as go-live sets it, past the guards.
    await su.query("BEGIN");
    await su.query("SET LOCAL session_replication_role = replica");
    await su.query("UPDATE identity.organization SET live_status = 'approved' WHERE id = $1", [
      f.orgId,
    ]);
    await su.query("COMMIT");
    const live = await steppedUp(admin(), f.owner, (h) =>
      create(f.owner, { ...restricted, mode: "live", name: "Live mode" }, h),
    );
    expect(live.done.status).toBe(201);
    const sandbox = await steppedUp(admin(), f.owner, (h) =>
      create(f.owner, { ...restricted, name: "Sandbox mode" }, h),
    );
    const liveOnly = await joinWithRole(f.owner, f.orgId, "liveonly", [
      "apiKey.read",
      "apiKey.live",
      "customers.read",
      "money.read",
    ]);
    await su.query("DELETE FROM ops.rate_window");
    const intents = await stepUpIntents();
    const cases: [Client, string, string][] = [
      [f.developer, keyIdOf(live.done), "apiKey.live"],
      [liveOnly, keyIdOf(sandbox.done), "apiKey.sandbox"],
    ];
    for (const [client, keyId, permission] of cases) {
      for (const [method, suffix, body] of [
        ["PATCH", "", { name: "Renamed" }],
        ["POST", "/roll", { overlap: "now" }],
        ["POST", "/revoke", undefined],
      ] as const) {
        const res = await client.org(f.orgId, method, `/api/keys/${keyId}${suffix}`, body);
        expect([res.status, res.json.code, res.json.permission], `${method}${suffix}`).toEqual([
          403,
          "forbidden",
          permission,
        ]);
      }
    }
    expect(await stepUpIntents()).toBe(intents);
    // Each may change a key of the mode it manages (the first answer asks for the step-up).
    const allowed = await f.developer.org(
      f.orgId,
      "POST",
      `/api/keys/${keyIdOf(sandbox.done)}/revoke`,
    );
    expect(allowed.json).toMatchObject({ code: "step_up_required", reason_key: "key.revoke" });
  });

  it("refuses an allowlist change on a key that does more than the editor's role, before any step-up", async () => {
    await su.query("DELETE FROM ops.rate_window");
    const full = await steppedUp(admin(), f.owner, (h) =>
      create(f.owner, { ...restricted, kind: "sk", scopes: [], name: "Full sandbox" }, h),
    );
    const keyId = keyIdOf(full.done);
    const intents = await stepUpIntents();
    const moved = await f.developer.org(f.orgId, "PATCH", `/api/keys/${keyId}`, {
      ipAllowlist: ["8.8.8.0/24"],
    });
    expect(moved.status).toBe(403);
    expect(moved.json).toMatchObject({ code: "forbidden", reason: "beyond_role" });
    expect(String(moved.json.permission)).toContain("customers.delete");
    expect(await stepUpIntents()).toBe(intents);
    // A rename of the same key is theirs: it asks for the step-up.
    const renamed = await f.developer.org(f.orgId, "PATCH", `/api/keys/${keyId}`, {
      name: "Full sandbox two",
    });
    expect(renamed.json).toMatchObject({ code: "step_up_required", reason_key: "key.update" });
  });
});

describe("a member who rolled their own key with a day of overlap, removed or demoted", () => {
  async function selfRolled(label: string) {
    const member = await joinWithRole(f.owner, f.orgId, label, [
      "apiKey.read",
      "apiKey.sandbox",
      "customers.read",
      "money.read",
      "webhooks.read",
    ]);
    await su.query("DELETE FROM ops.rate_window");
    const made = await steppedUp(admin(), member, (h) =>
      create(member, { ...restricted, name: `${label} key` }, h),
    );
    const oldId = keyIdOf(made.done);
    const rolled = await steppedUp(admin(), member, (h) =>
      member.org(f.orgId, "POST", `/api/keys/${oldId}/roll`, { overlap: "24h" }, h),
    );
    expect(rolled.done.status).toBe(200);
    const memberId = await memberIdOf(label);
    const listed = await f.owner.org(f.orgId, "GET", `/api/team/members/${memberId}/credentials`);
    expect(
      (listed.json.credentials as { id: string; made: boolean; seen: boolean }[]).map((c) => [
        c.id,
        c.made,
        c.seen,
      ]),
    ).toEqual([
      [oldId, true, true],
      [keyIdOf(rolled.done), true, true],
    ]);
    expect(await atTheEdge(String(made.done.json.secret))).toMatchObject({ ok: true });
    return {
      memberId,
      oldSecret: String(made.done.json.secret),
      newSecret: String(rolled.done.json.secret),
    };
  }

  it("lists the old key still in its overlap and stops it at once on removal", async () => {
    const leaver = await selfRolled("leaver");
    await su.query("DELETE FROM ops.rate_window");
    const removed = await steppedUp(admin(), f.owner, (h) =>
      f.owner.org(
        f.orgId,
        "POST",
        `/api/team/members/${leaver.memberId}/remove`,
        { rollCredentials: true },
        h,
      ),
    );
    expect(removed.done.status).toBe(200);
    expect(removed.done.json.credentials).toEqual({
      listed: 2,
      rolledNow: 2,
      rollingWithinHour: 0,
    });
    expect(await atTheEdge(leaver.oldSecret)).toEqual({ ok: false, reason: "expired" });
    expect(await atTheEdge(leaver.newSecret)).toEqual({ ok: false, reason: "expired" });
  });

  it("does the same on a demotion that takes the key permissions away", async () => {
    const demoted = await selfRolled("demoted");
    await su.query("DELETE FROM ops.rate_window");
    const readers = await steppedUp(admin(), f.owner, (h) =>
      f.owner.org(
        f.orgId,
        "POST",
        "/api/roles",
        { name: "Webhook readers", permissions: ["webhooks.read"] },
        h,
      ),
    );
    const changed = await steppedUp(admin(), f.owner, (h) =>
      f.owner.org(
        f.orgId,
        "PATCH",
        `/api/team/members/${demoted.memberId}`,
        { roleKey: readers.done.json.roleId, rollCredentials: true },
        h,
      ),
    );
    expect(changed.done.status).toBe(200);
    expect(await atTheEdge(demoted.oldSecret)).toEqual({ ok: false, reason: "expired" });
    expect(await atTheEdge(demoted.newSecret)).toEqual({ ok: false, reason: "expired" });
  });
});
