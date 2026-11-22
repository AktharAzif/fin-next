// Custom roles (spec 02 §8.4, [SA-11], [SA-32]): made through the engine's editor validation, never
// beyond the editor's own permissions, never restricted, every need held, a unique name that does
// not read as a built-in; edited only with the current version, never one the editor holds or one
// that outranks them; deleted with every holder and invitation moved; at most 30.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, DROP_TIMEOUT_MS, seed, type TestDatabase } from "../test/db.ts";
import {
  acceptAs,
  asActor,
  asPerson,
  codeOf,
  createHarness,
  extensionsOf,
  type Harness,
  inviteAs,
  ownerWithOrganization,
  person,
  type SignedIn,
  seededMemberOf,
  seededRole,
  unique,
  warmUp,
  withIntent,
} from "../test/harness.ts";
import { createRole, deleteRole, getRole, listRoles, updateRole } from "./custom-roles.ts";

let database: TestDatabase;
let h: Harness;

beforeAll(async () => {
  database = await createTestDatabase("custom_roles");
  h = await createHarness(database);
});

// The realm's one-time start, so that the first test's time is its own (test/harness.ts).
beforeAll(async () => {
  await warmUp(h);
});

afterAll(async () => {
  await database?.drop();
}, DROP_TIMEOUT_MS);

const MANAGE = { permission: "role.manage", lock: true } as const;

function create(
  who: SignedIn,
  orgId: string,
  name: string,
  permissions: string[],
  description = "",
) {
  return withIntent(h, who, (headers) =>
    asActor(
      h,
      who,
      orgId,
      { body: { name, description, permissions }, headers },
      { ...MANAGE, stepUp: { kind: "intent", action: "role.create" } },
      (tx, a) => createRole(h.orgs, tx, a, { name, description, permissions }),
    ),
  );
}

function update(
  who: SignedIn,
  orgId: string,
  roleId: string,
  body: { name: string; description: string; permissions: string[]; version: number },
) {
  return withIntent(h, who, (headers) =>
    asActor(
      h,
      who,
      orgId,
      { method: "PUT", body, headers },
      { ...MANAGE, stepUp: { kind: "intent", action: "role.update" } },
      (tx, a) => updateRole(h.orgs, tx, a, roleId, body),
    ),
  );
}

function remove(who: SignedIn, orgId: string, roleId: string, moveTo?: string) {
  const body = moveTo === undefined ? {} : { moveTo };
  return withIntent(h, who, (headers) =>
    asActor(
      h,
      who,
      orgId,
      { body, headers },
      { ...MANAGE, stepUp: { kind: "intent", action: "role.delete" } },
      (tx, a) => deleteRole(h.orgs, tx, a, roleId, body),
    ),
  );
}

describe("creating a custom role", () => {
  it("refuses what the editor refuses, each with its field, before any factor is asked", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "creator");
    const refusals: [string, string[], string, string][] = [
      ["Super Admin", ["member.read"], "invalid", "reads_as_built_in"],
      ["visit example.com", ["member.read"], "invalid", "name"],
      ["Nothing", [], "invalid", "empty"],
      ["Deleters", ["organization.delete"], "invalid", "restricted"],
      ["Needy", ["member.invite"], "invalid", "missing_need"],
    ];
    for (const [name, permissions, code, problem] of refusals) {
      const out = await asActor(
        h,
        who,
        orgId,
        { body: { name, permissions } },
        { ...MANAGE, stepUp: { kind: "intent", action: "role.create" } },
        (tx, a) => createRole(h.orgs, tx, a, { name, description: "", permissions }),
      );
      expect(codeOf(out), name).toBe(code);
      const fields = (extensionsOf(out).fields as { code: string }[]).map((f) => f.code);
      expect(fields, name).toContain(problem);
    }
    expect((await create(who, orgId, "Support", ["member.read"])).ok).toBe(true);
    const taken = await create(who, orgId, "support", ["member.read"]);
    expect((extensionsOf(taken).fields as { code: string }[]).map((f) => f.code)).toContain(
      "name_taken",
    );
  });

  it("never gives more than the editor holds", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "giver");
    const managers = await seededRole(h, who, orgId, "Role managers", [
      "member.read",
      "role.manage",
    ]);
    const manager = await seededMemberOf(h, who, orgId, "manager", managers);
    const beyond = await create(manager.who, orgId, "Inviters", ["member.read", "member.invite"]);
    expect([codeOf(beyond), extensionsOf(beyond).problem]).toEqual(["giving_refused", "beyond"]);
    expect((await create(manager.who, orgId, "Readers", ["member.read"])).ok).toBe(true);
  });

  it("allows at most 30 per organisation", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "many");
    for (let i = 0; i < 30; i += 1) {
      await seed(
        h.admin,
        "INSERT INTO identity.role (id, organization_id, name, created_by) VALUES ($1, $2, $3, $4)",
        [
          `rol_01jd0000000000000000000m${String(i).padStart(2, "0")}`.slice(0, 30),
          orgId,
          `Role number ${i}`,
          who.userId,
        ],
      );
    }
    const out = await create(who, orgId, "One more", ["member.read"]);
    expect([codeOf(out), extensionsOf(out).limit]).toEqual(["limit_reached", 30]);
  });
});

describe("editing a custom role", () => {
  it("needs the current version, tells its holders, and journals a lowering", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "editor");
    const roleId = await seededRole(h, who, orgId, "Support", ["member.read", "auditLog.read"]);
    const holder = await seededMemberOf(h, who, orgId, "holder", roleId);
    const stale = await update(who, orgId, roleId, {
      name: "Support",
      description: "",
      permissions: ["member.read"],
      version: 2,
    });
    expect(codeOf(stale)).toBe("conflict");
    const done = await update(who, orgId, roleId, {
      name: "Support team",
      description: "Reads the team",
      permissions: ["member.read"],
      version: 1,
    });
    expect(done.ok && done.value.version).toBe(2);
    const event = (await h.events({ event: "role.updated", organizationId: orgId })).at(-1);
    expect(event?.metadata).toEqual({
      added: [],
      removed: ["auditLog.read"],
      holders: 1,
      renamed: true,
    });
    const journal = await h.admin.query<{ kind: string }>(
      "SELECT kind FROM audit.journal_entry WHERE audit_event_id = $1",
      [event?.id],
    );
    expect(journal.rows[0]?.kind).toBe("role_lowered");
    const mail = await h.outbox(holder.who.email);
    expect(mail.some((m) => m.template === "orgs/role-permissions-changed")).toBe(true);
    const detail = await asActor(
      h,
      who,
      orgId,
      { method: "GET" },
      { permission: "member.read", stepUp: { kind: "none" } },
      (tx, a) => getRole(tx, a, roleId),
    );
    expect(detail.ok && detail.value).toMatchObject({
      label: "Support team",
      holders: 1,
      version: 2,
    });
  });

  it("puts a holder without a factor on hold when a privileged permission is added", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "hold");
    const roleId = await seededRole(h, who, orgId, "Readers", ["member.read"]);
    const holder = await seededMemberOf(h, who, orgId, "unheld", roleId, { factor: false });
    const before = await asPerson(
      h,
      holder.who,
      { method: "GET" },
      { stepUp: { kind: "none" } },
      async () => 1,
    );
    expect(before.ok).toBe(true);
    const out = await update(who, orgId, roleId, {
      name: "Readers",
      description: "",
      permissions: ["member.read", "member.invite"],
      version: 1,
    });
    expect(out.ok).toBe(true);
    const after = await asPerson(
      h,
      holder.who,
      { method: "GET" },
      { stepUp: { kind: "none" } },
      async () => 1,
    );
    expect([codeOf(after), extensionsOf(after).hold]).toEqual(["second_factor_required", true]);
  });

  it("refuses the editor's own role and a role that holds more than the editor", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "self");
    const managers = await seededRole(h, who, orgId, "Managers", ["member.read", "role.manage"]);
    const bigger = await seededRole(h, who, orgId, "Bigger", [
      "member.read",
      "role.manage",
      "auditLog.read",
    ]);
    const manager = await seededMemberOf(h, who, orgId, "self_manager", managers);
    const own = await update(manager.who, orgId, managers, {
      name: "Managers",
      description: "",
      permissions: ["member.read"],
      version: 1,
    });
    expect([codeOf(own), extensionsOf(own).problem]).toEqual(["giving_refused", "self"]);
    const up = await update(manager.who, orgId, bigger, {
      name: "Bigger",
      description: "",
      permissions: ["member.read"],
      version: 1,
    });
    expect(codeOf(up)).toBe("outranked");
  });
});

describe("deleting a custom role", () => {
  it("moves every holder and pending invitation, each with its event, and needs a move when held", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "deleter");
    const roleId = await seededRole(h, who, orgId, "Leaving", ["member.read"]);
    const holder = await seededMemberOf(h, who, orgId, "moved", roleId);
    const pending = await inviteAs(h, who, orgId, unique("pending"), roleId);
    expect(pending.ok).toBe(true);
    const unmoved = await remove(who, orgId, roleId);
    expect(extensionsOf(unmoved).problem).toBe("move_required");
    const done = await remove(who, orgId, roleId, "admin");
    expect(done.ok && done.value).toMatchObject({ membersMoved: 1, invitationsMoved: 1 });
    const moved = (await h.events({ event: "member.role_changed", organizationId: orgId })).at(-1);
    expect(moved).toMatchObject({
      target_id: holder.memberId,
      metadata: { fromRole: roleId, toRole: "admin", reason: "role_deleted" },
    });
    const invitation = (
      await h.events({ event: "member.invitation_changed", organizationId: orgId })
    ).at(-1);
    expect(invitation?.metadata).toEqual({
      fromRole: roleId,
      toRole: "admin",
      reason: "role_deleted",
    });
    const deleted = (await h.events({ event: "role.deleted", organizationId: orgId })).at(-1);
    expect(deleted?.metadata).toEqual({ movedTo: "admin", membersMoved: 1, invitationsMoved: 1 });
    const list = await asActor(
      h,
      who,
      orgId,
      { method: "GET" },
      { permission: "member.read", stepUp: { kind: "none" } },
      (tx, a) => listRoles(tx, a),
    );
    expect(list.ok && list.value.roles.map((r) => r.roleKey)).toEqual(["super_admin", "admin"]);
  });

  it("withdraws, never leaves unusable, the invitations whose inviter cannot give the new role", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "deleter_inviters");
    const readers = await seededRole(h, who, orgId, "Readers", ["member.read"]);
    const inviters = await seededRole(h, who, orgId, "Inviters", ["member.read", "member.invite"]);
    const low = await seededMemberOf(h, who, orgId, "low", inviters);
    const fromLow = await inviteAs(h, low.who, orgId, unique("from_low"), readers);
    const fromOwnerEmail = unique("from_owner");
    const fromOwner = await inviteAs(h, who, orgId, fromOwnerEmail, readers);
    const lowId = fromLow.ok ? fromLow.value.invitationId : "";
    const ownerId = fromOwner.ok ? fromOwner.value.invitationId : "";
    const done = await remove(who, orgId, readers, "admin");
    expect(done.ok && done.value).toMatchObject({ membersMoved: 0, invitationsMoved: 1 });
    const rows = await h.admin.query<{ id: string; status: string; cancel_reason: string | null }>(
      "SELECT id, status, cancel_reason FROM identity.invitation WHERE id = ANY($1) ORDER BY id",
      [[lowId, ownerId]],
    );
    expect(new Map(rows.rows.map((r) => [r.id, [r.status, r.cancel_reason]]))).toEqual(
      new Map([
        [lowId, ["cancelled", "role_deleted"]],
        [ownerId, ["pending", null]],
      ]),
    );
    const withdrawn = (
      await h.events({ event: "member.invitation_cancelled", organizationId: orgId })
    ).find((e) => e.target_id === lowId);
    expect(withdrawn?.metadata).toEqual({ reason: "role_deleted" });
    // The moved invitation stays usable: its inviter may give the new role.
    const invitee = await person(h, "from_owner", { email: fromOwnerEmail });
    const joined = await acceptAs(h, invitee, ownerId);
    expect(joined.ok && joined.value.roleKey).toBe("admin");
  });

  it("withdraws the invitations of holders moved to a role that can no longer give them", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "deleter_holders");
    const readers = await seededRole(h, who, orgId, "Readers", ["member.read"]);
    const leads = await seededRole(h, who, orgId, "Leads", ["member.read", "member.invite"]);
    const lead = await seededMemberOf(h, who, orgId, "lead", leads);
    const sent = await inviteAs(h, lead.who, orgId, unique("lead_sent"), readers);
    const sentId = sent.ok ? sent.value.invitationId : "";
    expect((await remove(who, orgId, leads, readers)).ok).toBe(true);
    const row = await h.admin.query<{ status: string; cancel_reason: string | null }>(
      "SELECT status, cancel_reason FROM identity.invitation WHERE id = $1",
      [sentId],
    );
    expect(row.rows[0]).toEqual({ status: "cancelled", cancel_reason: "role_deleted" });
  });
});

describe("an edit that leaves an inviter unable to give an invitation", () => {
  // Genuinely heavy, so a timeout of its own: three invitations and three role edits, each with an
  // intent and a proof, which are what it is about, for an owner and an inviter each signed in
  // with an authenticator (the roles and the membership are seeded). On GitHub's runner it takes
  // 0.3 s alone and 2.2 s in the full db run.
  it("withdraws it, whether the inviter's role lost a permission or the offered role gained one", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "edit_inviters");
    const readers = await seededRole(h, who, orgId, "Readers", ["member.read"]);
    const leads = await seededRole(h, who, orgId, "Leads", ["member.read", "member.invite"]);
    const lead = await seededMemberOf(h, who, orgId, "edit_lead", leads);
    const first = await inviteAs(h, lead.who, orgId, unique("edit_first"), readers);
    const firstId = first.ok ? first.value.invitationId : "";
    const statusOf = async (id: string) =>
      (
        await h.admin.query<{ status: string; cancel_reason: string | null }>(
          "SELECT status, cancel_reason FROM identity.invitation WHERE id = $1",
          [id],
        )
      ).rows[0];
    // The offered role gains a permission its inviter lacks.
    expect(
      (
        await update(who, orgId, readers, {
          name: "Readers",
          description: "",
          permissions: ["member.read", "auditLog.read"],
          version: 1,
        })
      ).ok,
    ).toBe(true);
    expect(await statusOf(firstId)).toEqual({
      status: "cancelled",
      cancel_reason: "inviter_demoted",
    });
    // The inviter's own role loses the permission to invite.
    const viewers = await seededRole(h, who, orgId, "Viewers", ["member.read"]);
    const second = await inviteAs(h, lead.who, orgId, unique("edit_second"), viewers);
    const secondId = second.ok ? second.value.invitationId : "";
    expect(await statusOf(secondId)).toEqual({ status: "pending", cancel_reason: null });
    expect(
      (
        await update(who, orgId, leads, {
          name: "Leads",
          description: "",
          permissions: ["member.read"],
          version: 1,
        })
      ).ok,
    ).toBe(true);
    expect(await statusOf(secondId)).toEqual({
      status: "cancelled",
      cancel_reason: "inviter_demoted",
    });
    // An edit that leaves the inviter able to give it keeps the invitation.
    const owners = await inviteAs(h, who, orgId, unique("edit_owner"), viewers);
    const ownersId = owners.ok ? owners.value.invitationId : "";
    expect(
      (
        await update(who, orgId, viewers, {
          name: "Viewers",
          description: "",
          permissions: ["member.read", "auditLog.read"],
          version: 1,
        })
      ).ok,
    ).toBe(true);
    expect(await statusOf(ownersId)).toEqual({ status: "pending", cancel_reason: null });
  }, 20_000);
});
