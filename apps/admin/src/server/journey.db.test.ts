// The end-to-end API journey (spec 02 §6.4, §6.5, §10; AC-SAT-17's API half), through Fin Admin's
// API half exactly as the admin tunnel reaches it: the connector's address and ingress proof, the
// test Access stand-in's token on every request, the origin gate, the staff realm and the staff
// routes, on the real platform. The operator bootstraps the first Admin; the Admin signs in with an
// emailed code, redeems the enrolment code, enrols an authenticator and then a passkey (with an
// intent), adds a second member with a step-up and sees the code once, changes their role (their
// sessions end), and cannot remove themselves, the last Admin.

import { generateEnrolmentCode, hashEnrolmentCode } from "@fin/staff";
import {
  createStaffHarness,
  SoftAuthenticator,
  type StaffHarness,
  unique,
} from "@fin/staff/testing";
import { base32Decode, totp } from "@fin/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdminClient, type AdminHost, createAdminHost } from "./testing/host.ts";

let h: StaffHarness;
let host: AdminHost;

beforeAll(async () => {
  h = await createStaffHarness("sat04journey");
  host = await createAdminHost(h);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

function secretOf(uri: string): Uint8Array {
  return base32Decode(new URL(uri).searchParams.get("secret") ?? "");
}

/**
 * What `migrate --task staff-bootstrap` runs (apps/api/src/tasks/staff-bootstrap), as fin_owner:
 * the operator's half made the code and passes only its hash.
 */
async function bootstrap(address: string): Promise<{ staffId: string; code: string }> {
  const code = generateEnrolmentCode();
  const owner = await h.platform.owner();
  try {
    const ids = {
      member_id: newIdLike("stf"),
      code_id: newIdLike("enc"),
      member_event_id: newIdLike("aud"),
      code_event_id: newIdLike("aud"),
      bootstrap_event_id: newIdLike("aud"),
      journal_id: newIdLike("jrn"),
    };
    const result = await owner.query<{ answer: { staff_id: string } }>(
      "SELECT staff.bootstrap_admin($1, $2, false, 'first_admin', 'run_journey', 'test-release', $3::jsonb) AS answer",
      [address, hashEnrolmentCode(code), JSON.stringify(ids)],
    );
    return { staffId: String(result.rows[0]?.answer.staff_id), code };
  } finally {
    await owner.end();
  }
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
function newIdLike(prefix: string): string {
  let time = "";
  let ms = Date.now();
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  let random = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) random += CROCKFORD[byte % 32];
  return `${prefix}_${time}${random}`;
}

async function enrolWithAuthenticator(client: AdminClient, code: string): Promise<Uint8Array> {
  const signedIn = await client.signInByCode((email) => h.latestCode(email));
  expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
  const redeemed = await client.post("/api/enrolment/redeem", { code });
  expect(redeemed.status, JSON.stringify(redeemed.json)).toBe(200);
  const enabled = await client.post("/api/auth/two-factor/enable", {});
  expect(enabled.status, JSON.stringify(enabled.json)).toBe(200);
  expect(enabled.json).not.toHaveProperty("backupCodes");
  const secret = secretOf(String(enabled.json?.totpURI));
  const verified = await client.post("/api/auth/two-factor/verify-totp", {
    code: totp(secret, Date.now()),
  });
  expect(verified.status, JSON.stringify(verified.json)).toBe(200);
  return secret;
}

describe("Fin Admin, end to end through the API half", () => {
  const adminEmail = unique("first.admin");
  const secondEmail = unique("second.member");
  const admin = new SoftAuthenticator("admin.example.com", "https://admin.example.com");
  let first: AdminClient;
  let firstId: string;
  let secondId: string;
  let secondCode: string;

  it("bootstraps the first Admin, who signs in by code and is held at enrolment", async () => {
    const boot = await bootstrap(adminEmail);
    firstId = boot.staffId;
    first = host.client(adminEmail);
    const signedOut = await first.get("/api/viewer");
    expect(signedOut.json).toEqual({ state: "signed_out", accessEmail: adminEmail });
    const signedIn = await first.signInByCode((email) => h.latestCode(email));
    expect(signedIn.status).toBe(200);
    expect((await first.get("/api/viewer")).json).toEqual({ state: "pending", email: adminEmail });
    // Pending: nothing but the viewer and the enrolment code.
    const held = await first.get("/api/staff");
    expect(held.status).toBe(403);
    expect(held.json).toMatchObject({ code: "factor_step_required" });
    const wrong = await first.post("/api/enrolment/redeem", { code: "0000-0000-0000-0000" });
    expect(wrong.status).toBe(400);
    expect(wrong.json).toMatchObject({ code: "invalid", reason: "wrong" });
    const tries = await h.admin.query<{ failed_tries: number }>(
      "SELECT failed_tries FROM staff.enrolment_code WHERE member_id = $1 AND voided_at IS NULL",
      [firstId],
    );
    expect(tries.rows[0]?.failed_tries).toBe(1);
    const redeemed = await first.post("/api/enrolment/redeem", { code: boot.code });
    expect(redeemed.status, JSON.stringify(redeemed.json)).toBe(200);
    expect(redeemed.json).toHaveProperty("enrolmentOpenUntil");
    // The code works once.
    const again = await first.post("/api/enrolment/redeem", { code: boot.code });
    expect(again.json).toMatchObject({ code: "invalid", reason: "used" });
  });

  it("enrols an authenticator, then a passkey with an intent, and reaches every permission", async () => {
    const enabled = await first.post("/api/auth/two-factor/enable", {});
    expect(enabled.status, JSON.stringify(enabled.json)).toBe(200);
    expect(enabled.json).not.toHaveProperty("backupCodes");
    const secret = secretOf(String(enabled.json?.totpURI));
    const verified = await first.post("/api/auth/two-factor/verify-totp", {
      code: totp(secret, Date.now()),
    });
    expect(verified.status, JSON.stringify(verified.json)).toBe(200);
    const viewer = await first.get("/api/viewer");
    expect(viewer.json).toMatchObject({
      state: "ok",
      staff: { id: firstId, email: adminEmail, roleKey: "admin", roleLabel: "Admin" },
      environment: "test",
    });
    expect(viewer.json?.permissions as string[]).toHaveLength(26);
    // A further factor takes an intent (staff.factor_add), proved here with the authenticator.
    const asked = await first.post("/api/auth/passkey/verify-registration", {});
    expect(asked.status).toBe(403);
    expect(asked.json).toMatchObject({ code: "step_up_required", step_up_kind: "intent" });
    const intent = String(asked.json?.intent_id);
    const proved = await first.post(
      "/api/auth/two-factor/verify-totp",
      { code: totp(secret, Date.now() + 30_000) },
      { "fin-step-up-intent": intent },
    );
    expect(proved.status, JSON.stringify(proved.json)).toBe(200);
    const options = await first.get("/api/auth/passkey/generate-register-options", {
      "fin-step-up-intent": intent,
    });
    expect(options.status, JSON.stringify(options.json)).toBe(200);
    const response = admin.register(options.json as { challenge: string; user: { id: string } });
    const added = await first.post(
      "/api/auth/passkey/verify-registration",
      { response },
      { "fin-step-up-intent": intent },
    );
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    const account = await first.get("/api/account");
    expect(account.status).toBe(200);
    expect(account.json).toMatchObject({ factors: { authenticator: true } });
  });

  it("adds a second member with a step-up and shows the enrolment code once", async () => {
    const asked = await first.post("/api/staff", { email: secondEmail, roleKey: "viewer" });
    expect(asked.status).toBe(403);
    expect(asked.json).toMatchObject({
      code: "step_up_required",
      step_up_kind: "intent",
      reason_key: "staff.add",
      methods: ["passkey", "authenticator"],
    });
    // Nothing was added by asking.
    expect(
      (await h.admin.query("SELECT 1 FROM staff.member WHERE email = $1", [secondEmail])).rowCount,
    ).toBe(0);
    const intent = String(asked.json?.intent_id);
    const proved = await first.passkey(admin, intent);
    expect(proved.status, JSON.stringify(proved.json)).toBe(200);
    // Another body under the same intent is refused: the digest binds the address and the role.
    const other = await first.post(
      "/api/staff",
      { email: secondEmail, roleKey: "admin" },
      { "fin-step-up-intent": intent },
    );
    expect(other.json).toMatchObject({ code: "step_up_invalid", reason: "digest" });
    const added = await first.post(
      "/api/staff",
      { email: secondEmail, roleKey: "viewer" },
      { "fin-step-up-intent": intent },
    );
    expect(added.status, JSON.stringify(added.json)).toBe(201);
    expect(added.headers.get("cache-control")).toBe("no-store");
    expect(added.json).toMatchObject({ email: secondEmail, roleKey: "viewer", status: "pending" });
    secondId = String(added.json?.staffId);
    secondCode = String(added.json?.enrolmentCode);
    expect(secondCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    // A re-send is refused before its spent intent is even read, and the code is never shown again.
    const replay = await first.post(
      "/api/staff",
      { email: secondEmail, roleKey: "viewer" },
      { "fin-step-up-intent": intent },
    );
    expect(replay.status).toBe(409);
    expect(replay.json).toMatchObject({ code: "already_staff" });
    expect(replay.json).not.toHaveProperty("enrolmentCode");
    const events = await h.events();
    const mine = events.filter((e) => e.target_id === secondId || e.ref_ids.includes(secondId));
    expect(mine.map((e) => e.event)).toEqual(["staff.member_added", "staff.enrolment_code_issued"]);
    expect(mine[0]).toMatchObject({
      actor_kind: "staff",
      actor_id: firstId,
      actor_via: "admin",
      step_up_kind: "intent",
      step_up_ref: intent,
    });
    const notices = await h.outbox("staff/staff-access-changed");
    expect(notices.map((n) => n.recipient).sort()).toEqual([adminEmail, secondEmail].sort());
    expect(JSON.stringify(await h.outbox())).not.toContain(secondCode.replace(/-/g, ""));
    expect(JSON.stringify(await h.outbox())).not.toContain(secondCode);
    // The list shows them pending, and "you" on one's own row.
    const list = await first.get("/api/staff");
    expect(list.status).toBe(200);
    const rows = list.json?.items as { id: string; status: string; you: boolean }[];
    expect(rows.find((r) => r.id === secondId)).toMatchObject({ status: "pending", you: false });
    expect(rows.find((r) => r.id === firstId)).toMatchObject({ status: "active", you: true });
  });

  it("lets the new member enrol with both codes; a Viewer is refused staff changes", async () => {
    const second = host.client(secondEmail);
    await enrolWithAuthenticator(second, secondCode);
    const viewer = await second.get("/api/viewer");
    expect(viewer.json).toMatchObject({ state: "ok", staff: { roleKey: "viewer" } });
    expect((await second.get("/api/staff")).status).toBe(200);
    const refused = await second.post("/api/staff", { email: unique("x"), roleKey: "viewer" });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: "forbidden", permission: "staff.add" });
    const switches = await second.get("/api/switches");
    expect(switches.json).toMatchObject({ code: "forbidden", permission: "switches.manage" });
  });

  it("changes the second member's role with a step-up, ending their sessions", async () => {
    const second = host.client(secondEmail);
    // Their earlier session is gone with the role change below; sign in fresh to watch it end.
    const changed = await first.stepped(admin, "PATCH", `/api/staff/${secondId}`, {
      roleKey: "compliance",
    });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    expect(changed.json).toMatchObject({
      staffId: secondId,
      roleKey: "compliance",
      roleLabel: "Compliance",
    });
    const sessions = await h.admin.query("SELECT 1 FROM staff.session WHERE user_id = $1", [
      secondId,
    ]);
    expect(sessions.rowCount).toBe(0);
    expect((await second.get("/api/viewer")).json).toMatchObject({ state: "signed_out" });
    const [event] = await h.events("staff.role_changed");
    expect(event?.metadata).toEqual({
      fromRole: "viewer",
      toRole: "compliance",
      reason: "changed",
      lowered: false,
    });
  });

  it("refuses removing the last Admin (themselves) and outranking roles", async () => {
    const self = await first.post(`/api/staff/${firstId}/remove`, {});
    expect(self.status).toBe(403);
    expect(self.json).toMatchObject({ code: "giving_refused", problem: "self" });
    const demote = await first.patch(`/api/staff/${firstId}`, { roleKey: "viewer" });
    expect(demote.json).toMatchObject({ code: "giving_refused", problem: "self" });
    // No intent was made for a refused change (S2-31).
    const intents = await h.admin.query(
      "SELECT 1 FROM ops.step_up_intent WHERE principal_id = $1 AND action IN ('staff.remove', 'staff.role') AND consumed_at IS NULL",
      [firstId],
    );
    expect(intents.rowCount).toBe(0);
    const still = await h.admin.query<{ status: string; role_key: string }>(
      "SELECT status, role_key FROM staff.member WHERE id = $1",
      [firstId],
    );
    expect(still.rows[0]).toEqual({ status: "active", role_key: "admin" });
  });

  it("checks the Access identity against the session on every request", async () => {
    const other = host.client(adminEmail);
    other.jar.clear();
    for (const [k, v] of first.jar) other.jar.set(k, v);
    // The same session under another Access identity is ended and refused.
    other.email = secondEmail;
    const mismatch = await other.get("/api/staff");
    expect(mismatch.status).toBe(403);
    expect(mismatch.json).toMatchObject({ code: "access_mismatch" });
    expect((await first.get("/api/viewer")).json).toMatchObject({ state: "signed_out" });
    // No Access token at all never reaches a handler.
    const none = host.client(null);
    expect((await none.get("/api/viewer")).status).toBe(401);
  });
});
