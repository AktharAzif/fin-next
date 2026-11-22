// The staff realm's sign-in (spec 02 §6.4, §6.5, §10.5; T-SAT-34's realm half; AC-SAT-12,
// AC-SAT-29, AC-SAT-41): a code goes only to the Access identity's own address; a pending member
// enrols only with the emailed code and an enrolment code, once; production refuses an
// authenticator as the first factor; staff set-up answers carry no backup codes; a session whose
// member is not the Access identity is refused and logged; a removed member cannot sign in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, seed, type TestDatabase } from "../test/db.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  passkeyCeremony,
  registerPasskey,
  totpFromUri,
} from "../test/harness.ts";
import { totp } from "./crypto/totp.ts";
import { systemClock } from "./ports/clock.ts";
import { newId } from "./ports/ids.ts";
import { revokeOtherSessions, revokeSession } from "./sessions.ts";
import { issueEnrolmentCode, redeemEnrolmentCode } from "./staff/enrolment.ts";

let database: TestDatabase;
let h: Harness;
let production: Harness;

beforeAll(async () => {
  database = await createTestDatabase("staff");
  h = await createHarness(database, "staff");
  production = await createHarness(database, "staff", { env: { FIN_ENVIRONMENT: "production" } });
  await addMember("admin.one@example.com", "admin", "active");
});

afterAll(async () => {
  await database.drop();
});

const unique = (label: string) => `${label}.${Math.random().toString(36).slice(2, 8)}@example.com`;

async function addMember(
  email: string,
  roleKey: string,
  status: "pending" | "active" | "removed",
): Promise<string> {
  const id = newId("stf", systemClock);
  await seed(
    h.admin,
    `INSERT INTO staff.member (id, email, role_key, status, added_by, factor_enrolled_at, removed_at)
     VALUES ($1, $2, $3, $4, 'operator',
             CASE WHEN $4 = 'active' THEN now() END, CASE WHEN $4 = 'removed' THEN now() END)`,
    [id, email, roleKey, status],
  );
  return id;
}

function staffBrowser(harness: Harness, email: string): Browser {
  return harness.browser({ access: { email, sub: `sub-${email}` } });
}

async function staffCode(harness: Harness, browser: Browser, email: string) {
  const sent = await browser.post("/api/auth/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  expect(sent.json).toEqual({ success: true });
  const code = await harness.latestCode(email);
  return {
    sent,
    code,
    signedIn:
      code === null
        ? null
        : await browser.post("/api/auth/sign-in/email-otp", { email, otp: code }),
  };
}

async function sessionOf(browser: Browser) {
  const result = await h.admin.query<{ id: string; assurance: string; access_sub: string }>(
    "SELECT id, assurance, access_sub FROM staff.session WHERE token = $1",
    [browser.sessionToken()],
  );
  return result.rows[0];
}

async function issue(memberId: string) {
  return h.realm.run(
    { requestId: newId("req", systemClock), clientIp: null, userAgent: null },
    (tx) =>
      issueEnrolmentCode(tx, h.realm.runtime, {
        memberId,
        reason: "added",
        issuedBy: "operator",
        actor: { kind: "operator", id: null },
      }),
  );
}

async function redeem(browser: Browser, memberId: string, code: string) {
  const session = await sessionOf(browser);
  return h.realm.run(browser.context(), (tx) =>
    redeemEnrolmentCode(tx, h.realm.runtime, { memberId, sessionId: session?.id as string, code }),
  );
}

describe("staff codes (§10.5)", () => {
  it("go only to the Access identity's own address, with the same answer otherwise", async () => {
    const email = unique("staff.code");
    await addMember(email, "viewer", "pending");
    const other = unique("someone.else");
    const browser = staffBrowser(h, email);
    const wrongAddress = await browser.post("/api/auth/email-otp/send-verification-otp", {
      email: other,
      type: "sign-in",
    });
    expect(wrongAddress.json).toEqual({ success: true });
    expect(await h.latestCode(other)).toBeNull();

    const outsider = staffBrowser(h, unique("not.staff"));
    const notListed = await outsider.post("/api/auth/email-otp/send-verification-otp", {
      email: outsider.options.access?.email,
      type: "sign-in",
    });
    expect(notListed.json).toEqual({ success: true });
    expect(h.lines.named("staff.not_listed").at(-1)).toEqual({ reason: "code_request" });

    const { signedIn } = await staffCode(h, browser, email);
    expect(signedIn?.status, JSON.stringify(signedIn?.json)).toBe(200);
    expect(await sessionOf(browser)).toMatchObject({
      assurance: "aal1",
      access_sub: `sub-${email}`,
    });
    expect((await h.outbox(email)).map((m) => m.template)).toEqual(["staff/staff-sign-in-code"]);
  });

  it("write the gate the new session is at on the request line (§18.1)", async () => {
    const pendingEmail = unique("line.pending");
    await addMember(pendingEmail, "viewer", "pending");
    const before = h.lines.named("request").length;
    await staffCode(h, staffBrowser(h, pendingEmail), pendingEmail);
    expect(h.lines.named("request").slice(before).at(-1)).toMatchObject({
      authPath: "/sign-in/email-otp",
      assurance: "aal1",
      gate: "pending",
    });
    const { email } = await enrolledMember("line.enrolled");
    const again = h.lines.named("request").length;
    await staffCode(h, staffBrowser(h, email), email);
    expect(h.lines.named("request").slice(again).at(-1)).toMatchObject({
      authPath: "/sign-in/email-otp",
      assurance: "aal1",
      gate: "factor_step",
    });
  });

  it("never sign in a removed member", async () => {
    const email = unique("removed");
    await addMember(email, "viewer", "removed");
    const browser = staffBrowser(h, email);
    const sent = await browser.post("/api/auth/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    });
    expect(sent.json).toEqual({ success: true });
    expect(await h.latestCode(email)).toBeNull();
  });
});

describe("enrolment ([SA-29], §6.5)", () => {
  it("needs the enrolment code, works once, and makes the member active at aal2", async () => {
    const email = unique("pending");
    const memberId = await addMember(email, "viewer", "pending");
    const browser = staffBrowser(h, email);
    const { signedIn } = await staffCode(h, browser, email);
    expect(signedIn?.status).toBe(200);

    // Pending: everything but enrolment is refused, and registering needs the window.
    const blocked = await browser.post("/api/auth/two-factor/disable", {});
    expect(blocked.json).toMatchObject({ code: "factor_step_required" });
    const noWindow = await browser.get("/api/auth/passkey/generate-register-options");
    expect(noWindow.status).toBe(403);
    expect(noWindow.json).toMatchObject({ code: "forbidden", reason: "enrolment_code_required" });

    const issued = await issue(memberId);
    expect(issued.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(await redeem(browser, memberId, "0000-0000-0000-0000")).toEqual({
      ok: false,
      reason: "wrong",
    });
    const redeemed = await redeem(browser, memberId, issued.code.toLowerCase());
    expect(redeemed).toMatchObject({ ok: true, enrolmentCodeId: issued.id });
    expect(await redeem(browser, memberId, issued.code)).toEqual({ ok: false, reason: "used" });

    const authenticator = h.authenticator();
    const { verify } = await registerPasskey(browser, authenticator);
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
    expect(await sessionOf(browser)).toMatchObject({ assurance: "aal2" });
    const member = await h.admin.query<{ status: string }>(
      "SELECT status FROM staff.member WHERE id = $1",
      [memberId],
    );
    expect(member.rows[0]?.status).toBe("active");
    const enrolled = (await h.events({ event: "staff.factor_enrolled" })).find(
      (e) => e.target_id === memberId,
    );
    expect(enrolled?.ref_ids).toContain(issued.id);
    expect(
      (await h.outbox("admin.one@example.com")).some(
        (m) => m.template === "staff/staff-factor-enrolled",
      ),
    ).toBe(true);
    for (const event of [
      "staff.enrolment_code_issued",
      "staff.enrolment_code_redeemed",
      "staff.second_factor_required",
    ]) {
      expect((await h.events({ event })).length, event).toBeGreaterThan(0);
    }
    expect(h.lines.named("staff.enrolment_refused").some((l) => l.reason === "wrong")).toBe(true);
  });

  it("refuses an authenticator as the first factor in production ([SA-04])", async () => {
    const email = unique("prod");
    const memberId = await addMember(email, "viewer", "pending");
    const browser = staffBrowser(production, email);
    const { signedIn } = await staffCode(production, browser, email);
    expect(signedIn?.status).toBe(200);
    const issued = await issue(memberId);
    const session = await sessionOf(browser);
    await production.realm.run(browser.context(), (tx) =>
      redeemEnrolmentCode(tx, production.realm.runtime, {
        memberId,
        sessionId: session?.id as string,
        code: issued.code,
      }),
    );
    const refused = await browser.post("/api/auth/two-factor/enable", {});
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ reason: "passkey_first" });
  });

  it("answers an authenticator set-up with no backup codes, and stores none (S2-03)", async () => {
    const email = unique("totp.staff");
    const memberId = await addMember(email, "viewer", "pending");
    const browser = staffBrowser(h, email);
    await staffCode(h, browser, email);
    const issued = await issue(memberId);
    await redeem(browser, memberId, issued.code);
    const enable = await browser.post("/api/auth/two-factor/enable", { trustDevice: true });
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
    expect(enable.json?.backupCodes).toBeUndefined();
    expect(enable.json?.totpURI).toMatch(/^otpauth:/);
    expect((await h.events({ event: "staff.factor_setup_started" })).length).toBeGreaterThan(0);
    const blocked = await browser.post("/api/auth/two-factor/verify-backup-code", { code: "x" });
    expect(blocked.status).toBe(404);
  });
});

describe("finishing an authenticator as the first factor (§6.5, §10.3)", () => {
  it("enrols the member inside the enrolment window", async () => {
    const email = unique("totp.enrol");
    const memberId = await addMember(email, "viewer", "pending");
    const browser = staffBrowser(h, email);
    await staffCode(h, browser, email);
    const issued = await issue(memberId);
    await redeem(browser, memberId, issued.code);
    const enable = await browser.post("/api/auth/two-factor/enable", {});
    const secret = totpFromUri(String(enable.json?.totpURI)).secret;
    const finished = await browser.post("/api/auth/two-factor/verify-totp", {
      code: totp(secret, new Date()),
    });
    expect(finished.status, JSON.stringify(finished.json)).toBe(200);
    expect(await sessionOf(browser)).toMatchObject({ assurance: "aal2" });
    const member = await h.admin.query<{ status: string }>(
      "SELECT status FROM staff.member WHERE id = $1",
      [memberId],
    );
    expect(member.rows[0]?.status).toBe("active");
    expect(
      (await h.events({ event: "staff.factor_enrolled" })).some((e) => e.target_id === memberId),
    ).toBe(true);
  });

  it("happens only inside the enrolment window", async () => {
    const email = unique("totp.window");
    const memberId = await addMember(email, "viewer", "pending");
    const browser = staffBrowser(h, email);
    await staffCode(h, browser, email);
    const issued = await issue(memberId);
    await redeem(browser, memberId, issued.code);
    const enable = await browser.post("/api/auth/two-factor/enable", {});
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
    const secret = totpFromUri(String(enable.json?.totpURI)).secret;
    // The window closes before the code is entered.
    await seed(
      h.admin,
      "UPDATE staff.session SET enrolment_open_until = now() - interval '1 second' WHERE token = $1",
      [browser.sessionToken()],
    );
    const late = await browser.post("/api/auth/two-factor/verify-totp", {
      code: totp(secret, new Date()),
    });
    expect(late.status).toBe(403);
    expect(late.json).toMatchObject({ code: "forbidden", reason: "enrolment_code_required" });
    expect(h.lines.named("staff.enrolment_refused").at(-1)).toEqual({
      staffId: memberId,
      reason: "no_window",
    });
    expect(await sessionOf(browser)).toMatchObject({ assurance: "aal1" });
    const member = await h.admin.query<{ status: string }>(
      "SELECT status FROM staff.member WHERE id = $1",
      [memberId],
    );
    expect(member.rows[0]?.status).toBe("pending");
  });
});

/** A member enrolled with a passkey, signed in at aal2 in their own browser. */
async function enrolledMember(label: string) {
  const email = unique(label);
  const memberId = await addMember(email, "operator", "pending");
  const browser = staffBrowser(h, email);
  await staffCode(h, browser, email);
  const issued = await issue(memberId);
  await redeem(browser, memberId, issued.code);
  const authenticator = h.authenticator();
  const { verify } = await registerPasskey(browser, authenticator);
  expect(verify.status).toBe(200);
  return { email, memberId, browser, authenticator };
}

describe("a working staff member", () => {
  it("signs in with a passkey alone, and out again", async () => {
    const { email, authenticator, browser } = await enrolledMember("passkey.alone");
    const out = await browser.post("/api/auth/sign-out");
    expect(out.status).toBe(200);
    expect((await h.events({ event: "staff.signed_out" })).length).toBeGreaterThan(0);
    const fresh = staffBrowser(h, email);
    const signedIn = await passkeyCeremony(fresh, authenticator);
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
    expect(await sessionOf(fresh)).toMatchObject({ assurance: "aal2" });
    expect(
      (await h.events({ event: "staff.signed_in" })).some((e) => e.metadata.method === "passkey"),
    ).toBe(true);
    expect((await h.outbox(email)).some((m) => m.template === "staff/staff-new-sign-in")).toBe(
      true,
    );
  });

  it("adds and removes a further factor only with intents", async () => {
    const { browser, authenticator } = await enrolledMember("further");
    // The options GET makes no intent (§2.3); the POST that adds the factor does.
    const options = await browser.get("/api/auth/passkey/generate-register-options");
    expect(options.json).toMatchObject({ code: "step_up_required", reason_key: "add_factor" });
    expect(options.json?.intent_id).toBeUndefined();
    const asked = await browser.post("/api/auth/passkey/verify-registration", {});
    expect(asked.json).toMatchObject({ code: "step_up_required", reason_key: "add_factor" });
    const intent = String(asked.json?.intent_id);
    expect(
      (await passkeyCeremony(browser, authenticator, { "fin-step-up-intent": intent })).status,
    ).toBe(200);
    expect(
      (await h.events({ event: "staff.step_up_passed" })).some(
        (e) => e.metadata.intentId === intent,
      ),
    ).toBe(true);
    const second = h.authenticator();
    const { verify } = await registerPasskey(browser, second, { "fin-step-up-intent": intent });
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
    expect(
      (await h.events({ event: "staff.factor_added" })).some(
        (e) => e.target_id === verify.json?.id,
      ),
    ).toBe(true);

    const id = String(verify.json?.id);
    const removeAsked = await browser.post("/api/auth/passkey/delete-passkey", { id });
    const removeIntent = String(removeAsked.json?.intent_id);
    expect(
      (await passkeyCeremony(browser, authenticator, { "fin-step-up-intent": removeIntent }))
        .status,
    ).toBe(200);
    const removed = await browser.post(
      "/api/auth/passkey/delete-passkey",
      { id },
      { "fin-step-up-intent": removeIntent },
    );
    expect(removed.status, JSON.stringify(removed.json)).toBe(200);
    expect(
      (await h.events({ event: "staff.factor_removed" })).some((e) => e.target_id === id),
    ).toBe(true);

    // The last factor stays for every staff member (§6.7).
    const first = String(
      (
        await h.admin.query<{ id: string }>(
          "SELECT p.id FROM staff.passkey p JOIN staff.session s ON s.user_id = p.user_id WHERE s.token = $1",
          [browser.sessionToken()],
        )
      ).rows[0]?.id,
    );
    const lastAsked = await browser.post("/api/auth/passkey/delete-passkey", { id: first });
    const lastIntent = String(lastAsked.json?.intent_id);
    expect(
      (await passkeyCeremony(browser, authenticator, { "fin-step-up-intent": lastIntent })).status,
    ).toBe(200);
    const kept = await browser.post(
      "/api/auth/passkey/delete-passkey",
      { id: first },
      { "fin-step-up-intent": lastIntent },
    );
    expect(kept.status).toBe(409);
    expect(kept.json).toMatchObject({ code: "last_factor" });
  });

  it("is signed out after five refused ceremonies at a step-up (§7.7)", async () => {
    const victim = await enrolledMember("victim");
    const other = await enrolledMember("other");
    const asked = await victim.browser.post("/api/auth/passkey/verify-registration", {});
    const intent = String(asked.json?.intent_id);
    for (let i = 0; i < 5; i += 1) {
      const refused = await passkeyCeremony(victim.browser, other.authenticator, {
        "fin-step-up-intent": intent,
      });
      expect(refused.status).toBe(403);
    }
    expect((await h.events({ event: "staff.step_up_failed" })).length).toBeGreaterThanOrEqual(5);
    expect((await h.events({ event: "staff.step_up_locked" })).length).toBe(1);
    const after = await victim.browser.get("/api/auth/passkey/generate-register-options");
    expect(after.json).toMatchObject({ code: "unauthenticated", reason: "too_many_tries" });
  });

  it("never lets the factor step finish an authenticator whose set-up was left unfinished", async () => {
    const { email, browser, authenticator } = await enrolledMember("unfinished");
    const asked = await browser.post("/api/auth/two-factor/enable", {});
    const intent = String(asked.json?.intent_id);
    expect(
      (await passkeyCeremony(browser, authenticator, { "fin-step-up-intent": intent })).status,
    ).toBe(200);
    const enabled = await browser.post(
      "/api/auth/two-factor/enable",
      {},
      { "fin-step-up-intent": intent },
    );
    expect(enabled.status, JSON.stringify(enabled.json)).toBe(200);
    const secret = totpFromUri(String(enabled.json?.totpURI)).secret;
    // A second sign-in by code from another browser of the same Access identity: aal1.
    const other = staffBrowser(h, email);
    const { signedIn } = await staffCode(h, other, email);
    expect(signedIn?.status).toBe(200);
    const right = await other.post("/api/auth/two-factor/verify-totp", {
      code: totp(secret, new Date()),
    });
    expect(right.status).toBe(400);
    expect(right.json).toMatchObject({ code: "TOTP_NOT_ENABLED" });
    expect(await sessionOf(other)).toMatchObject({ assurance: "aal1" });
  });

  it("signs out one other session and every other session", async () => {
    const { email, memberId, browser, authenticator } = await enrolledMember("sessions");
    const second = staffBrowser(h, email);
    await passkeyCeremony(second, authenticator);
    const third = staffBrowser(h, email);
    await passkeyCeremony(third, authenticator);
    const current = await sessionOf(browser);
    const target = await sessionOf(second);
    const who = {
      personId: memberId,
      email,
      currentSessionId: current?.id as string,
      actor: { kind: "staff" as const, id: memberId, via: "admin" as const },
      context: { clientIp: null, userAgent: null },
      knownBrowserToken: null,
      trustedBrowserToken: null,
    };
    const count = await h.realm.run(browser.context(), async (tx) => {
      expect(await revokeSession(h.realm.runtime, tx, who, target?.id as string)).toBe(true);
      return revokeOtherSessions(h.realm.runtime, tx, who);
    });
    expect(count).toBe(1);
    expect(
      (await h.events({ event: "staff.session_revoked" })).some((e) => e.target_id === target?.id),
    ).toBe(true);
    expect(
      (await h.events({ event: "staff.signed_out_everywhere" })).some(
        (e) => e.target_id === memberId,
      ),
    ).toBe(true);
    expect(await sessionOf(third)).toBeUndefined();
    expect(await sessionOf(browser)).toBeDefined();
  });
});

describe("the Access identity (§10.5, AC-SAT-12)", () => {
  it("must equal the session's member on every request", async () => {
    const email = unique("mismatch");
    await addMember(email, "viewer", "pending");
    const browser = staffBrowser(h, email);
    await staffCode(h, browser, email);
    const session = await sessionOf(browser);
    browser.options.access = { email: unique("intruder"), sub: "sub-intruder" };
    const refused = await browser.post("/api/auth/sign-out");
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: "access_mismatch" });
    const gone = await h.admin.query("SELECT 1 FROM staff.session WHERE id = $1", [session?.id]);
    expect(gone.rowCount).toBe(0);
    expect(h.lines.named("staff.access_mismatch").length).toBeGreaterThan(0);
    expect(
      (await h.events({ event: "staff.sign_in_failed" })).some(
        (e) => e.metadata.reason === "access_mismatch",
      ),
    ).toBe(true);
  });

  it("must keep the subject the session was made under, even with the same address", async () => {
    const { email, memberId, browser } = await enrolledMember("subject");
    const session = await sessionOf(browser);
    expect(session?.assurance).toBe("aal2");
    const mismatchesBefore = h.lines.named("staff.access_mismatch").length;
    // The same address under another Access identity (a re-created or second IdP account).
    browser.options.access = { email, sub: "sub-of-another-access-identity" };
    const refused = await browser.get("/api/auth/get-session");
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: "access_mismatch" });
    const gone = await h.admin.query("SELECT 1 FROM staff.session WHERE id = $1", [session?.id]);
    expect(gone.rowCount).toBe(0);
    expect(h.lines.named("staff.access_mismatch").slice(mismatchesBefore)).toEqual([
      { staffId: memberId },
    ]);
    expect(
      (await h.events({ event: "staff.sign_in_failed" })).some(
        (e) => e.target_id === memberId && e.metadata.reason === "access_mismatch",
      ),
    ).toBe(true);
  });

  it("is required for a staff code at all", async () => {
    const browser = h.browser();
    const answer = await browser.post("/api/auth/email-otp/send-verification-otp", {
      email: "admin.one@example.com",
      type: "sign-in",
    });
    expect(answer.status).toBe(401);
    expect(answer.json).toMatchObject({ code: "access_required" });
  });
});
