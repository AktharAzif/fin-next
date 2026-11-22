// Staff management on Postgres 18 (spec 02 §10.2, §8.5, §16.4, §17.3; T-SAT-23, T-SAT-34's staff
// half): each change runs as the API half runs it (requireStaff, then the action, in the realm's
// unit of work, its intent proved with a passkey), writes its events, its journal entry and its
// notices with it, and every refusal of §8.5 writes nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Browser,
  createStaffHarness,
  DROP_TIMEOUT_MS,
  refusalOf,
  type SoftAuthenticator,
  type StaffHarness,
  stepped,
  unique,
} from "../test/harness.ts";
import { instrument, markSetup, timed, timeTests } from "../test/timing.ts";
import { hashEnrolmentCode } from "./enrolment-codes.ts";
import {
  addStaff,
  changeStaffRole,
  newEnrolmentCode,
  removeStaff,
  resetStaffFactors,
} from "./members.ts";
import { requireStaff } from "./require-staff.ts";

let h: StaffHarness;

timeTests("src/members.db.test.ts");

/**
 * An address as Postgres's `host(inet)` writes it back: lower case, no leading zeros, the longest
 * run of zero groups compressed. A browser's random group (`2001:db8:0a1b::1`) may have a zero.
 */
const canonicalIp = (ip: string) => new URL(`http://[${ip}]`).hostname.slice(1, -1);

interface Member {
  staffId: string;
  email: string;
  browser: Browser;
  authenticator: SoftAuthenticator;
}

let admin: Member;

async function enrolled(label: string, roleKey: string): Promise<Member> {
  const email = unique(label);
  const made = await h.enrolled(email, roleKey);
  return { ...made, email };
}

beforeAll(async () => {
  markSetup();
  h = await timed("createStaffHarness", () => createStaffHarness("sat04members"));
  instrument(h);
  admin = await enrolled("admin", "admin");
}, 120_000);

afterAll(async () => {
  await h?.close();
}, DROP_TIMEOUT_MS);

const add = (who: Member, email: string, roleKey: string) =>
  stepped(
    h,
    who.browser,
    who.authenticator,
    { method: "POST", path: "/api/staff" },
    async (tx, req, ctx) =>
      addStaff(h.deps, tx, await requireStaff(h.realm, req, ctx, { permission: "staff.add" }), {
        email,
        roleKey,
      }),
  );

const changeRole = (who: Member, staffId: string, roleKey: string) =>
  stepped(
    h,
    who.browser,
    who.authenticator,
    { method: "PATCH", path: `/api/staff/${staffId}` },
    async (tx, req, ctx) =>
      changeStaffRole(
        h.deps,
        tx,
        await requireStaff(h.realm, req, ctx, { permission: "staff.role" }),
        staffId,
        {
          roleKey,
        },
      ),
  );

const remove = (who: Member, staffId: string) =>
  stepped(
    h,
    who.browser,
    who.authenticator,
    { method: "POST", path: `/api/staff/${staffId}/remove` },
    async (tx, req, ctx) =>
      removeStaff(
        h.deps,
        tx,
        await requireStaff(h.realm, req, ctx, { permission: "staff.remove" }),
        staffId,
      ),
  );

const reset = (who: Member, staffId: string) =>
  stepped(
    h,
    who.browser,
    who.authenticator,
    { method: "POST", path: `/api/staff/${staffId}/reset-factors` },
    async (tx, req, ctx) =>
      resetStaffFactors(
        h.deps,
        tx,
        await requireStaff(h.realm, req, ctx, { permission: "staff.reset_factors" }),
        staffId,
      ),
  );

const reissue = (who: Member, staffId: string) =>
  stepped(
    h,
    who.browser,
    who.authenticator,
    { method: "POST", path: `/api/staff/${staffId}/enrolment-code` },
    async (tx, req, ctx) =>
      newEnrolmentCode(
        h.deps,
        tx,
        await requireStaff(h.realm, req, ctx, { permission: "staff.add" }),
        staffId,
      ),
  );

async function member(staffId: string) {
  const result = await h.admin.query<{ status: string; role_key: string; added_by: string }>(
    "SELECT status, role_key, added_by FROM staff.member WHERE id = $1",
    [staffId],
  );
  return result.rows[0];
}

async function eventsAbout(staffId: string) {
  return (await h.events()).filter((e) => e.target_id === staffId || e.ref_ids.includes(staffId));
}

async function count(sql: string, values: readonly unknown[] = []): Promise<number> {
  const result = await h.admin.query<{ n: number }>(
    `SELECT count(*)::integer AS n FROM (${sql}) q`,
    values,
  );
  return Number(result.rows[0]?.n ?? 0);
}

describe("adding staff (§10.2)", () => {
  it("makes a pending member with one live code, its events with the intent and request, and the notices", async () => {
    const email = unique("added");
    const added = await add(admin, email, "viewer");
    expect(added).toMatchObject({
      email,
      roleKey: "viewer",
      roleLabel: "Viewer",
      status: "pending",
      reactivated: false,
    });
    expect(await member(added.staffId)).toEqual({
      status: "pending",
      role_key: "viewer",
      added_by: admin.staffId,
    });
    const codes = await h.admin.query<{
      id: string;
      code_hash: Buffer;
      reason: string;
      issued_by: string;
    }>(
      "SELECT id, code_hash, reason, issued_by FROM staff.enrolment_code WHERE member_id = $1 AND voided_at IS NULL",
      [added.staffId],
    );
    expect(codes.rows).toHaveLength(1);
    expect(codes.rows[0]?.code_hash.equals(hashEnrolmentCode(added.enrolmentCode.code))).toBe(true);
    expect(codes.rows[0]).toMatchObject({
      id: added.enrolmentCode.id,
      reason: "added",
      issued_by: admin.staffId,
    });

    const events = await eventsAbout(added.staffId);
    expect(events.map((e) => e.event)).toEqual([
      "staff.member_added",
      "staff.enrolment_code_issued",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        actor_kind: "staff",
        actor_id: admin.staffId,
        actor_via: "admin",
        step_up_kind: "intent",
        db_login: "fin_admin_a",
      });
      expect(event.step_up_ref).toMatch(/^sti_/);
    }
    expect(events[0]?.metadata).toEqual({ roleKey: "viewer", reactivated: false });
    const context = await h.admin.query<{ client_ip: string; user_agent: string }>(
      "SELECT host(client_ip) AS client_ip, user_agent FROM audit.event_context WHERE event_id = $1",
      [events[0]?.id],
    );
    expect(context.rows[0]?.client_ip).toBe(canonicalIp(admin.browser.ip));
    expect(canonicalIp("2001:db8:0a1b::1")).toBe("2001:db8:a1b::1");
    expect(context.rows[0]?.user_agent).toBe(admin.browser.userAgent);

    const notices = (await h.outbox("staff/staff-access-changed")).filter(
      (n) => n.params.staffId === added.staffId,
    );
    expect(notices.map((n) => [n.recipient, n.params.audience]).sort()).toEqual(
      [
        [admin.email, "admins"],
        [email, "person"],
      ].sort(),
    );
    expect(JSON.stringify(await h.outbox())).not.toContain(added.enrolmentCode.code);
    expect(h.lines.named("staff.changed").at(-1)).toEqual({
      kind: "added",
      staffId: added.staffId,
      actorId: admin.staffId,
    });
  });

  it("refuses an active or pending member, and brings a removed one back under the same ID", async () => {
    const pending = unique("pending");
    await add(admin, pending, "viewer");
    const intents = await count("SELECT 1 FROM ops.step_up_intent WHERE principal_id = $1", [
      admin.staffId,
    ]);
    const again = await refusalOf(
      h.route(admin.browser, { method: "POST", path: "/api/staff" }, async (tx, req, ctx) =>
        addStaff(h.deps, tx, await requireStaff(h.realm, req, ctx, { permission: "staff.add" }), {
          email: pending.toUpperCase(),
          roleKey: "viewer",
        }),
      ),
    );
    expect(again.code).toBe("already_staff");
    // Refused before any factor was asked for (S2-31): no intent was made.
    expect(
      await count("SELECT 1 FROM ops.step_up_intent WHERE principal_id = $1", [admin.staffId]),
    ).toBe(intents);
    const self = await refusalOf(
      h.route(admin.browser, { method: "POST", path: "/api/staff" }, async (tx, req, ctx) =>
        addStaff(h.deps, tx, await requireStaff(h.realm, req, ctx, { permission: "staff.add" }), {
          email: admin.email,
          roleKey: "viewer",
        }),
      ),
    );
    expect(self.code).toBe("already_staff");

    const removedEmail = unique("returning");
    const removedId = await h.seedMember(removedEmail, "operator", "removed");
    const back = await add(admin, removedEmail, "viewer");
    expect(back.staffId).toBe(removedId);
    expect(back.reactivated).toBe(true);
    expect(await member(removedId)).toMatchObject({ status: "pending", role_key: "viewer" });
    const [event] = (await eventsAbout(removedId)).filter((e) => e.event === "staff.member_added");
    expect(event?.metadata).toEqual({ roleKey: "viewer", reactivated: true });
  });

  it("never gives a role the actor could not hold, nor the top role, nor one Fin does not know", async () => {
    const adders = await h.seedCustomRole("Staff adders", [
      "golive.read",
      "customers.read",
      "rfis.read",
      "organisations.read",
      "money.read",
      "audit.read",
      "staff.read",
      "staff.add",
    ]);
    const adder = await enrolled("adder", adders);
    const attempt = (roleKey: string) =>
      refusalOf(
        h.route(adder.browser, { method: "POST", path: "/api/staff" }, async (tx, req, ctx) =>
          addStaff(h.deps, tx, await requireStaff(h.realm, req, ctx, { permission: "staff.add" }), {
            email: unique("given"),
            roleKey,
          }),
        ),
      );
    expect(await attempt("admin")).toMatchObject({
      code: "giving_refused",
      extensions: { problem: "top_only" },
    });
    expect(await attempt("compliance")).toMatchObject({
      code: "giving_refused",
      extensions: { problem: "beyond" },
    });
    expect(await attempt("superuser")).toMatchObject({
      code: "giving_refused",
      extensions: { problem: "unknown_role" },
    });
    expect(await attempt("srl_01jd0000000000000000000000")).toMatchObject({
      code: "giving_refused",
      extensions: { problem: "gone" },
    });
    expect(
      await count("SELECT 1 FROM ops.step_up_intent WHERE principal_id = $1", [adder.staffId]),
    ).toBe(0);
    // A Viewer's permissions are within theirs, so a Viewer they may add.
    const viewer = await add(adder, unique("by.adder"), "viewer");
    expect(viewer.status).toBe("pending");
    // Without staff.add the route refuses before anything else.
    const plain = await enrolled("plain.viewer", "viewer");
    const forbidden = await refusalOf(
      h.route(plain.browser, { method: "POST", path: "/api/staff" }, async (tx, req, ctx) =>
        addStaff(h.deps, tx, await requireStaff(h.realm, req, ctx, { permission: "staff.add" }), {
          email: unique("x"),
          roleKey: "viewer",
        }),
      ),
    );
    expect(forbidden).toMatchObject({ code: "forbidden", extensions: { permission: "staff.add" } });
  });
});

describe("changing a role (§10.2, S2-20)", () => {
  it("ends the member's sessions, records the change, and journals a lowered role", async () => {
    const target = await enrolled("changing", "viewer");
    const up = await changeRole(admin, target.staffId, "compliance");
    expect(up).toMatchObject({ roleKey: "compliance", roleLabel: "Compliance", sessionsEnded: 1 });
    expect(await count("SELECT 1 FROM staff.session WHERE user_id = $1", [target.staffId])).toBe(0);
    const down = await changeRole(admin, target.staffId, "viewer");
    expect(down.roleKey).toBe("viewer");
    const changes = (await eventsAbout(target.staffId)).filter(
      (e) => e.event === "staff.role_changed",
    );
    expect(changes.map((e) => e.metadata)).toEqual([
      { fromRole: "viewer", toRole: "compliance", reason: "changed", lowered: false },
      { fromRole: "compliance", toRole: "viewer", reason: "changed", lowered: true },
    ]);
    const journal = await h.admin.query<{ kind: string; audit_event_id: string }>(
      "SELECT kind, audit_event_id FROM audit.journal_entry WHERE $1 = ANY (subject_ids) ORDER BY recorded_at",
      [target.staffId],
    );
    expect(journal.rows).toEqual([{ kind: "staff_role_lowered", audit_event_id: changes[1]?.id }]);
    const notices = (await h.outbox("staff/staff-access-changed")).filter(
      (n) => n.params.staffId === target.staffId && n.params.kind === "role_changed",
    );
    expect(notices).toHaveLength(4);
  });

  it("refuses one's own role, the same role, a gone role, and anyone without staff.role", async () => {
    const target = await enrolled("unchanged", "viewer");
    const attempt = (who: Member, staffId: string, roleKey: string) =>
      refusalOf(
        h.route(
          who.browser,
          { method: "PATCH", path: `/api/staff/${staffId}` },
          async (tx, req, ctx) =>
            changeStaffRole(
              h.deps,
              tx,
              await requireStaff(h.realm, req, ctx, { permission: "staff.role" }),
              staffId,
              {
                roleKey,
              },
            ),
        ),
      );
    expect(await attempt(admin, admin.staffId, "viewer")).toMatchObject({
      code: "giving_refused",
      extensions: { problem: "self" },
    });
    expect(await attempt(admin, target.staffId, "viewer")).toMatchObject({
      code: "giving_refused",
      extensions: { problem: "unchanged" },
    });
    expect(await attempt(admin, target.staffId, "srl_01jd0000000000000000000000")).toMatchObject({
      extensions: { problem: "gone" },
    });
    expect(await attempt(admin, "stf_01jd0000000000000000000000", "viewer")).toMatchObject({
      code: "not_found",
    });
    const operator = await enrolled("operator", "operator");
    expect(await attempt(operator, target.staffId, "compliance")).toMatchObject({
      code: "forbidden",
      extensions: { permission: "staff.role" },
    });
  });
});

describe("removing staff (§10.2, [SA-32])", () => {
  it("removes the member and everything they signed in with, in one transaction", async () => {
    const target = await enrolled("removed", "viewer");
    const extra = await h.issueCode(target.staffId);
    expect(extra).toBeTruthy();
    const removed = await remove(admin, target.staffId);
    expect(removed).toMatchObject({ status: "removed", sessionsEnded: 1, factorsRemoved: 1 });
    expect(await member(target.staffId)).toMatchObject({ status: "removed" });
    expect(await count("SELECT 1 FROM staff.passkey WHERE user_id = $1", [target.staffId])).toBe(0);
    expect(await count("SELECT 1 FROM staff.session WHERE user_id = $1", [target.staffId])).toBe(0);
    expect(
      await count(
        "SELECT 1 FROM staff.enrolment_code WHERE member_id = $1 AND voided_at IS NULL AND redeemed_at IS NULL",
        [target.staffId],
      ),
    ).toBe(0);
    const [event] = (await eventsAbout(target.staffId)).filter(
      (e) => e.event === "staff.member_removed",
    );
    expect(event?.metadata).toEqual({ sessionsEnded: 1, factorsRemoved: 1 });
    const journal = await h.admin.query<{ kind: string }>(
      "SELECT kind FROM audit.journal_entry WHERE audit_event_id = $1",
      [event?.id],
    );
    expect(journal.rows).toEqual([{ kind: "staff_removed" }]);
    const notices = (await h.outbox("staff/staff-access-changed")).filter(
      (n) => n.params.staffId === target.staffId && n.params.kind === "removed",
    );
    expect(notices.map((n) => n.recipient).sort()).toEqual([admin.email, target.email].sort());
    // The removed member's own session no longer reaches anything.
    const gone = await refusalOf(
      h.route(target.browser, { method: "GET", path: "/api/viewer" }, async (_tx, req, ctx) =>
        requireStaff(h.realm, req, ctx),
      ),
    );
    expect(gone.code).toBe("unauthenticated");
  });

  it("refuses oneself and anyone whose role holds more than the actor's", async () => {
    const removers = await h.seedCustomRole("Staff removers", [
      "golive.read",
      "customers.read",
      "rfis.read",
      "organisations.read",
      "money.read",
      "audit.read",
      "staff.read",
      "staff.remove",
    ]);
    const remover = await enrolled("remover", removers);
    const attempt = (staffId: string) =>
      refusalOf(
        h.route(
          remover.browser,
          { method: "POST", path: `/api/staff/${staffId}/remove` },
          async (tx, req, ctx) =>
            removeStaff(
              h.deps,
              tx,
              await requireStaff(h.realm, req, ctx, { permission: "staff.remove" }),
              staffId,
            ),
        ),
      );
    expect(await attempt(admin.staffId)).toMatchObject({ code: "outranked" });
    expect(await attempt(remover.staffId)).toMatchObject({
      code: "giving_refused",
      extensions: { problem: "self" },
    });
    const compliance = await enrolled("compliance", "compliance");
    expect(await attempt(compliance.staffId)).toMatchObject({ code: "outranked" });
    expect(await member(admin.staffId)).toMatchObject({ status: "active" });
    // A Viewer is within the remover's permissions.
    const viewer = await enrolled("removable", "viewer");
    expect(await remove(remover, viewer.staffId)).toMatchObject({ status: "removed" });
  });
});

describe("resetting second factors (§10.2, [SA-14]) and new codes", () => {
  it("puts the member back to pending with a new code, once", async () => {
    const target = await enrolled("reset", "compliance");
    const done = await reset(admin, target.staffId);
    expect(done.status).toBe("pending");
    expect(done.enrolmentCode.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(await member(target.staffId)).toMatchObject({
      status: "pending",
      role_key: "compliance",
    });
    expect(await count("SELECT 1 FROM staff.passkey WHERE user_id = $1", [target.staffId])).toBe(0);
    expect(await count("SELECT 1 FROM staff.session WHERE user_id = $1", [target.staffId])).toBe(0);
    const events = (await eventsAbout(target.staffId)).filter((e) => e.actor_id === admin.staffId);
    expect(events.map((e) => e.event)).toEqual([
      "staff.factors_reset",
      "staff.enrolment_code_issued",
    ]);
    expect(events[0]?.metadata).toEqual({ sessionsEnded: 1, factorsRemoved: 1 });
    expect(events[1]?.metadata).toEqual({ reason: "reset" });
    const journal = await h.admin.query<{ kind: string }>(
      "SELECT kind FROM audit.journal_entry WHERE audit_event_id = $1",
      [events[0]?.id],
    );
    expect(journal.rows).toEqual([{ kind: "staff_factors_reset" }]);
    const notices = (await h.outbox("staff/staff-factors-reset")).filter(
      (n) => n.params.staffId === target.staffId,
    );
    expect(notices.map((n) => [n.recipient, n.params.audience]).sort()).toEqual(
      [
        [admin.email, "admins"],
        [target.email, "person"],
      ].sort(),
    );

    // A pending member's new code voids the live one; an active member gets none.
    const again = await reissue(admin, target.staffId);
    expect(again.enrolmentCode.id).not.toBe(done.enrolmentCode.id);
    const live = await h.admin.query<{ id: string }>(
      "SELECT id FROM staff.enrolment_code WHERE member_id = $1 AND voided_at IS NULL AND redeemed_at IS NULL",
      [target.staffId],
    );
    expect(live.rows.map((r) => r.id)).toEqual([again.enrolmentCode.id]);
    const active = await enrolled("active.member", "viewer");
    const notPending = await refusalOf(
      h.route(
        admin.browser,
        { method: "POST", path: `/api/staff/${active.staffId}/enrolment-code` },
        async (tx, req, ctx) =>
          newEnrolmentCode(
            h.deps,
            tx,
            await requireStaff(h.realm, req, ctx, { permission: "staff.add" }),
            active.staffId,
          ),
      ),
    );
    expect(notPending).toMatchObject({ code: "conflict", extensions: { reason: "not_pending" } });
  });

  it("is the Admin's alone", async () => {
    const operator = await enrolled("operator.reset", "operator");
    const target = await enrolled("reset.target", "viewer");
    const refused = await refusalOf(
      h.route(
        operator.browser,
        { method: "POST", path: `/api/staff/${target.staffId}/reset-factors` },
        async (tx, req, ctx) =>
          resetStaffFactors(
            h.deps,
            tx,
            await requireStaff(h.realm, req, ctx, { permission: "staff.reset_factors" }),
            target.staffId,
          ),
      ),
    );
    expect(refused).toMatchObject({
      code: "forbidden",
      extensions: { permission: "staff.reset_factors" },
    });
  });
});

describe("what a failure leaves (§16.1, §17.1)", () => {
  it("an intent for another action changes nothing and writes no event", async () => {
    const target = await enrolled("protected", "viewer");
    let intent = "";
    try {
      await h.route(
        admin.browser,
        { method: "POST", path: `/api/staff/${target.staffId}/reset-factors` },
        async (tx, req, ctx) =>
          resetStaffFactors(
            h.deps,
            tx,
            await requireStaff(h.realm, req, ctx, { permission: "staff.reset_factors" }),
            target.staffId,
          ),
      );
    } catch (error) {
      intent = String((error as { extensions: { intent_id: string } }).extensions.intent_id);
    }
    expect((await h.prove(admin.browser, admin.authenticator, intent)).status).toBe(200);
    const before = (await eventsAbout(target.staffId)).length;
    const wrong = await refusalOf(
      h.route(
        admin.browser,
        { method: "POST", path: `/api/staff/${target.staffId}/remove`, intent },
        async (tx, req, ctx) =>
          removeStaff(
            h.deps,
            tx,
            await requireStaff(h.realm, req, ctx, { permission: "staff.remove" }),
            target.staffId,
          ),
      ),
    );
    expect(wrong).toMatchObject({
      code: "step_up_invalid",
      extensions: { reason: "other_action" },
    });
    expect(await member(target.staffId)).toMatchObject({ status: "active" });
    expect((await eventsAbout(target.staffId)).length).toBe(before);
  });

  it("an action whose notice cannot be queued rolls back whole, its intent unspent", async () => {
    await h.admin.query(
      "DELETE FROM email.template_grant WHERE template = 'staff/staff-access-changed'",
    );
    try {
      const email = unique("unnoticed");
      const before = await count("SELECT 1 FROM audit.event WHERE event LIKE 'staff.%'");
      await expect(add(admin, email, "viewer")).rejects.toThrow();
      expect(await count("SELECT 1 FROM staff.member WHERE email = $1", [email])).toBe(0);
      // The ceremony's own event stays (it proved the intent); the action's never committed.
      const after = await h.admin.query<{ event: string }>(
        "SELECT event FROM audit.event WHERE event LIKE 'staff.%' ORDER BY recorded_at, id OFFSET $1",
        [before],
      );
      expect(after.rows.map((r) => r.event)).toEqual(["staff.step_up_passed"]);
      expect(
        await count(
          "SELECT 1 FROM ops.step_up_intent WHERE principal_id = $1 AND action = 'staff.add' AND proved_at IS NOT NULL AND consumed_at IS NULL",
          [admin.staffId],
        ),
      ).toBe(1);
      expect(h.lines.named("email.security_unsent").at(-1)).toEqual({
        template: "staff/staff-access-changed",
        reason: "not_allowed",
      });
    } finally {
      await h.admin.query(
        "INSERT INTO email.template_grant (template, role, category) VALUES ('staff/staff-access-changed', 'fin_admin', 'security')",
      );
    }
  });
});
