// Custom roles (spec 02 §8.4, [SA-11], [SA-32]): made through the engine's editor validation, never
// beyond the editor's own permissions, never restricted, every need held, a unique name that does
// not read as a built-in (nor one the database's name index holds); edited only with the current
// version, never one the editor holds or one that outranks them; deleted with every holder and
// invitation moved; at most 30; every change counted against the person's edit allowance.
import type { UnitTx } from "@fin/identity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, seed, type TestDatabase } from "../test/db.ts";
import {
  acceptAs,
  asActor,
  asPerson,
  codeOf,
  createHarness,
  extensionsOf,
  type Harness,
  intentIdOf,
  inviteAs,
  memberOf,
  ownerWithOrganization,
  person,
  prove,
  roleAs,
  type SignedIn,
  unique,
  withIntent,
} from "../test/harness.ts";
import {
  createRole,
  deleteRole,
  getRole,
  listRoles,
  nameTakenRefusal,
  updateRole,
} from "./custom-roles.ts";
import type { OrgActor } from "./guard.ts";
import { newId } from "./ids.ts";
import { ORG_LIMITS } from "./limits.ts";

let database: TestDatabase;
let h: Harness;

beforeAll(async () => {
  database = await createTestDatabase("custom_roles");
  h = await createHarness(database);
});

afterAll(async () => {
  await database?.drop();
});

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
    const managers = await roleAs(h, who, orgId, "Role managers", ["member.read", "role.manage"]);
    const manager = await memberOf(h, who, orgId, "manager", managers);
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

  it("refuses a name the database's name index holds for another role, even one the editor tells apart, before any factor is asked", async (ctx) => {
    // "Info desk" with a capital I with a dot above: the editor's own comparison keeps it apart
    // from "Info desk", while `lower()` folds both to one key under the server's collation.
    const dotted = "İnfo desk";
    const folds = await h.admin.query<{ same: boolean }>("SELECT lower($1) = lower($2) AS same", [
      dotted,
      "Info desk",
    ]);
    if (folds.rows[0]?.same !== true) {
      ctx.skip("this database's collation keeps the two names apart, as the editor does");
    }
    const { who, orgId } = await ownerWithOrganization(h, "folding");
    expect((await create(who, orgId, "Info desk", ["member.read"])).ok).toBe(true);
    const other = await roleAs(h, who, orgId, "Help desk", ["member.read"]);
    const draft = { name: dotted, description: "", permissions: ["member.read"] };
    const firstTries = [
      await asActor(
        h,
        who,
        orgId,
        { body: draft },
        { ...MANAGE, stepUp: { kind: "intent", action: "role.create" } },
        (tx, a) => createRole(h.orgs, tx, a, draft),
      ),
      await asActor(
        h,
        who,
        orgId,
        { method: "PUT", body: { ...draft, version: 1 } },
        { ...MANAGE, stepUp: { kind: "intent", action: "role.update" } },
        (tx, a) => updateRole(h.orgs, tx, a, other, { ...draft, version: 1 }),
      ),
    ];
    for (const out of firstTries) {
      expect(codeOf(out)).toBe("invalid");
      expect(extensionsOf(out)).toEqual({ fields: [{ path: "name", code: "name_taken" }] });
    }
  });

  it("answers the name index's own refusal as the editor's name_taken, should a write ever reach it", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "backstop");
    const clock = { now: () => new Date() };
    const insert = (name: string) =>
      seed(
        h.admin,
        "INSERT INTO identity.role (id, organization_id, name, created_by) VALUES ($1, $2, $3, $4)",
        [newId("rol", clock), orgId, name, who.userId],
      );
    await insert("Backstop role");
    const refused = await insert("BACKSTOP ROLE").then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({ code: "23505", constraint: "role_name_once" });
    expect(nameTakenRefusal(refused)).toMatchObject({
      code: "invalid",
      status: 400,
      lineReason: "role.name_taken",
      extensions: { fields: [{ path: "name", code: "name_taken" }] },
    });
    for (const other of [{ code: "23505", constraint: "role_pkey" }, new Error("x"), null]) {
      expect(nameTakenRefusal(other)).toBe(null);
    }
  });
});

describe("the edit allowance (§8.4: 30 an hour and 100 a day per person)", () => {
  /** Fills the person's role edit allowance, both windows. */
  async function fill(userId: string): Promise<void> {
    const now = Date.now();
    for (const window of ORG_LIMITS.role_edit) {
      await h.admin.query(
        `INSERT INTO ops.rate_window (key, window_start, count) VALUES ($1, $2, $3)
         ON CONFLICT (key, window_start) DO UPDATE SET count = EXCLUDED.count`,
        [
          `role_edit:${window.ms}:${userId}`,
          new Date(Math.floor(now / window.ms) * window.ms),
          window.max,
        ],
      );
    }
  }

  it("counts making, saving and deleting a role, refusing each past it with nothing changed and the intent unspent", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "allowance");
    const kept = await roleAs(h, who, orgId, "Kept", ["member.read"]);
    const spare = await roleAs(h, who, orgId, "Spare", ["member.read"]);
    const draft = { name: "Kept", description: "", permissions: ["member.read", "auditLog.read"] };
    const changes: {
      label: string;
      method: string;
      action: "role.create" | "role.update" | "role.delete";
      body: Record<string, unknown>;
      run: (tx: UnitTx, a: OrgActor) => Promise<unknown>;
    }[] = [
      {
        label: "make",
        method: "POST",
        action: "role.create",
        body: { name: "Extra", description: "", permissions: ["member.read"] },
        run: (tx, a) =>
          createRole(h.orgs, tx, a, {
            name: "Extra",
            description: "",
            permissions: ["member.read"],
          }),
      },
      {
        label: "save",
        method: "PUT",
        action: "role.update",
        body: { ...draft, version: 1 },
        run: (tx, a) => updateRole(h.orgs, tx, a, kept, { ...draft, version: 1 }),
      },
      {
        label: "delete",
        method: "POST",
        action: "role.delete",
        body: {},
        run: (tx, a) => deleteRole(h.orgs, tx, a, spare, {}),
      },
    ];
    await fill(who.userId);
    try {
      for (const change of changes) {
        const attempt = (headers: Record<string, string>) =>
          asActor(
            h,
            who,
            orgId,
            { method: change.method, body: change.body, headers },
            { ...MANAGE, stepUp: { kind: "intent", action: change.action } },
            change.run,
          );
        const first = await attempt({});
        const intent = first.ok ? null : intentIdOf(first.error);
        expect(intent, change.label).not.toBeNull();
        expect((await prove(h, who, intent as string)).status, change.label).toBe(200);
        const refused = await attempt({ "fin-step-up-intent": intent as string });
        expect(codeOf(refused), change.label).toBe("rate_limited");
        const spent = await h.admin.query(
          "SELECT 1 FROM ops.step_up_intent WHERE id = $1 AND consumed_at IS NOT NULL",
          [intent],
        );
        expect(spent.rowCount, change.label).toBe(0);
      }
      const roles = await h.admin.query<{ id: string; name: string; version: number }>(
        "SELECT id, name, version FROM identity.role WHERE organization_id = $1 ORDER BY name",
        [orgId],
      );
      expect(roles.rows.map((r) => [r.id, r.name, Number(r.version)])).toEqual([
        [kept, "Kept", 1],
        [spare, "Spare", 1],
      ]);
    } finally {
      await h.admin.query("DELETE FROM ops.rate_window WHERE key LIKE $1", [
        `role_edit:%:${who.userId}`,
      ]);
    }
  });
});

describe("editing a custom role", () => {
  it("needs the current version, tells its holders, and journals a lowering", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "editor");
    const roleId = await roleAs(h, who, orgId, "Support", ["member.read", "auditLog.read"]);
    const holder = await memberOf(h, who, orgId, "holder", roleId);
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
    const roleId = await roleAs(h, who, orgId, "Readers", ["member.read"]);
    const holder = await memberOf(h, who, orgId, "unheld", roleId, { factor: false });
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
    const managers = await roleAs(h, who, orgId, "Managers", ["member.read", "role.manage"]);
    const bigger = await roleAs(h, who, orgId, "Bigger", [
      "member.read",
      "role.manage",
      "auditLog.read",
    ]);
    const manager = await memberOf(h, who, orgId, "self_manager", managers);
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
    const roleId = await roleAs(h, who, orgId, "Leaving", ["member.read"]);
    const holder = await memberOf(h, who, orgId, "moved", roleId);
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
    const readers = await roleAs(h, who, orgId, "Readers", ["member.read"]);
    const inviters = await roleAs(h, who, orgId, "Inviters", ["member.read", "member.invite"]);
    const low = await memberOf(h, who, orgId, "low", inviters);
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
    const readers = await roleAs(h, who, orgId, "Readers", ["member.read"]);
    const leads = await roleAs(h, who, orgId, "Leads", ["member.read", "member.invite"]);
    const lead = await memberOf(h, who, orgId, "lead", leads);
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
  it("withdraws it, whether the inviter's role lost a permission or the offered role gained one", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "edit_inviters");
    const readers = await roleAs(h, who, orgId, "Readers", ["member.read"]);
    const leads = await roleAs(h, who, orgId, "Leads", ["member.read", "member.invite"]);
    const lead = await memberOf(h, who, orgId, "edit_lead", leads);
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
    const viewers = await roleAs(h, who, orgId, "Viewers", ["member.read"]);
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
  });
});
