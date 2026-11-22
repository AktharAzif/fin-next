// Account security over HTTP (spec 02 §14.2, §11.4, §6.6): the name change with a window step-up and
// its events (`user.name_changed`, and `member.name_changed` per membership); one other session
// signed out with an intent, every other one with an intent; a trusted browser forgotten with an
// intent; the lists; and switching the current organisation, which is navigation and writes nothing.
import { randomBytes } from "node:crypto";
import { bootApi } from "@fin/web-host/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  DROP_TIMEOUT_MS,
  seed,
  type TestDatabase,
  totpCode,
} from "../../../../packages/orgs/test/index.ts";
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

let database: TestDatabase;
let api: Booted;

beforeAll(async () => {
  database = await createTestDatabase("account");
  api = await bootApi(defineConsoleService({ pool: database.login("fin_console") }), {
    service: "console",
    roles: ["console"],
    env: {
      FIN_PUBLIC_ORIGIN: ORIGIN,
      FIN_CONNECTOR_SERVICES: "cloudflared-public",
      FIN_DOCS_ORIGIN: "https://developer.example.com",
      BETTER_AUTH_SECRETS: `1:${randomBytes(32).toString("base64url")}`,
      FIN_LIMIT_KEY_1: randomBytes(32).toString("hex"),
    },
  });
});

afterAll(async () => {
  await api?.stop();
  await database?.drop();
}, DROP_TIMEOUT_MS);

const tag = randomBytes(3).toString("hex");

async function signIn(email: string): Promise<Client> {
  const client = new Client(api);
  await client.call("POST", "/api/auth/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  const signed = await client.call("POST", "/api/auth/sign-in/email-otp", {
    email,
    otp: await latestCode(database.admin, email),
  });
  if (signed.status !== 200) throw new Error(`sign-in answered ${signed.status}`);
  return client;
}

async function events(event: string) {
  const result = await database.admin.query<{ target_id: string; organization_id: string | null }>(
    "SELECT target_id, organization_id FROM audit.event WHERE event = $1 ORDER BY recorded_at, id",
    [event],
  );
  return result.rows;
}

describe("Account security", () => {
  // The name change (its event per membership) and the switch of the current organisation need
  // the same person: signed in with a code, given an authenticator, in a first organisation and in
  // a second made with a proof. Each test built its own, eight requests through the front door
  // before its first check (0.2 s alone, 1.2 s in the full db run on GitHub's runner); the two now
  // share one, built once here. Neither changes what the other relies on: one renames the person,
  // the other switches their current organisation.
  let twoOrgs: { me: Client; first: Reply; second: { asked: Reply; done: Reply } };

  beforeAll(async () => {
    const me = await signIn(`member.${tag}@example.com`);
    await enrolAuthenticator(me);
    const first = await me.call("POST", "/api/orgs/first");
    const second = await steppedUp(database.admin, me, (h) =>
      me.call("POST", "/api/orgs", { name: "Second Team" }, h),
    );
    twoOrgs = { me, first, second };
  });

  it("changes the name behind a window, with its events, and never stores the name in them", async () => {
    const { me, first, second } = twoOrgs;
    expect(second.done.status).toBe(201);
    // The authenticator's set-up (in the hook) just proved a factor: the window is open for five
    // minutes.
    const renamed = await me.call("PATCH", "/api/account/name", { name: "Ada Lovelace" });
    expect(renamed.status, JSON.stringify(renamed.json)).toBe(200);
    expect(renamed.json).toEqual({ name: "Ada Lovelace" });
    expect(await events("user.name_changed")).toHaveLength(1);
    const perMembership = await events("member.name_changed");
    expect(perMembership.map((e) => e.organization_id).sort()).toEqual(
      [String(first.json.orgId), String(second.done.json.orgId)].sort(),
    );
    const stored = await database.admin.query<{ metadata: unknown }>(
      "SELECT metadata FROM audit.event WHERE event IN ('user.name_changed', 'member.name_changed')",
    );
    expect(JSON.stringify(stored.rows)).not.toContain("Lovelace");
    // A stale window asks again, with no intent.
    await database.admin.query(
      "UPDATE identity.assurance SET created_at = created_at - interval '1 hour'",
    );
    const stale = await me.call("PATCH", "/api/account/name", { name: "Ada King" });
    expect(stale.json).toMatchObject({ code: "step_up_required", step_up_kind: "window" });
    const refused = await me.call("PATCH", "/api/account/name", { name: "visit example.com" });
    expect(refused.json).toMatchObject({ code: "invalid" });
    // The proof opens the window again.
    await database.admin.query("UPDATE identity.totp_step SET last_step = 0");
    await me.call("POST", "/api/auth/two-factor/verify-totp", {
      code: totpCode(me.secret as Uint8Array, new Date()),
    });
    const again = await me.call("PATCH", "/api/account/name", { name: "Ada King" });
    expect(again.status).toBe(200);
  });

  it("signs out one other session and then every other one, each with an intent", async () => {
    const email = `sessions.${tag}@example.com`;
    const me = await signIn(email);
    await enrolAuthenticator(me);
    await signIn(email).catch(() => undefined);
    await signIn(email).catch(() => undefined);
    const list = await me.call("GET", "/api/account/sessions");
    const items = list.json.items as { id: string; current: boolean; device: string }[];
    expect(items.length).toBe(3);
    expect(items.filter((s) => s.current)).toHaveLength(1);
    expect(items[0]?.device).toBe("Chrome on Mac");
    const other = items.find((s) => !s.current)?.id as string;
    const own = items.find((s) => s.current)?.id as string;
    const self = await me.call("POST", `/api/account/sessions/${own}/revoke`);
    expect(self.status).toBe(404);
    const one = await steppedUp(database.admin, me, (h) =>
      me.call("POST", `/api/account/sessions/${other}/revoke`, undefined, h),
    );
    expect(one.asked.json).toMatchObject({
      code: "step_up_required",
      reason_key: "sign_out_session",
    });
    expect(one.done.status).toBe(200);
    expect((await events("session.revoked")).map((e) => e.target_id)).toContain(other);
    const rest = await steppedUp(database.admin, me, (h) =>
      me.call("POST", "/api/account/sessions/revoke-others", undefined, h),
    );
    expect(rest.done.json).toEqual({ revoked: 1 });
    const after = await me.call("GET", "/api/account/sessions");
    expect((after.json.items as unknown[]).length).toBe(1);
  });

  it("forgets a trusted browser with an intent, and refuses another person's", async () => {
    const email = `browser.${tag}@example.com`;
    const me = await signIn(email);
    await enrolAuthenticator(me);
    const user = await database.admin.query<{ id: string }>(
      'SELECT id FROM identity."user" WHERE email = $1',
      [email],
    );
    const browserId = "tbr_01jd0000000000000000000002";
    await seed(
      database.admin,
      `INSERT INTO identity.trusted_browser (id, user_id, token_hash, label, expires_at)
       VALUES ($1, $2, decode(repeat('9f', 32), 'hex'), 'Chrome on Mac', now() + interval '30 days')`,
      [browserId, user.rows[0]?.id],
    );
    const security = await me.call("GET", "/api/account/security");
    expect(security.json).toMatchObject({ authenticator: "on", warning: false });
    expect((security.json.trustedBrowsers as { id: string }[]).map((b) => b.id)).toEqual([
      browserId,
    ]);
    const stranger = await signIn(`stranger.${tag}@example.com`);
    await enrolAuthenticator(stranger);
    const notTheirs = await stranger.call("DELETE", `/api/account/trusted-browsers/${browserId}`);
    expect(notTheirs.status).toBe(404);
    const forgot = await steppedUp(database.admin, me, (h) =>
      me.call("DELETE", `/api/account/trusted-browsers/${browserId}`, undefined, h),
    );
    expect(forgot.done.status).toBe(200);
    const revoked = await database.admin.query<{ revoked_reason: string }>(
      "SELECT revoked_reason FROM identity.trusted_browser WHERE id = $1",
      [browserId],
    );
    expect(revoked.rows[0]?.revoked_reason).toBe("by_person");
  });

  it("switches the current organisation as navigation only, and refuses one the person is not in", async () => {
    const { me, first, second } = twoOrgs;
    const before = await database.admin.query("SELECT count(*)::integer AS n FROM audit.event");
    const switched = await me.call("PUT", "/api/viewer/organization", { orgId: first.json.orgId });
    expect(switched.status).toBe(200);
    const after = await database.admin.query("SELECT count(*)::integer AS n FROM audit.event");
    expect(after.rows[0]).toEqual(before.rows[0]);
    const viewer = await me.call("GET", "/api/viewer");
    expect(viewer.json.currentOrgId).toBe(first.json.orgId);
    const outsider = await signIn(`outsider.${tag}@example.com`);
    const refused = await outsider.call("PUT", "/api/viewer/organization", {
      orgId: second.done.json.orgId,
    });
    expect(refused.status).toBe(404);
    const list = await me.call("GET", "/api/orgs");
    expect((list.json.items as unknown[]).length).toBe(2);
  });

  it("refuses a page of activity past the 10,000th row as invalid, never as an error", async () => {
    const me = await signIn(`paging.${tag}@example.com`);
    const far = await me.call("GET", "/api/account/activity?page=200&size=100");
    expect(far.status, JSON.stringify(far.json)).toBe(400);
    expect(far.json).toMatchObject({
      code: "invalid",
      fields: [{ path: "query.page", code: "too_big" }],
    });
    const first = await me.call("GET", "/api/account/activity?page=1&size=100");
    expect(first.status).toBe(200);
    const items = first.json.items as { event: string; verification: string | null }[];
    expect(items.find((i) => i.event === "session.created")?.verification).toBe("email_otp");
  });
});
