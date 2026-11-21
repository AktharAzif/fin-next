// Organisations (spec 02 §9.1, §5.9; T-SAT-35, AC-SAT-33, AC-SAT-34): the first organisation and its
// hold; at most 10 as Super admin; the `Fin-Organization` rules (missing 400, not a member and deleted
// both 404); deletion refused while approved, and its one transaction.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, seed, type TestDatabase } from "../test/db.ts";
import {
  asActor,
  asPerson,
  codeOf,
  createHarness,
  extensionsOf,
  type Harness,
  person,
  unique,
  withIntent,
} from "../test/harness.ts";
import {
  createFirstOrganization,
  createOrganization,
  deleteOrganization,
  firstOrganizationName,
  listOrganizations,
  renameOrganization,
  switchOrganization,
} from "./organizations.ts";

let database: TestDatabase;
let h: Harness;

beforeAll(async () => {
  database = await createTestDatabase("organizations");
  h = await createHarness(database);
});

afterAll(async () => {
  await database?.drop();
});

describe("the first organisation's name (§5.9)", () => {
  it("is built from a work domain, else the first name, else a fallback", () => {
    expect(firstOrganizationName({ email: "ada@acme-payments.example.net", name: "" })).toBe(
      "Acme Payments",
    );
    expect(firstOrganizationName({ email: "ada@example.com", name: "Ada Lovelace" })).toBe(
      "Ada's organisation",
    );
    expect(firstOrganizationName({ email: "ada@example.com", name: "" })).toBe("My organisation");
  });
});

describe("POST /api/orgs/first", () => {
  it("makes the person its Super admin, writes organization.created with first, and holds them", async () => {
    const who = await person(h, "first", { factor: false });
    const made = await asPerson(h, who, {}, { stepUp: { kind: "none" } }, (tx, g) =>
      createFirstOrganization(h.orgs, tx, g),
    );
    expect(made.ok).toBe(true);
    const orgId = made.ok ? made.value.orgId : "";
    const events = await h.events({ event: "organization.created", organizationId: orgId });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({ first: true });
    const member = await h.admin.query<{ id: string; role_key: string }>(
      "SELECT id, role_key FROM identity.member WHERE organization_id = $1",
      [orgId],
    );
    expect(member.rows[0]?.role_key).toBe("super_admin");
    expect(events[0]?.ref_ids).toContain(member.rows[0]?.id);
    const session = await h.admin.query<{ current_organization_id: string }>(
      "SELECT current_organization_id FROM identity.session WHERE user_id = $1",
      [who.userId],
    );
    expect(session.rows[0]?.current_organization_id).toBe(orgId);
    // A Super admin is privileged; with no factor the person is now held (§5.9, [SA-05]).
    const held = await asPerson(
      h,
      who,
      { method: "GET" },
      { stepUp: { kind: "none" } },
      async () => 1,
    );
    expect(codeOf(held)).toBe("second_factor_required");
    expect(extensionsOf(held)).toMatchObject({ hold: true });
    // Refused once the person has a membership.
    const again = await asPerson(
      h,
      who,
      {},
      { stepUp: { kind: "none" }, reach: ["ok", "hold"] },
      (tx, g) => createFirstOrganization(h.orgs, tx, g),
    );
    expect(codeOf(again)).toBe("already_member");
  });
});

describe("POST /api/orgs", () => {
  it("needs a factor and an intent, makes a Super admin, and allows at most 10 as Super admin", async () => {
    const who = await person(h, "creator");
    const create = (name: string, headers: Record<string, string>) =>
      asPerson(
        h,
        who,
        { body: { name }, headers },
        { stepUp: { kind: "intent", action: "org.create" } },
        (tx, g) => createOrganization(h.orgs, tx, g, { name }),
      );
    const asked = await create("Second Team", {});
    expect(codeOf(asked)).toBe("step_up_required");
    const made = await withIntent(h, who, (headers) => create("Second Team", headers));
    expect(made.ok).toBe(true);
    const events = await h.events({ event: "organization.created" });
    const mine = events.filter((e) => e.actor_id === who.userId);
    expect(mine.at(-1)?.metadata).toEqual({ first: false });
    expect(mine.at(-1)?.step_up_ref).toMatch(/^sti_/);

    // Eight more reach the limit of ten; the eleventh is refused before any factor is asked.
    for (let i = 0; i < 9; i += 1) {
      const next = await withIntent(h, who, (headers) => create(`Team ${i + 3}`, headers));
      expect(next.ok, String(i)).toBe(true);
    }
    const eleventh = await create("Team Eleven", {});
    expect(codeOf(eleventh)).toBe("limit_reached");
    expect(extensionsOf(eleventh)).toMatchObject({ limit: 10 });
  });

  it("refuses a person with no factor, before asking for one", async () => {
    const who = await person(h, "nofactor", { factor: false });
    const out = await asPerson(
      h,
      who,
      { body: { name: "Mine" } },
      { stepUp: { kind: "intent", action: "org.create" } },
      (tx, g) => createOrganization(h.orgs, tx, g, { name: "Mine" }),
    );
    expect(codeOf(out)).toBe("second_factor_required");
  });

  it("refuses a name the organisation-name rule refuses", async () => {
    const who = await person(h, "badname");
    const out = await asPerson(
      h,
      who,
      { body: { name: "visit example.com" } },
      { stepUp: { kind: "intent", action: "org.create" } },
      (tx, g) => createOrganization(h.orgs, tx, g, { name: "visit example.com" }),
    );
    expect(codeOf(out)).toBe("invalid");
  });
});

async function ownerWithOrganization(label: string) {
  const who = await person(h, label);
  const made = await asPerson(h, who, {}, { stepUp: { kind: "none" } }, (tx, g) =>
    createFirstOrganization(h.orgs, tx, g),
  );
  if (!made.ok) throw new Error("no organisation");
  return { who, orgId: made.value.orgId, name: made.value.name };
}

describe("Fin-Organization (S2-10, AC-SAT-34)", () => {
  it("is required, and a non-member's, a deleted and an unknown organisation are all 404", async () => {
    const { who, orgId } = await ownerWithOrganization("scope");
    const missing = await asActor(
      h,
      who,
      null,
      { method: "GET" },
      { stepUp: { kind: "none" } },
      async () => 1,
    );
    expect(codeOf(missing)).toBe("organization_required");
    const malformed = await asActor(
      h,
      who,
      "org_nope",
      { method: "GET" },
      { stepUp: { kind: "none" } },
      async () => 1,
    );
    expect(codeOf(malformed)).toBe("not_found");
    const other = await ownerWithOrganization("scope_other");
    const notMine = await asActor(
      h,
      who,
      other.orgId,
      { method: "GET" },
      { stepUp: { kind: "none" } },
      async () => 1,
    );
    expect(codeOf(notMine)).toBe("not_found");
    const unknown = await asActor(
      h,
      who,
      "org_01jd0000000000000000000000",
      { method: "GET" },
      { stepUp: { kind: "none" } },
      async () => 1,
    );
    expect(codeOf(unknown)).toBe("not_found");
    await seed(h.admin, "UPDATE identity.organization SET deleted_at = now() WHERE id = $1", [
      orgId,
    ]);
    const deleted = await asActor(
      h,
      who,
      orgId,
      { method: "GET" },
      { stepUp: { kind: "none" } },
      async () => 1,
    );
    expect(codeOf(deleted)).toBe("not_found");
  });

  it("acts only on the header's organisation, whatever the session's current one is", async () => {
    const { who, orgId } = await ownerWithOrganization("header");
    const second = await withIntent(h, who, (headers) =>
      asPerson(
        h,
        who,
        { body: { name: "Header Two" }, headers },
        { stepUp: { kind: "intent", action: "org.create" } },
        (tx, g) => createOrganization(h.orgs, tx, g, { name: "Header Two" }),
      ),
    );
    expect(second.ok).toBe(true);
    // The session now points at the second; the header still decides.
    const seen = await asActor(
      h,
      who,
      orgId,
      { method: "GET" },
      { stepUp: { kind: "none" } },
      async (_tx, a) => a.organization.id,
    );
    expect(seen.ok && seen.value).toBe(orgId);
    // Switching is navigation only: no audit row.
    const before = (await h.events()).length;
    const switched = await asPerson(
      h,
      who,
      { method: "PUT" },
      { stepUp: { kind: "none" } },
      (tx, g) => switchOrganization(h.orgs, tx, g, orgId),
    );
    expect(switched.ok).toBe(true);
    expect((await h.events()).length).toBe(before);
    const list = await asPerson(h, who, { method: "GET" }, { stepUp: { kind: "none" } }, (tx, g) =>
      listOrganizations(tx, g, { page: 1, size: 25 }),
    );
    expect(list.ok && list.value.items.map((o) => o.roleLabel)).toEqual([
      "Super admin",
      "Super admin",
    ]);
  });
});

describe("PATCH /api/org", () => {
  it("renames with an intent, refuses the same name as unchanged, and writes organization.updated", async () => {
    const { who, orgId, name } = await ownerWithOrganization("rename");
    const rename = (to: string, headers: Record<string, string>) =>
      asActor(
        h,
        who,
        orgId,
        { method: "PATCH", body: { name: to }, headers },
        {
          permission: "organization.update",
          lock: true,
          stepUp: { kind: "intent", action: "org.rename" },
        },
        (tx, a) => renameOrganization(h.orgs, tx, a, { name: to }),
      );
    const same = await rename(name, {});
    expect(codeOf(same)).toBe("invalid");
    expect(extensionsOf(same)).toMatchObject({ problem: "unchanged" });
    const done = await withIntent(h, who, (headers) => rename("Renamed Team", headers));
    expect(done.ok).toBe(true);
    const updated = await h.events({ event: "organization.updated", organizationId: orgId });
    expect(updated.at(-1)?.metadata).toEqual({ fields: ["name"] });
  });
});

describe("DELETE /api/org", () => {
  it("refuses a mismatched name and an organisation with Production access", async () => {
    const { who, orgId, name } = await ownerWithOrganization("delete_refused");
    const remove = (confirmName: string) =>
      asActor(
        h,
        who,
        orgId,
        { method: "DELETE", body: { confirmName } },
        {
          permission: "organization.delete",
          lock: true,
          stepUp: { kind: "intent", action: "org.delete" },
        },
        (tx, a) => deleteOrganization(h.orgs, tx, a, { confirmName }),
      );
    expect(codeOf(await remove(`${name}x`))).toBe("invalid");
    await seed(h.admin, "UPDATE identity.organization SET live_status = 'approved' WHERE id = $1", [
      orgId,
    ]);
    expect(codeOf(await remove(name))).toBe("approved_for_live");
  });

  it("deletes in one transaction: invitations cancelled, roles and memberships gone, the event, its journal entry and a notice to every member", async () => {
    const { who, orgId, name } = await ownerWithOrganization("delete");
    const invitee = unique("invitee");
    await seed(
      h.admin,
      `INSERT INTO identity.invitation (id, organization_id, email, role_key, token_hash, invited_by, expires_at)
       VALUES ('inv_01jd0000000000000000000001', $1, $2, 'admin', decode(repeat('ab', 32), 'hex'), $3, now() + interval '7 days')`,
      [orgId, invitee, who.userId],
    );
    await seed(
      h.admin,
      `INSERT INTO identity.role (id, organization_id, name, created_by)
       VALUES ('rol_01jd0000000000000000000001', $1, 'Readers', $2)`,
      [orgId, who.userId],
    );
    await seed(
      h.admin,
      `INSERT INTO identity.role_permission (role_id, permission)
       VALUES ('rol_01jd0000000000000000000001', 'member.read')`,
    );
    const done = await withIntent(h, who, (headers) =>
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
    expect(done.ok, JSON.stringify(done)).toBe(true);
    const org = await h.admin.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM identity.organization WHERE id = $1",
      [orgId],
    );
    expect(org.rows[0]?.deleted_at).not.toBeNull();
    expect(
      (await h.admin.query("SELECT 1 FROM identity.member WHERE organization_id = $1", [orgId]))
        .rowCount,
    ).toBe(0);
    expect(
      (await h.admin.query("SELECT 1 FROM identity.role WHERE organization_id = $1", [orgId]))
        .rowCount,
    ).toBe(0);
    const invitation = await h.admin.query<{ status: string; cancel_reason: string }>(
      "SELECT status, cancel_reason FROM identity.invitation WHERE organization_id = $1",
      [orgId],
    );
    expect(invitation.rows[0]).toEqual({
      status: "cancelled",
      cancel_reason: "organisation_deleted",
    });
    const deleted = await h.events({ event: "organization.deleted", organizationId: orgId });
    expect(deleted[0]?.metadata).toEqual({ members: 1, invitations: 1, keysRevoked: 0 });
    expect(deleted[0]?.ref_ids).toContain("rol_01jd0000000000000000000001");
    const journal = await h.admin.query<{ kind: string }>(
      "SELECT kind FROM audit.journal_entry WHERE audit_event_id = $1",
      [deleted[0]?.id],
    );
    expect(journal.rows[0]?.kind).toBe("organisation_deleted");
    const cancelled = await h.events({
      event: "member.invitation_cancelled",
      organizationId: orgId,
    });
    expect(cancelled[0]?.metadata).toEqual({ reason: "organisation_deleted" });
    const mail = await h.outbox(who.email);
    expect(mail.some((m) => m.template === "orgs/organization-deleted")).toBe(true);
  });
});
