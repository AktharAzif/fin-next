// Invitations (spec 02 §9.3; T-SAT-25, AC-SAT-07): bound to the address, alive 7 days, used once; an
// unknown and an expired token get the same answer; changing the role and resending take intents and
// issue new tokens, so an old link stops working; an inviter who is demoted or removed has their
// invitations withdrawn; the giving and outrank rules hold.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, DROP_TIMEOUT_MS, seed, type TestDatabase } from "../test/db.ts";
import {
  acceptAs,
  asActor,
  asPerson,
  changeRoleAs,
  codeOf,
  createHarness,
  extensionsOf,
  type Harness,
  inviteAs,
  memberOf,
  ownerWithOrganization,
  person,
  removeAs,
  roleAs,
  unique,
  withIntent,
} from "../test/harness.ts";
import {
  acceptInvitation,
  cancelInvitation,
  changeInvitation,
  declineInvitation,
  invitationFromCookie,
  inviteMember,
  myInvitations,
  openInvitation,
  resendInvitation,
} from "./invitations.ts";

let database: TestDatabase;
let h: Harness;

beforeAll(async () => {
  database = await createTestDatabase("invitations");
  h = await createHarness(database);
});

afterAll(async () => {
  await database?.drop();
}, DROP_TIMEOUT_MS);

const INVITE = { permission: "member.invite", lock: true } as const;

async function open(token: string) {
  return h.realm.run(h.browser().context(), (tx) => openInvitation(h.orgs, tx, token, null));
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return String((error as { code?: string }).code);
  }
}

describe("an invitation", () => {
  it("is made with an intent, emailed with its token, and opened to the same answer for every unusable token", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner");
    const email = unique("invitee");
    const invited = await inviteAs(h, who, orgId, email, "admin");
    expect(invited.ok).toBe(true);
    const id = invited.ok ? invited.value.invitationId : "";
    const event = (await h.events({ event: "member.invited", organizationId: orgId }))[0];
    expect(event).toMatchObject({ target_id: id, metadata: { roleKey: "admin" } });
    expect(event?.step_up_ref).toMatch(/^sti_/);
    const token = (await h.invitationToken(email)) as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await h.admin.query<{ token_hash: Buffer }>(
      "SELECT token_hash FROM identity.invitation WHERE id = $1",
      [id],
    );
    expect(stored.rows[0]?.token_hash.toString("base64url")).not.toBe(token);

    const opened = await open(token);
    expect(opened.view).toMatchObject({
      invitationId: id,
      roleLabel: "Admin",
      state: "signed_out",
    });
    // The cookie names the invitation and survives the sign-in round trip.
    const viaCookie = await h.realm.run(h.browser().context(), (tx) =>
      invitationFromCookie(h.orgs, tx, opened.cookie, { email }),
    );
    expect(viaCookie).toMatchObject({ invitationId: id, state: "for_you" });
    expect(
      await refusalOf(
        h.realm.run(h.browser().context(), (tx) =>
          invitationFromCookie(h.orgs, tx, `${opened.cookie.slice(0, -2)}xx`, null),
        ),
      ),
    ).toBe("invitation_unusable");

    // Unknown, expired: the same refusal.
    expect(await refusalOf(open("A".repeat(43)))).toBe("invitation_unusable");
    await seed(
      h.admin,
      "UPDATE identity.invitation SET expires_at = now() - interval '1 second', created_at = now() - interval '8 days' WHERE id = $1",
      [id],
    );
    expect(await refusalOf(open(token))).toBe("invitation_unusable");
  });

  it("is accepted once, only by the account with its exact address", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_accept");
    const email = unique("right");
    const invited = await inviteAs(h, who, orgId, email, "admin");
    const id = invited.ok ? invited.value.invitationId : "";
    const stranger = await person(h, "stranger");
    expect(codeOf(await acceptAs(h, stranger, id))).toBe("invitation_unusable");
    const invitee = await person(h, "right", { email });
    const mine = await asPerson(
      h,
      invitee,
      { method: "GET" },
      { stepUp: { kind: "none" } },
      (tx, g) => myInvitations(h.orgs, tx, g),
    );
    expect(mine.ok && mine.value.map((i) => i.invitationId)).toEqual([id]);
    // The invitee has a factor, so accepting takes an intent.
    const asked = await asPerson(
      h,
      invitee,
      {},
      { stepUp: { kind: "intent_if_factor", action: "invitation.accept" } },
      (tx, g) => acceptInvitation(h.orgs, tx, g, id),
    );
    expect(codeOf(asked)).toBe("step_up_required");
    const joined = await acceptAs(h, invitee, id);
    expect(joined.ok).toBe(true);
    const event = (await h.events({ event: "member.joined", organizationId: orgId }))[0];
    expect(event?.ref_ids).toEqual(expect.arrayContaining([id, invitee.userId]));
    expect(codeOf(await acceptAs(h, invitee, id))).toBe("invitation_unusable");
    const mail = await h.outbox(who.email);
    expect(mail.some((m) => m.template === "orgs/member-joined")).toBe(true);
  });

  it("refuses an existing member, replaces a pending one for the address, and is declined by its invitee", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_replace");
    expect(codeOf(await inviteAs(h, who, orgId, who.email, "admin"))).toBe("already_member");
    const email = unique("twice");
    const first = await inviteAs(h, who, orgId, email, "admin");
    const second = await inviteAs(h, who, orgId, email, "admin");
    expect(first.ok && second.ok).toBe(true);
    const firstId = first.ok ? first.value.invitationId : "";
    const replaced = await h.admin.query<{ status: string; cancel_reason: string }>(
      "SELECT status, cancel_reason FROM identity.invitation WHERE id = $1",
      [firstId],
    );
    expect(replaced.rows[0]).toEqual({ status: "cancelled", cancel_reason: "replaced" });
    const invitee = await person(h, "twice", { email, factor: false });
    const secondId = second.ok ? second.value.invitationId : "";
    const declined = await asPerson(h, invitee, {}, { stepUp: { kind: "none" } }, (tx, g) =>
      declineInvitation(h.orgs, tx, g, secondId),
    );
    expect(declined.ok).toBe(true);
    const event = (
      await h.events({ event: "member.invitation_declined", organizationId: orgId })
    )[0];
    expect(event?.target_id).toBe(secondId);
  });

  it("changes its role and is resent only with intents, each with a new token, the old link dead", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_change");
    const email = unique("changed");
    const invited = await inviteAs(h, who, orgId, email, "admin");
    const id = invited.ok ? invited.value.invitationId : "";
    const firstToken = (await h.invitationToken(email)) as string;
    const change = (headers: Record<string, string>) =>
      asActor(
        h,
        who,
        orgId,
        { method: "PATCH", body: { roleKey: "super_admin" }, headers },
        { ...INVITE, stepUp: { kind: "intent", action: "invitation.change" } },
        (tx, a) => changeInvitation(h.orgs, tx, a, id, { roleKey: "super_admin" }),
      );
    expect(codeOf(await change({}))).toBe("step_up_required");
    expect((await withIntent(h, who, change)).ok).toBe(true);
    const secondToken = (await h.invitationToken(email)) as string;
    expect(secondToken).not.toBe(firstToken);
    expect(await refusalOf(open(firstToken))).toBe("invitation_unusable");
    expect((await open(secondToken)).view.roleLabel).toBe("Super admin");
    const changed = (
      await h.events({ event: "member.invitation_changed", organizationId: orgId })
    )[0];
    expect(changed?.metadata).toEqual({
      fromRole: "admin",
      toRole: "super_admin",
      reason: "edited",
    });

    const resend = (headers: Record<string, string>) =>
      asActor(
        h,
        who,
        orgId,
        { headers },
        { ...INVITE, stepUp: { kind: "intent", action: "invitation.resend" } },
        (tx, a) => resendInvitation(h.orgs, tx, a, id),
      );
    expect(codeOf(await resend({}))).toBe("step_up_required");
    expect((await withIntent(h, who, resend)).ok).toBe(true);
    const thirdToken = (await h.invitationToken(email)) as string;
    expect(thirdToken).not.toBe(secondToken);
    expect(await refusalOf(open(secondToken))).toBe("invitation_unusable");
    expect(
      await h.events({ event: "member.invitation_resent", organizationId: orgId }),
    ).toHaveLength(1);
  });

  it("is outranked: an Admin may neither offer nor cancel the Super admin role", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_outrank");
    const admin = await memberOf(h, who, orgId, "admin", "admin");
    const offered = await inviteAs(h, admin.who, orgId, unique("top"), "super_admin");
    expect(codeOf(offered)).toBe("giving_refused");
    expect(extensionsOf(offered)).toMatchObject({ problem: "top_only" });
    const ownerOffer = await inviteAs(h, who, orgId, unique("top2"), "super_admin");
    const id = ownerOffer.ok ? ownerOffer.value.invitationId : "";
    const cancel = await withIntent(h, admin.who, (headers) =>
      asActor(
        h,
        admin.who,
        orgId,
        { method: "DELETE", headers },
        { ...INVITE, stepUp: { kind: "intent", action: "invitation.cancel" } },
        (tx, a) => cancelInvitation(h.orgs, tx, a, id),
      ),
    );
    expect(codeOf(cancel)).toBe("outranked");
    const byOwner = await withIntent(h, who, (headers) =>
      asActor(
        h,
        who,
        orgId,
        { method: "DELETE", headers },
        { ...INVITE, stepUp: { kind: "intent", action: "invitation.cancel" } },
        (tx, a) => cancelInvitation(h.orgs, tx, a, id),
      ),
    );
    expect(byOwner.ok).toBe(true);
    const event = (
      await h.events({ event: "member.invitation_cancelled", organizationId: orgId })
    ).at(-1);
    expect(event?.metadata).toEqual({ reason: "cancelled" });
  });

  // Genuinely heavy, so a timeout of its own: a custom role and two members, each invited with a
  // proof, signed in, given an authenticator and accepted with a proof, then four invitations with
  // proofs. Alone it takes 1.0 to 1.5 s; in the full db run on 4 CPUs, 2.4 to 4.3 s.
  it("is replaced only by someone it does not outrank (§8.5, as a cancellation)", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_replace_rank");
    const inviters = await roleAs(h, who, orgId, "Inviters", ["member.read", "member.invite"]);
    const low = await memberOf(h, who, orgId, "low_inviter", inviters);
    const admin = await memberOf(h, who, orgId, "replace_admin", "admin");
    const email = unique("victim");
    const top = await inviteAs(h, who, orgId, email, "super_admin");
    const topId = top.ok ? top.value.invitationId : "";
    const statusOf = async (id: string) =>
      (
        await h.admin.query<{ status: string }>(
          "SELECT status FROM identity.invitation WHERE id = $1",
          [id],
        )
      ).rows[0]?.status;
    // Neither a member.invite-only role nor an Admin may replace a Super admin invitation, and
    // neither is asked for a factor first (S2-31).
    for (const actor of [low.who, admin.who]) {
      const asked = await asActor(
        h,
        actor,
        orgId,
        { body: { email, roleKey: inviters } },
        { ...INVITE, stepUp: { kind: "intent", action: "member.invite" } },
        (tx, a) => inviteMember(h.orgs, tx, a, { email, roleKey: inviters }),
      );
      expect(codeOf(asked)).toBe("outranked");
    }
    expect(await statusOf(topId)).toBe("pending");
    const cancelled = await h.events({
      event: "member.invitation_cancelled",
      organizationId: orgId,
    });
    expect(cancelled.filter((e) => e.target_id === topId)).toEqual([]);
    // An invitation within the actor's permissions is replaced as before, the same role included.
    const own = await inviteAs(h, low.who, orgId, unique("own"), inviters);
    const ownId = own.ok ? own.value.invitationId : "";
    const ownEmail = (
      await h.admin.query<{ email: string }>(
        "SELECT email FROM identity.invitation WHERE id = $1",
        [ownId],
      )
    ).rows[0]?.email as string;
    expect((await inviteAs(h, low.who, orgId, ownEmail, inviters)).ok).toBe(true);
    expect(await statusOf(ownId)).toBe("cancelled");
    // The Super admin may replace it.
    expect((await inviteAs(h, who, orgId, email, "admin")).ok).toBe(true);
    expect(await statusOf(topId)).toBe("cancelled");
  }, 20_000);

  // Genuinely heavy, so a timeout of its own: a member invited, signed in, given an authenticator
  // and accepted, an invitation and its change, then the invitee signed in, given an authenticator
  // and accepting, each step with a proof. Alone it takes up to 1.1 s; in the full db run on 4
  // CPUs, up to 2.6 s.
  it("is accepted after another member changed its role, under the member who changed it", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_changer");
    const admin = await memberOf(h, who, orgId, "first_inviter", "admin");
    const email = unique("raised");
    const sent = await inviteAs(h, admin.who, orgId, email, "admin");
    const id = sent.ok ? sent.value.invitationId : "";
    const changed = await withIntent(h, who, (headers) =>
      asActor(
        h,
        who,
        orgId,
        { method: "PATCH", body: { roleKey: "super_admin" }, headers },
        { ...INVITE, stepUp: { kind: "intent", action: "invitation.change" } },
        (tx, a) => changeInvitation(h.orgs, tx, a, id, { roleKey: "super_admin" }),
      ),
    );
    expect(changed.ok).toBe(true);
    const row = await h.admin.query<{ invited_by: string }>(
      "SELECT invited_by FROM identity.invitation WHERE id = $1",
      [id],
    );
    expect(row.rows[0]?.invited_by).toBe(who.userId);
    const event = (
      await h.events({ event: "member.invitation_changed", organizationId: orgId })
    ).at(-1);
    expect(event?.ref_ids).toEqual(expect.arrayContaining([admin.who.userId]));
    const invitee = await person(h, "raised", { email });
    const joined = await acceptAs(h, invitee, id);
    expect(codeOf(joined)).toBe("ok");
    expect(joined.ok && joined.value.roleKey).toBe("super_admin");
    const member = await h.admin.query<{ invited_by: string }>(
      "SELECT invited_by FROM identity.member WHERE organization_id = $1 AND user_id = $2",
      [orgId, invitee.userId],
    );
    expect(member.rows[0]?.invited_by).toBe(who.userId);
  }, 20_000);

  // Genuinely heavy, so a timeout of its own: two members, each invited, signed in, given an
  // authenticator and accepted, two invitations, a custom role, a demotion and a removal, each with
  // a proof. Alone it takes 0.9 to 1.3 s; in the full db run on 4 CPUs, 2.2 to 3.8 s.
  it("is withdrawn when its inviter is demoted below it, or removed", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_withdraw");
    const admin = await memberOf(h, who, orgId, "inviter", "admin");
    const sent = await inviteAs(h, admin.who, orgId, unique("pending"), "admin");
    const sentId = sent.ok ? sent.value.invitationId : "";
    // Demoted to a role that can no longer invite: the invitation goes (inviter_demoted).
    const readers = await roleAs(h, who, orgId, "Readers", ["member.read"]);
    expect((await changeRoleAs(h, who, orgId, admin.memberId, readers)).ok).toBe(true);
    const demoted = await h.admin.query<{ status: string; cancel_reason: string }>(
      "SELECT status, cancel_reason FROM identity.invitation WHERE id = $1",
      [sentId],
    );
    expect(demoted.rows[0]).toEqual({ status: "cancelled", cancel_reason: "inviter_demoted" });

    const second = await memberOf(h, who, orgId, "inviter2", "admin");
    const again = await inviteAs(h, second.who, orgId, unique("pending2"), "admin");
    const againId = again.ok ? again.value.invitationId : "";
    expect((await removeAs(h, who, orgId, second.memberId)).ok).toBe(true);
    const removed = await h.admin.query<{ status: string; cancel_reason: string }>(
      "SELECT status, cancel_reason FROM identity.invitation WHERE id = $1",
      [againId],
    );
    expect(removed.rows[0]).toEqual({ status: "cancelled", cancel_reason: "inviter_removed" });
    const reasons = (
      await h.events({ event: "member.invitation_cancelled", organizationId: orgId })
    ).map((e) => e.metadata.reason);
    expect(reasons).toEqual(expect.arrayContaining(["inviter_demoted", "inviter_removed"]));
  }, 20_000);

  it("allows at most 25 pending per organisation", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_limit");
    for (let i = 0; i < 25; i += 1) {
      await seed(
        h.admin,
        `INSERT INTO identity.invitation (id, organization_id, email, role_key, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, 'admin', decode(md5($3) || md5($3 || 'x'), 'hex'), $4, now() + interval '7 days')`,
        [
          `inv_01jd00000000000000000000${String(i).padStart(2, "0")}`.slice(0, 30),
          orgId,
          unique(`p${i}`),
          who.userId,
        ],
      );
    }
    const refused = await inviteAs(h, who, orgId, unique("26th"), "admin");
    expect(codeOf(refused)).toBe("limit_reached");
    expect(extensionsOf(refused)).toMatchObject({ limit: 25 });
  });
});
