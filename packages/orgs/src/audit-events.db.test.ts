// Every organisation-scope event (spec 02 §16.3; T-SAT-22, AC-SAT-11): written by its action, in the
// action's transaction, and only then; a rolled-back action leaves none; and a meta-test fails when
// an event of the fragment has no case here (the realm-written ones are listed apart).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/db.ts";
import {
  asActor,
  asPerson,
  changeRoleAs,
  codeOf,
  createHarness,
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
import { ORGS_EVENTS, type OrgsEventName, REALM_WRITTEN_EVENTS } from "./audit/events.ts";
import { deleteRole, updateRole } from "./custom-roles.ts";
import {
  cancelInvitation,
  changeInvitation,
  declineInvitation,
  resendInvitation,
} from "./invitations.ts";
import { deleteOrganization, renameOrganization } from "./organizations.ts";

let database: TestDatabase;
let h: Harness;

beforeAll(async () => {
  database = await createTestDatabase("audit_events");
  h = await createHarness(database);
});

afterAll(async () => {
  await database?.drop();
});

const INVITE = { permission: "member.invite", lock: true } as const;
const MANAGE = { permission: "role.manage", lock: true } as const;

/** Runs the case and answers the organisation its event belongs to. */
type Case = () => Promise<string>;

const CASES: Record<Exclude<OrgsEventName, (typeof REALM_WRITTEN_EVENTS)[number]>, Case> = {
  "organization.created": async () => (await ownerWithOrganization(h, "created")).orgId,
  "organization.updated": async () => {
    const { who, orgId } = await ownerWithOrganization(h, "updated");
    const out = await withIntent(h, who, (headers) =>
      asActor(
        h,
        who,
        orgId,
        { method: "PATCH", body: { name: "New Name" }, headers },
        {
          permission: "organization.update",
          lock: true,
          stepUp: { kind: "intent", action: "org.rename" },
        },
        (tx, a) => renameOrganization(h.orgs, tx, a, { name: "New Name" }),
      ),
    );
    if (!out.ok) throw out.error;
    return orgId;
  },
  "organization.deleted": async () => {
    const { who, orgId, name } = await ownerWithOrganization(h, "deleted");
    const out = await withIntent(h, who, (headers) =>
      asActor(
        h,
        who,
        orgId,
        { method: "DELETE", body: { confirmName: name }, headers },
        {
          permission: "organization.delete",
          lock: true,
          stepUp: { kind: "intent", action: "org.delete" },
        },
        (tx, a) => deleteOrganization(h.orgs, tx, a, { confirmName: name }),
      ),
    );
    if (!out.ok) throw out.error;
    return orgId;
  },
  "member.invited": async () => {
    const { who, orgId } = await ownerWithOrganization(h, "invited");
    const out = await inviteAs(h, who, orgId, unique("i"), "admin");
    if (!out.ok) throw out.error;
    return orgId;
  },
  "member.invitation_changed": async () => {
    const { who, orgId } = await ownerWithOrganization(h, "inv_changed");
    const sent = await inviteAs(h, who, orgId, unique("i"), "admin");
    const id = sent.ok ? sent.value.invitationId : "";
    const out = await withIntent(h, who, (headers) =>
      asActor(
        h,
        who,
        orgId,
        { method: "PATCH", body: { roleKey: "super_admin" }, headers },
        { ...INVITE, stepUp: { kind: "intent", action: "invitation.change" } },
        (tx, a) => changeInvitation(h.orgs, tx, a, id, { roleKey: "super_admin" }),
      ),
    );
    if (!out.ok) throw out.error;
    return orgId;
  },
  "member.invitation_resent": async () => {
    const { who, orgId } = await ownerWithOrganization(h, "inv_resent");
    const sent = await inviteAs(h, who, orgId, unique("i"), "admin");
    const id = sent.ok ? sent.value.invitationId : "";
    const out = await withIntent(h, who, (headers) =>
      asActor(
        h,
        who,
        orgId,
        { headers },
        { ...INVITE, stepUp: { kind: "intent", action: "invitation.resend" } },
        (tx, a) => resendInvitation(h.orgs, tx, a, id),
      ),
    );
    if (!out.ok) throw out.error;
    return orgId;
  },
  "member.invitation_cancelled": async () => {
    const { who, orgId } = await ownerWithOrganization(h, "inv_cancelled");
    const sent = await inviteAs(h, who, orgId, unique("i"), "admin");
    const id = sent.ok ? sent.value.invitationId : "";
    const out = await withIntent(h, who, (headers) =>
      asActor(
        h,
        who,
        orgId,
        { method: "DELETE", headers },
        { ...INVITE, stepUp: { kind: "intent", action: "invitation.cancel" } },
        (tx, a) => cancelInvitation(h.orgs, tx, a, id),
      ),
    );
    if (!out.ok) throw out.error;
    return orgId;
  },
  "member.invitation_declined": async () => {
    const { who, orgId } = await ownerWithOrganization(h, "inv_declined");
    const email = unique("decliner");
    const sent = await inviteAs(h, who, orgId, email, "admin");
    const id = sent.ok ? sent.value.invitationId : "";
    const invitee = await person(h, "decliner", { email, factor: false });
    const out = await asPerson(h, invitee, {}, { stepUp: { kind: "none" } }, (tx, g) =>
      declineInvitation(h.orgs, tx, g, id),
    );
    if (!out.ok) throw out.error;
    return orgId;
  },
  "member.joined": async () => {
    const { who, orgId } = await ownerWithOrganization(h, "joined");
    await memberOf(h, who, orgId, "joiner", "admin");
    return orgId;
  },
  "member.role_changed": async () => {
    const { who, orgId } = await ownerWithOrganization(h, "role_changed");
    const admin = await memberOf(h, who, orgId, "changed", "admin");
    const out = await changeRoleAs(h, who, orgId, admin.memberId, "super_admin");
    if (!out.ok) throw out.error;
    return orgId;
  },
  "member.removed": async () => {
    const { who, orgId } = await ownerWithOrganization(h, "removed");
    const admin = await memberOf(h, who, orgId, "leaver", "admin");
    const out = await removeAs(h, who, orgId, admin.memberId);
    if (!out.ok) throw out.error;
    return orgId;
  },
  "member.name_changed": async () => {
    const { who, orgId } = await ownerWithOrganization(h, "name_changed");
    // The console's PATCH /api/account/name writes it, one per membership (§16.3); its own test is
    // apps/console/src/server/account.db.test.ts. Here: the event is recordable by fin_console.
    const out = await asPerson(
      h,
      who,
      { method: "PATCH" },
      { stepUp: { kind: "none" } },
      async (tx, g) =>
        h.orgs.audit(tx, {
          event: "member.name_changed",
          actor: g.actor,
          target: (
            await tx.query<{ id: string }>("SELECT id FROM identity.member WHERE user_id = $1", [
              g.person.id,
            ])
          ).rows[0]?.id as string,
          refs: [g.person.id],
          organizationId: orgId,
          metadata: {},
          context: g.context,
        }),
    );
    if (!out.ok) throw out.error;
    return orgId;
  },
  "role.created": async () => {
    const { who, orgId } = await ownerWithOrganization(h, "role_created");
    await roleAs(h, who, orgId, "Support", ["member.read"]);
    return orgId;
  },
  "role.updated": async () => {
    const { who, orgId } = await ownerWithOrganization(h, "role_updated");
    const roleId = await roleAs(h, who, orgId, "Support", ["member.read"]);
    const body = {
      name: "Support",
      description: "",
      permissions: ["member.read", "auditLog.read"],
      version: 1,
    };
    const out = await withIntent(h, who, (headers) =>
      asActor(
        h,
        who,
        orgId,
        { method: "PUT", body, headers },
        { ...MANAGE, stepUp: { kind: "intent", action: "role.update" } },
        (tx, a) => updateRole(h.orgs, tx, a, roleId, body),
      ),
    );
    if (!out.ok) throw out.error;
    return orgId;
  },
  "role.deleted": async () => {
    const { who, orgId } = await ownerWithOrganization(h, "role_deleted");
    const roleId = await roleAs(h, who, orgId, "Support", ["member.read"]);
    const out = await withIntent(h, who, (headers) =>
      asActor(
        h,
        who,
        orgId,
        { body: {}, headers },
        { ...MANAGE, stepUp: { kind: "intent", action: "role.delete" } },
        (tx, a) => deleteRole(h.orgs, tx, a, roleId, {}),
      ),
    );
    if (!out.ok) throw out.error;
    return orgId;
  },
};

describe("the organisation-scope events", () => {
  it("each have a case, but the ones the realm's hooks write", () => {
    const written = new Set<string>(REALM_WRITTEN_EVENTS);
    const expected = Object.keys(ORGS_EVENTS)
      .filter((e) => !written.has(e))
      .sort();
    expect(Object.keys(CASES).sort()).toEqual(expected);
  });

  for (const [event, run] of Object.entries(CASES) as [string, Case][]) {
    it(`${event} is written by its action, in its organisation, with the request's context`, async () => {
      const orgId = await run();
      const rows = await h.events({ event, organizationId: orgId });
      expect(rows.length, event).toBeGreaterThanOrEqual(1);
      const context = await h.admin.query<{ client_ip: string | null; user_agent: string | null }>(
        "SELECT host(client_ip) AS client_ip, user_agent FROM audit.event_context WHERE event_id = $1",
        [rows.at(-1)?.id],
      );
      expect(context.rows[0]?.client_ip, event).toMatch(/^2001:db8:/);
      expect(context.rows[0]?.user_agent, event).toContain("Chrome");
    });
  }
});

describe("a rolled-back action", () => {
  it("leaves no event: a removal whose notice cannot be queued keeps the member and writes nothing", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "rollback");
    const admin = await memberOf(h, who, orgId, "kept", "admin");
    const before = (await h.events({ organizationId: orgId })).length;
    const grant = await h.admin.query<{ role: string; category: string }>(
      "DELETE FROM email.template_grant WHERE template = 'orgs/member-removed' RETURNING role, category",
    );
    try {
      const out = await removeAs(h, who, orgId, admin.memberId);
      expect(out.ok).toBe(false);
    } finally {
      for (const row of grant.rows) {
        await h.admin.query(
          "INSERT INTO email.template_grant (template, role, category) VALUES ('orgs/member-removed', $1, $2)",
          [row.role, row.category],
        );
      }
    }
    expect((await h.events({ event: "member.removed", organizationId: orgId })).length).toBe(0);
    expect((await h.events({ organizationId: orgId })).length).toBe(before);
    const still = await h.admin.query("SELECT 1 FROM identity.member WHERE id = $1", [
      admin.memberId,
    ]);
    expect(still.rowCount).toBe(1);
    // The same removal, with its notice queueable again, now passes.
    expect(codeOf(await removeAs(h, who, orgId, admin.memberId))).toBe("ok");
  });

  it("refuses an event whose metadata carries an address, before any SQL", async () => {
    const { who, orgId, memberId } = await ownerWithOrganization(h, "planted");
    const out = await asPerson(h, who, {}, { stepUp: { kind: "none" } }, (tx, g) =>
      h.orgs.audit(tx, {
        event: "member.joined",
        actor: g.actor,
        target: memberId,
        organizationId: orgId,
        metadata: { roleKey: "planted@example.com" } as never,
        context: g.context,
      }),
    );
    expect(out.ok).toBe(false);
    expect((await h.events({ event: "member.joined", organizationId: orgId })).length).toBe(0);
  });
});
