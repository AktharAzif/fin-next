// The staff factor reset on Postgres 18 (spec 02 §10.2, §10.4, §10.8, §8.5, §13.8, §16.4, §17.1,
// §17.3; [SA-14], [SA-29]): what @fin/staff's resetStaffFactors does to the member and what it
// leaves, run as the API half runs it (requireStaff, then the action, in the realm's unit of work,
// its intent proved with the Admin's passkey).
//   - Every session of the member ends and every factor goes: their old browser is signed out and
//     their old passkey no longer signs in; they are pending with one live code, which enrols them
//     again (the code they enrolled with before is spent).
//   - The reset's events, its intent and its code commit in one transaction with the actor's step-up;
//     the notice goes to the member and every active Admin and never carries the code.
//   - The database refuses a reset that writes no event; a refused reset writes nothing and asks for
//     no factor; an intent works for its member only, and once; a notice that cannot be queued
//     rolls the whole reset back.
//   - A pending member mid-enrolment loses the window; two Admins resetting at once leave one code.
//   - The member's own ceremonies cannot outlast it: a passkey sign-in or a further passkey that
//     was in flight when it committed leaves no session and no factor, the code it showed still
//     enrols the member, and a sign-in that overlaps it cannot make it fail.
import type { RequestContext } from "@fin/identity";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_ORIGIN,
  accessFor,
  type Browser,
  createStaffHarness,
  refusalOf,
  SoftAuthenticator,
  type StaffHarness,
  signInByCode,
  stepped,
  unique,
} from "../test/harness.ts";
import type { StaffDeps } from "./deps.ts";
import { redeemCode, resetStaffFactors } from "./members.ts";
import type { UnitTx } from "./ports.ts";
import { requireStaff } from "./require-staff.ts";

type RouteFn = (tx: UnitTx, request: Request, context: RequestContext) => Promise<unknown>;

let h: StaffHarness;
let adminPool: Pool;

interface Member {
  staffId: string;
  email: string;
  browser: Browser;
  authenticator: SoftAuthenticator;
}

let admin: Member;

async function enrolled(label: string, roleKey: string): Promise<Member> {
  const email = unique(label);
  return { ...(await h.enrolled(email, roleKey)), email };
}

beforeAll(async () => {
  h = await createStaffHarness("sat04reset");
  adminPool = h.login("fin_admin_a", 2);
  admin = await enrolled("reset.admin", "admin");
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const resetFn =
  (staffId: string): RouteFn =>
  async (tx, req, ctx) =>
    resetStaffFactors(
      h.deps,
      tx,
      await requireStaff(h.realm, req, ctx, { permission: "staff.reset_factors" }),
      staffId,
    );

const resetPath = (staffId: string) => ({
  method: "POST",
  path: `/api/staff/${staffId}/reset-factors`,
});

const reset = (who: Member, staffId: string) =>
  stepped(h, who.browser, who.authenticator, resetPath(staffId), resetFn(staffId)) as ReturnType<
    typeof resetStaffFactors
  >;

/** Asks for the reset's intent and proves it; the request is not sent again. */
async function provedIntent(who: Member, staffId: string): Promise<string> {
  const asked = await refusalOf(h.route(who.browser, resetPath(staffId), resetFn(staffId)));
  expect(asked.code).toBe("step_up_required");
  expect(asked.extensions).toMatchObject({
    step_up_kind: "intent",
    reason_key: "staff.reset_factors",
  });
  const intent = String(asked.extensions.intent_id);
  expect((await h.prove(who.browser, who.authenticator, intent)).status).toBe(200);
  return intent;
}

async function count(sql: string, values: readonly unknown[] = []): Promise<number> {
  return (await h.admin.query(sql, values)).rowCount ?? 0;
}

async function memberRow(staffId: string) {
  const result = await h.admin.query<{
    status: string;
    role_key: string;
    factor_enrolled_at: Date | null;
    two_factor_enabled: boolean;
    last_signed_in_at: Date | null;
  }>(
    `SELECT status, role_key, factor_enrolled_at, two_factor_enabled, last_signed_in_at
       FROM staff.member WHERE id = $1`,
    [staffId],
  );
  return result.rows[0];
}

/** What a member has to sign in with, and how many sessions are open for them. */
async function holdings(staffId: string) {
  return {
    sessions: await count("SELECT 1 FROM staff.session WHERE user_id = $1", [staffId]),
    passkeys: await count("SELECT 1 FROM staff.passkey WHERE user_id = $1", [staffId]),
    authenticators: await count("SELECT 1 FROM staff.two_factor WHERE user_id = $1", [staffId]),
    proofs: await count("SELECT 1 FROM staff.assurance WHERE user_id = $1", [staffId]),
    liveCodes: await count(
      "SELECT 1 FROM staff.enrolment_code WHERE member_id = $1 AND redeemed_at IS NULL AND voided_at IS NULL",
      [staffId],
    ),
  };
}

async function eventsAbout(staffId: string) {
  return (await h.events()).filter((e) => e.target_id === staffId || e.ref_ids.includes(staffId));
}

/** A passkey sign-in from a fresh browser under the member's Access identity. */
async function passkeySignIn(email: string, authenticator: SoftAuthenticator) {
  const browser = h.browser(accessFor(email));
  const options = await browser.auth("GET", "/passkey/generate-authenticate-options");
  expect(options.status).toBe(200);
  const response = authenticator.authenticate(String(options.json?.challenge));
  const answer = await browser.auth("POST", "/passkey/verify-authentication", { response });
  return { browser, status: answer.status };
}

/** Whether a browser's session still reaches a working staff route. */
async function reaches(browser: Browser): Promise<string> {
  const refused = await refusalOf(
    h.route(browser, { method: "GET", path: "/api/account" }, async (_tx, req, ctx) =>
      requireStaff(h.realm, req, ctx, {}),
    ),
  );
  return refused.code;
}

/** `POST /api/enrolment/redeem` from a pending member's own browser. */
function redeemIn(browser: Browser, code: string) {
  return h.route(
    browser,
    { method: "POST", path: "/api/enrolment/redeem", body: { code } },
    async (tx, req, ctx) =>
      redeemCode(h.deps, tx, await requireStaff(h.realm, req, ctx, { reach: ["pending"] }), code),
  );
}

/** A new passkey registered in this browser's session (inside its enrolment window). */
async function registerNewPasskey(browser: Browser) {
  const fresh = new SoftAuthenticator(new URL(ADMIN_ORIGIN).hostname, ADMIN_ORIGIN);
  const options = await browser.auth("GET", "/passkey/generate-register-options");
  expect(options.status).toBe(200);
  return browser.auth("POST", "/passkey/verify-registration", {
    response: fresh.register(options.json as { challenge: string; user: { id: string } }),
  });
}

/** A passkey assertion made in `browser` and not sent yet: the first half of a ceremony. */
async function assertionFrom(browser: Browser, authenticator: SoftAuthenticator) {
  const options = await browser.auth("GET", "/passkey/generate-authenticate-options");
  expect(options.status).toBe(200);
  return authenticator.authenticate(String(options.json?.challenge));
}

/** Waits until `n` backends of this test's database wait for a lock another transaction holds. */
async function lockWaiters(n: number): Promise<void> {
  for (let tries = 0; tries < 1000; tries += 1) {
    const waiting = await h.admin.query<{ n: number }>(
      `SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (Number(waiting.rows[0]?.n ?? 0) >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${n} backends never waited for a lock`);
}

/**
 * The reset of `staffId` with `intent`, held open inside its transaction at its first notice: by
 * then it holds the member's row, has ended their sessions and removed their factors, and has not
 * committed. `release()` lets it finish.
 */
function heldReset(staffId: string, intent: string) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = () => {};
  const atNotice = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let holding = true;
  const deps: StaffDeps = {
    ...h.deps,
    notify: async (tx, notice) => {
      if (holding) {
        holding = false;
        reached();
        await gate;
      }
      return h.deps.notify(tx, notice);
    },
  };
  const done = h.route(admin.browser, { ...resetPath(staffId), intent }, async (tx, req, ctx) =>
    resetStaffFactors(
      deps,
      tx,
      await requireStaff(h.realm, req, ctx, { permission: "staff.reset_factors" }),
      staffId,
    ),
  );
  const finishedEarly = done.then(() => {
    throw new Error("the reset finished before its first notice");
  });
  return { done, atNotice: Promise.race([atNotice, finishedEarly]), release };
}

describe("resetting a member's second factors (§10.2, §10.4, [SA-14])", () => {
  it("ends every session and removes every factor; the old passkey no longer signs in; the new code enrols them again", async () => {
    const target = await enrolled("reset.target", "operator");
    // A second browser of theirs, signed in with the passkey.
    const second = await passkeySignIn(target.email, target.authenticator);
    expect(second.status).toBe(200);
    expect(await reaches(target.browser)).toBe("none");
    expect(await reaches(second.browser)).toBe("none");
    const before = await memberRow(target.staffId);
    expect(await holdings(target.staffId)).toMatchObject({ sessions: 2, passkeys: 1 });

    const done = await reset(admin, target.staffId);
    expect(done).toMatchObject({ staffId: target.staffId, status: "pending" });
    expect(done.enrolmentCode.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(done.enrolmentCode.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);

    expect(await holdings(target.staffId)).toEqual({
      sessions: 0,
      passkeys: 0,
      authenticators: 0,
      proofs: 0,
      liveCodes: 1,
    });
    expect(await memberRow(target.staffId)).toEqual({
      status: "pending",
      role_key: "operator",
      factor_enrolled_at: null,
      two_factor_enabled: false,
      last_signed_in_at: before?.last_signed_in_at,
    });

    // Both of their browsers are signed out, and the passkey they still hold is refused.
    expect(await reaches(target.browser)).toBe("unauthenticated");
    expect(await reaches(second.browser)).toBe("unauthenticated");
    const stale = await passkeySignIn(target.email, target.authenticator);
    expect(stale.status).not.toBe(200);
    expect(await count("SELECT 1 FROM staff.session WHERE user_id = $1", [target.staffId])).toBe(0);

    // The emailed code leads to enrolment only; the new code opens it, a new passkey finishes it.
    const browser = h.browser(accessFor(target.email));
    await signInByCode(h, browser, target.email);
    expect(await reaches(browser)).toBe("factor_step_required");
    expect(await redeemIn(browser, done.enrolmentCode.code)).toMatchObject({ ok: true });
    const registered = await registerNewPasskey(browser);
    expect(registered.status, JSON.stringify(registered.json)).toBe(200);
    expect(await memberRow(target.staffId)).toMatchObject({
      status: "active",
      role_key: "operator",
    });
    expect(await reaches(browser)).toBe("none");
    const [enrolledAgain] = (await h.events("staff.factor_enrolled"))
      .filter((e) => e.target_id === target.staffId)
      .slice(-1);
    expect(enrolledAgain?.ref_ids).toContain(done.enrolmentCode.id);
  });

  it("writes its events in the reset's own transaction with the Admin's intent, its journal entry and its notices, never the code", async () => {
    const target = await enrolled("reset.audited", "viewer");
    const otherAdmin = await enrolled("reset.second.admin", "admin");
    const pendingAdmin = unique("reset.pending.admin");
    await h.seedMember(pendingAdmin, "admin", "pending");
    const outboxBefore = (await h.outbox("staff/staff-factors-reset")).length;
    const intent = await provedIntent(admin, target.staffId);
    const done = (await h.route(
      admin.browser,
      { ...resetPath(target.staffId), intent },
      resetFn(target.staffId),
    )) as Awaited<ReturnType<typeof resetStaffFactors>>;

    const events = (await eventsAbout(target.staffId)).filter((e) => e.actor_id === admin.staffId);
    expect(events.map((e) => e.event)).toEqual([
      "staff.factors_reset",
      "staff.enrolment_code_issued",
    ]);
    const [resetEvent, codeEvent] = events;
    expect(resetEvent).toMatchObject({
      target_id: target.staffId,
      actor_kind: "staff",
      actor_via: "admin",
      step_up_kind: "intent",
      step_up_ref: intent,
      metadata: { sessionsEnded: 1, factorsRemoved: 1 },
    });
    expect(codeEvent).toMatchObject({
      target_id: done.enrolmentCode.id,
      ref_ids: [target.staffId],
      metadata: { reason: "reset" },
      step_up_ref: intent,
    });
    const xids = await h.admin.query<{ xid: string; request_id: string }>(
      "SELECT xid::text AS xid, request_id FROM audit.event WHERE id = ANY($1)",
      [[resetEvent?.id, codeEvent?.id]],
    );
    expect(new Set(xids.rows.map((r) => r.xid)).size).toBe(1);
    const spent = await h.admin.query<{ consumed_request_id: string }>(
      "SELECT consumed_request_id FROM ops.step_up_intent WHERE id = $1 AND consumed_at IS NOT NULL",
      [intent],
    );
    expect(spent.rows.map((r) => r.consumed_request_id)).toEqual([xids.rows[0]?.request_id]);
    const journal = await h.admin.query<{ kind: string }>(
      "SELECT kind FROM audit.journal_entry WHERE audit_event_id = $1",
      [resetEvent?.id],
    );
    expect(journal.rows).toEqual([{ kind: "staff_factors_reset" }]);

    // The member, as `person`, and every active Admin; a pending Admin is nobody's way in yet.
    const notices = (await h.outbox("staff/staff-factors-reset")).slice(outboxBefore);
    const activeAdmins = await h.admin.query<{ email: string }>(
      "SELECT email FROM staff.member WHERE role_key = 'admin' AND status = 'active'",
    );
    expect(notices.map((n) => [n.recipient, n.params.audience]).sort()).toEqual(
      [[target.email, "person"], ...activeAdmins.rows.map((r) => [r.email, "admins"])].sort(),
    );
    expect(notices.map((n) => n.recipient)).toContain(otherAdmin.email);
    expect(notices.map((n) => n.recipient)).not.toContain(pendingAdmin);
    for (const notice of notices)
      expect(notice.params).toEqual({ staffId: target.staffId, audience: notice.params.audience });
    const everything = JSON.stringify(await h.outbox());
    expect(everything).not.toContain(done.enrolmentCode.code);
    expect(everything).not.toContain(done.enrolmentCode.code.replace(/-/g, ""));
    expect(h.lines.named("staff.changed").at(-1)).toEqual({
      kind: "reset",
      staffId: target.staffId,
      actorId: admin.staffId,
    });
  });

  it("is refused by the database when it writes no event (§13.8, AU-02)", async () => {
    const target = await enrolled("reset.silent", "viewer");
    const client = await adminPool.connect();
    let code: string | null = null;
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM staff.session WHERE user_id = $1", [target.staffId]);
      await client.query("DELETE FROM staff.passkey WHERE user_id = $1", [target.staffId]);
      await client.query(
        `UPDATE staff.member SET status = 'pending', factor_enrolled_at = NULL, two_factor_enabled = false
          WHERE id = $1`,
        [target.staffId],
      );
      await client.query("COMMIT");
    } catch (error) {
      code = (error as { code?: string }).code ?? "unknown";
      await client.query("ROLLBACK").catch(() => undefined);
    } finally {
      client.release();
    }
    expect(code).toBe("FA010");
    expect(await memberRow(target.staffId)).toMatchObject({ status: "active" });
    expect(await holdings(target.staffId)).toMatchObject({ sessions: 1, passkeys: 1 });
  });

  it("refuses resetting oneself, a removed or unknown member and a role without the permission, writing nothing and asking for no factor", async () => {
    const operator = await enrolled("reset.operator", "operator");
    const removed = await h.seedMember(unique("reset.removed"), "viewer", "removed");
    const unknown = removed.replace(/.$/, removed.endsWith("0") ? "1" : "0");
    const before = (await h.events()).length;
    const intentsBefore = await count(
      "SELECT 1 FROM ops.step_up_intent WHERE action = 'staff.reset_factors'",
    );

    expect(
      await refusalOf(h.route(admin.browser, resetPath(admin.staffId), resetFn(admin.staffId))),
    ).toMatchObject({ code: "giving_refused", extensions: { problem: "self" } });
    for (const id of [removed, unknown]) {
      expect((await refusalOf(h.route(admin.browser, resetPath(id), resetFn(id)))).code).toBe(
        "not_found",
      );
    }
    expect(
      await refusalOf(h.route(operator.browser, resetPath(admin.staffId), resetFn(admin.staffId))),
    ).toMatchObject({ code: "forbidden", extensions: { permission: "staff.reset_factors" } });

    expect((await h.events()).length).toBe(before);
    expect(
      await count("SELECT 1 FROM ops.step_up_intent WHERE action = 'staff.reset_factors'"),
    ).toBe(intentsBefore);
    expect(await memberRow(admin.staffId)).toMatchObject({ status: "active" });
  });

  it("takes an intent proved for that member only, and only once", async () => {
    const first = await enrolled("reset.bound.a", "viewer");
    const second = await enrolled("reset.bound.b", "viewer");
    const intent = await provedIntent(admin, first.staffId);

    const elsewhere = await refusalOf(
      h.route(admin.browser, { ...resetPath(second.staffId), intent }, resetFn(second.staffId)),
    );
    expect(elsewhere).toMatchObject({ code: "step_up_invalid", extensions: { reason: "digest" } });
    expect(await memberRow(second.staffId)).toMatchObject({ status: "active" });
    expect(await holdings(second.staffId)).toMatchObject({ sessions: 1, passkeys: 1 });

    await h.route(admin.browser, { ...resetPath(first.staffId), intent }, resetFn(first.staffId));
    const again = await refusalOf(
      h.route(admin.browser, { ...resetPath(first.staffId), intent }, resetFn(first.staffId)),
    );
    expect(again).toMatchObject({ code: "step_up_invalid", extensions: { reason: "used" } });
    expect(
      (await h.events("staff.factors_reset")).filter((e) => e.target_id === first.staffId),
    ).toHaveLength(1);
    expect(await holdings(first.staffId)).toMatchObject({ liveCodes: 1 });
  });

  it("rolls back whole when its notice cannot be queued, the intent unspent (§17.1)", async () => {
    const target = await enrolled("reset.unnoticed", "viewer");
    await h.admin.query(
      "DELETE FROM email.template_grant WHERE template = 'staff/staff-factors-reset'",
    );
    try {
      const intent = await provedIntent(admin, target.staffId);
      await expect(
        h.route(admin.browser, { ...resetPath(target.staffId), intent }, resetFn(target.staffId)),
      ).rejects.toThrow();
      expect(await memberRow(target.staffId)).toMatchObject({ status: "active" });
      expect(await holdings(target.staffId)).toMatchObject({
        sessions: 1,
        passkeys: 1,
        liveCodes: 0,
      });
      expect(await reaches(target.browser)).toBe("none");
      expect(
        (await h.events("staff.factors_reset")).filter((e) => e.target_id === target.staffId),
      ).toHaveLength(0);
      expect(
        await count(
          "SELECT 1 FROM ops.step_up_intent WHERE id = $1 AND proved_at IS NOT NULL AND consumed_at IS NULL",
          [intent],
        ),
      ).toBe(1);
      expect(h.lines.named("email.security_unsent").at(-1)).toEqual({
        template: "staff/staff-factors-reset",
        reason: "not_allowed",
      });
    } finally {
      await h.admin.query(
        "INSERT INTO email.template_grant (template, role, category) VALUES ('staff/staff-factors-reset', 'fin_admin', 'security')",
      );
    }
  });

  it("ends a pending member's enrolment window with their session, leaving only the new code", async () => {
    const email = unique("reset.pending");
    const { staffId, browser } = await h.pendingSession(email, "viewer");
    // Redeemed: the window is open on that session.
    expect(
      await count(
        "SELECT 1 FROM staff.session WHERE user_id = $1 AND enrolment_open_until > now()",
        [staffId],
      ),
    ).toBe(1);
    const done = await reset(admin, staffId);
    expect(done.status).toBe("pending");
    expect(await holdings(staffId)).toMatchObject({ sessions: 0, liveCodes: 1 });
    const options = await browser.auth("GET", "/passkey/generate-register-options");
    expect(options.status).not.toBe(200);
    const [event] = (await h.events("staff.factors_reset")).filter((e) => e.target_id === staffId);
    expect(event?.metadata).toEqual({ sessionsEnded: 1, factorsRemoved: 0 });
  });

  it("leaves exactly one live code when two Admins reset the same member at once", async () => {
    const otherAdmin = await enrolled("reset.race.admin", "admin");
    const target = await enrolled("reset.race.target", "compliance");
    const intents = [
      await provedIntent(admin, target.staffId),
      await provedIntent(otherAdmin, target.staffId),
    ];
    const results = await Promise.allSettled(
      [admin, otherAdmin].map((who, i) =>
        h.route(
          who.browser,
          { ...resetPath(target.staffId), intent: intents[i] as string },
          resetFn(target.staffId),
        ),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await holdings(target.staffId)).toMatchObject({
      sessions: 0,
      passkeys: 0,
      liveCodes: 1,
    });
    const codes = results.map(
      (r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof resetStaffFactors>>>).value,
    );
    const live = await h.admin.query<{ id: string }>(
      "SELECT id FROM staff.enrolment_code WHERE member_id = $1 AND redeemed_at IS NULL AND voided_at IS NULL",
      [target.staffId],
    );
    expect(codes.map((c) => c.enrolmentCode.id)).toContain(live.rows[0]?.id);
    expect(
      (await h.events("staff.factors_reset")).filter((e) => e.target_id === target.staffId),
    ).toHaveLength(2);
  });
});

describe("a reset while the member's own ceremony is in flight (§10.4, §11.4)", () => {
  it("leaves no session from a passkey sign-in that was in flight when it committed, even once the member enrols again", async () => {
    const target = await enrolled("reset.inflight", "operator");
    const intent = await provedIntent(admin, target.staffId);
    // Whoever holds the lost device begins a passkey sign-in, and the reset runs at that moment.
    const device = h.browser(accessFor(target.email));
    const response = await assertionFrom(device, target.authenticator);
    const reset = heldReset(target.staffId, intent);
    await reset.atNotice;
    const signingIn = device.auth("POST", "/passkey/verify-authentication", { response });
    await lockWaiters(1);
    reset.release();
    const [done, signIn] = await Promise.all([reset.done, signingIn]);

    expect(done.status).toBe("pending");
    // The passkey went with the reset, so the sign-in is refused as an unknown passkey would be.
    expect(signIn.status).toBe(401);
    expect(await holdings(target.staffId)).toMatchObject({
      sessions: 0,
      passkeys: 0,
      liveCodes: 1,
    });
    // The member enrols again with the reset's code; the device is signed out all the same.
    const browser = h.browser(accessFor(target.email));
    await signInByCode(h, browser, target.email);
    expect(await redeemIn(browser, done.enrolmentCode.code)).toMatchObject({ ok: true });
    expect((await registerNewPasskey(browser)).status).toBe(200);
    expect(await reaches(browser)).toBe("none");
    expect(await reaches(device)).toBe("unauthenticated");
  });

  it("is not made to fail by a passkey sign-in that overlaps it", async () => {
    const target = await enrolled("reset.overlap", "viewer");
    const intent = await provedIntent(admin, target.staffId);
    const device = h.browser(accessFor(target.email));
    const response = await assertionFrom(device, target.authenticator);
    // Another transaction holds the member's row for a moment: the reset queues for it first and
    // the sign-in second, and both go on when it lets go.
    const blocker = await h.platform.superuser();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM staff.member WHERE id = $1 FOR UPDATE", [target.staffId]);
      const resetting = h.route(
        admin.browser,
        { ...resetPath(target.staffId), intent },
        resetFn(target.staffId),
      );
      resetting.catch(() => undefined);
      await lockWaiters(1);
      const signingIn = device.auth("POST", "/passkey/verify-authentication", { response });
      signingIn.catch(() => undefined);
      await lockWaiters(2);
      await blocker.query("ROLLBACK");
      const [reset, signIn] = await Promise.allSettled([resetting, signingIn]);

      expect(reset.status).toBe("fulfilled");
      expect(signIn).toMatchObject({ status: "fulfilled", value: { status: 401 } });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
    expect(await holdings(target.staffId)).toMatchObject({
      sessions: 0,
      passkeys: 0,
      liveCodes: 1,
    });
  });

  it("leaves no factor from a further passkey that was in flight when it committed, and its code still enrols the member", async () => {
    const target = await enrolled("reset.adding", "viewer");
    // Whoever holds the member's unlocked device proves `add_factor` and begins a further passkey.
    const asked = await target.browser.auth("POST", "/passkey/verify-registration", {});
    expect(asked.json).toMatchObject({ code: "step_up_required", reason_key: "add_factor" });
    const addIntent = String(asked.json?.intent_id);
    expect((await h.prove(target.browser, target.authenticator, addIntent)).status).toBe(200);
    const extra = new SoftAuthenticator(new URL(ADMIN_ORIGIN).hostname, ADMIN_ORIGIN);
    const options = await target.browser.auth(
      "GET",
      "/passkey/generate-register-options",
      undefined,
      { "fin-step-up-intent": addIntent },
    );
    expect(options.status).toBe(200);
    const response = extra.register(options.json as { challenge: string; user: { id: string } });
    const reset = heldReset(target.staffId, await provedIntent(admin, target.staffId));
    await reset.atNotice;
    const adding = target.browser.auth(
      "POST",
      "/passkey/verify-registration",
      { response },
      { "fin-step-up-intent": addIntent },
    );
    await lockWaiters(1);
    reset.release();
    const [done, added] = await Promise.all([reset.done, adding]);

    // The session that asked for it ended with the reset, so the registration is refused.
    expect(added.status).toBe(401);
    expect(await holdings(target.staffId)).toMatchObject({
      sessions: 0,
      passkeys: 0,
      authenticators: 0,
      liveCodes: 1,
    });
    expect(
      (await h.events("staff.factor_added")).filter((e) => e.ref_ids.includes(target.staffId)),
    ).toHaveLength(0);
    // The code the Admin was shown still opens enrolment, and the member gets back in.
    const browser = h.browser(accessFor(target.email));
    await signInByCode(h, browser, target.email);
    expect(await reaches(browser)).toBe("factor_step_required");
    expect(await redeemIn(browser, done.enrolmentCode.code)).toMatchObject({ ok: true });
    expect((await registerNewPasskey(browser)).status).toBe(200);
    expect(await memberRow(target.staffId)).toMatchObject({ status: "active" });
  });
});
