// `POST /api/staff/:staffId/reset-factors` through Fin Admin's API half (spec 02 §10.2, §14.1, §14.3,
// §7.5, §18.1; [SA-14]), exactly as the admin tunnel reaches it: the connector's address and ingress
// proof, the test Access stand-in's token, the origin gate, the staff realm and the route policy, on
// the real platform. The route asks for its intent before anything changes, answers the code once
// with `no-store` in the shape the screen's contract reads, never again for the same intent, and
// writes one request line with IDs only. The member's sessions answer 401 from then on, their old
// passkey and authenticator no longer sign in, and they enrol again with the new code. Malformed,
// self, unauthorised and below-aal2 requests are refused before any work.
import { base32Decode, totp } from "@fin/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_ORIGIN,
  createStaffHarness,
  SoftAuthenticator,
  type StaffHarness,
  unique,
} from "../../../../packages/staff/test/index.ts";
import {
  type AdminClient,
  type AdminHost,
  createAdminHost,
  enrolThroughHost,
  type HostMember,
} from "../../test/host.ts";

let h: StaffHarness;
let host: AdminHost;
let admin: HostMember;

beforeAll(async () => {
  h = await createStaffHarness("sat04resethost");
  host = await createAdminHost(h);
  admin = await enrolThroughHost(h, host, unique("reset.host.admin"), "admin");
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const resetPath = (staffId: string) => `/api/staff/${staffId}/reset-factors`;
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

/** A pending member signed in by emailed code with their enrolment code redeemed. */
async function redeemed(email: string, code: string): Promise<AdminClient> {
  const client = host.client(email);
  const signedIn = await client.signInByCode((address) => h.latestCode(address));
  expect(signedIn.status).toBe(200);
  expect((await client.get("/api/viewer")).json).toEqual({ state: "pending", email });
  const answer = await client.post("/api/enrolment/redeem", { code });
  expect(answer.status, JSON.stringify(answer.json)).toBe(200);
  return client;
}

/** A member whose only factor is an authenticator (staging allows one, §10.3). */
async function withAuthenticator(email: string, roleKey: string) {
  const staffId = await h.seedMember(email, roleKey, "pending");
  const client = await redeemed(email, await h.issueCode(staffId));
  const enabled = await client.post("/api/auth/two-factor/enable", {});
  expect(enabled.status, JSON.stringify(enabled.json)).toBe(200);
  const secret = base32Decode(
    new URL(String(enabled.json?.totpURI)).searchParams.get("secret") ?? "",
  );
  const verified = await client.post("/api/auth/two-factor/verify-totp", {
    code: totp(secret, Date.now()),
  });
  expect(verified.status, JSON.stringify(verified.json)).toBe(200);
  return { staffId, client, secret };
}

describe("resetting a member's second factors through the API half", () => {
  it("asks for the intent first, then resets once and answers the code once, with no-store", async () => {
    const target = await enrolThroughHost(h, host, unique("reset.host.target"), "operator");
    expect((await target.client.get("/api/account")).status).toBe(200);

    const asked = await admin.client.post(resetPath(target.staffId), {});
    expect(asked.status).toBe(403);
    expect(asked.json).toMatchObject({
      code: "step_up_required",
      step_up_kind: "intent",
      reason_key: "staff.reset_factors",
      methods: ["passkey"],
    });
    expect(asked.json).not.toHaveProperty("enrolmentCode");
    // Asking changed nothing: the member still works.
    expect((await target.client.get("/api/account")).status).toBe(200);

    const intent = String(asked.json?.intent_id);
    expect((await admin.client.passkey(admin.authenticator, intent)).status).toBe(200);
    const done = await admin.client.post(
      resetPath(target.staffId),
      {},
      { "fin-step-up-intent": intent },
    );
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.headers.get("cache-control")).toBe("no-store");
    // The answer the screen's contract reads (src/client/routes/staff/-reset/contract.ts).
    expect(Object.keys(done.json ?? {}).sort()).toEqual([
      "enrolmentCode",
      "enrolmentCodeId",
      "expiresAt",
      "staffId",
      "status",
    ]);
    expect(done.json).toMatchObject({ staffId: target.staffId, status: "pending" });
    const code = String(done.json?.enrolmentCode);
    expect(code).toMatch(CODE);
    expect(Date.parse(String(done.json?.expiresAt)) - Date.now()).toBeGreaterThan(29 * 60_000);

    // The same intent again is refused, and the code is never shown twice.
    const replay = await admin.client.post(
      resetPath(target.staffId),
      {},
      { "fin-step-up-intent": intent },
    );
    expect(replay.status).toBe(403);
    expect(replay.json).toMatchObject({ code: "step_up_invalid", reason: "used" });
    expect(replay.json).not.toHaveProperty("enrolmentCode");
    expect(
      (await h.events("staff.factors_reset")).filter((e) => e.target_id === target.staffId),
    ).toHaveLength(1);

    // One request line for the reset, by route template and IDs only.
    const lines = host.captured
      .events("request")
      .filter((l) => (l as { route?: unknown }).route === "/api/staff/:staffId/reset-factors");
    expect(lines.map((l) => (l as { outcome?: unknown }).outcome)).toContain("ok");
    const written = JSON.stringify(host.captured.stdout);
    expect(written).not.toContain(code);
    expect(written).not.toContain(code.replace(/-/g, ""));
    expect(written).not.toContain(target.email);

    // The member is signed out, and their passkey no longer signs them in.
    const gone = await target.client.get("/api/account");
    expect(gone.status).toBe(401);
    expect(gone.json).toMatchObject({ code: "unauthenticated" });
    expect((await target.client.get("/api/viewer")).json).toMatchObject({ state: "signed_out" });
    const fresh = host.client(target.email);
    expect((await fresh.passkey(target.authenticator)).status).not.toBe(200);

    // The new code enrols them again with a new passkey.
    const again = await redeemed(target.email, code);
    const authenticator = new SoftAuthenticator(new URL(ADMIN_ORIGIN).host, ADMIN_ORIGIN);
    const options = await again.get("/api/auth/passkey/generate-register-options");
    expect(options.status).toBe(200);
    const added = await again.post("/api/auth/passkey/verify-registration", {
      response: authenticator.register(options.json as { challenge: string; user: { id: string } }),
    });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    expect((await again.get("/api/viewer")).json).toMatchObject({
      state: "ok",
      staff: { id: target.staffId, roleKey: "operator" },
    });
  });

  it("removes an authenticator, so its codes no longer pass the factor step", async () => {
    const email = unique("reset.host.totp");
    const target = await withAuthenticator(email, "viewer");
    expect((await target.client.get("/api/viewer")).json).toMatchObject({ state: "ok" });
    const done = await admin.client.stepped(admin.authenticator, "POST", resetPath(target.staffId));
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const rows = await h.admin.query<{ n: number; enabled: boolean }>(
      `SELECT (SELECT count(*)::integer FROM staff.two_factor WHERE user_id = m.id) AS n,
              m.two_factor_enabled AS enabled
         FROM staff.member m WHERE m.id = $1`,
      [target.staffId],
    );
    expect(rows.rows[0]).toEqual({ n: 0, enabled: false });
    const [event] = (await h.events("staff.factors_reset")).filter(
      (e) => e.target_id === target.staffId,
    );
    expect(event?.metadata).toEqual({ sessionsEnded: 1, factorsRemoved: 1 });

    // Signed in again by emailed code: pending, at enrolment; the old authenticator's code is no
    // factor step any more.
    const back = host.client(email);
    expect((await back.signInByCode((address) => h.latestCode(address))).status).toBe(200);
    expect((await back.get("/api/viewer")).json).toEqual({ state: "pending", email });
    const old = await back.post("/api/auth/two-factor/verify-totp", {
      code: totp(target.secret, Date.now() + 30_000),
    });
    expect(old.status).not.toBe(200);
    expect((await back.get("/api/viewer")).json).toEqual({ state: "pending", email });
  });

  it("refuses malformed, self, unauthorised and below-aal2 requests before any work", async () => {
    const target = await enrolThroughHost(h, host, unique("reset.host.refused"), "viewer");
    const operator = await enrolThroughHost(h, host, unique("reset.host.operator"), "operator");
    // A pending member's aal1 session, which reaches only enrolment.
    const pendingEmail = unique("reset.host.pending");
    await h.seedMember(pendingEmail, "admin", "pending");
    const pending = host.client(pendingEmail);
    await pending.signInByCode((address) => h.latestCode(address));
    const before = (await h.events()).length;

    const extra = await admin.client.post(resetPath(target.staffId), { reason: "lost" });
    expect(extra.status).toBe(400);
    expect(extra.json).toMatchObject({ code: "invalid" });
    expect(JSON.stringify(extra.json)).not.toContain("lost");
    expect((await admin.client.post("/api/staff/not-an-id/reset-factors", {})).status).toBe(404);
    const self = await admin.client.post(resetPath(admin.staffId), {});
    expect(self.json).toMatchObject({ code: "giving_refused", problem: "self" });
    const notAllowed = await operator.client.post(resetPath(target.staffId), {});
    expect(notAllowed.status).toBe(403);
    expect(notAllowed.json).toMatchObject({
      code: "forbidden",
      permission: "staff.reset_factors",
    });
    const viaGet = await admin.client.get(resetPath(target.staffId));
    expect(viaGet.status).toBe(404);

    const below = await pending.post(resetPath(target.staffId), {});
    expect(below.status).toBe(403);
    expect(below.json).toMatchObject({ code: "factor_step_required" });

    // Without the origin gate's header, or Access's token, nothing reaches the route.
    const noHeader = await admin.client.post(resetPath(target.staffId), {}, { "x-fin-app": "" });
    expect(noHeader.status).toBe(403);
    expect(noHeader.json).toMatchObject({ code: "invalid_origin" });
    const noAccess = host.client(null);
    expect((await noAccess.post(resetPath(target.staffId), {})).status).toBe(401);

    expect((await h.events()).length).toBe(before);
    expect(
      await h.admin.query(
        "SELECT 1 FROM ops.step_up_intent WHERE action = 'staff.reset_factors' AND principal_id = ANY($1)",
        [[operator.staffId]],
      ),
    ).toMatchObject({ rowCount: 0 });
    expect((await target.client.get("/api/account")).status).toBe(200);
  });
});
