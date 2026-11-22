// Members (spec 02 §8.5, §9.2, §9.5; T-SAT-24 for organisations, AC-SAT-01, AC-SAT-08): the outrank,
// giving, self and last-holder rules inside the team-change lock, and two concurrent demotions of
// the last two Super admins, of which exactly one passes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, seed, type TestDatabase } from "../test/db.ts";
import {
  asActor,
  changeRoleAs,
  codeOf,
  createHarness,
  extensionsOf,
  type Harness,
  memberOf,
  ownerWithOrganization,
  prove,
  removeAs,
  roleAs,
} from "../test/harness.ts";
import { changeMemberRole, teamList } from "./members.ts";

let database: TestDatabase;
let h: Harness;

beforeAll(async () => {
  database = await createTestDatabase("members");
  h = await createHarness(database);
});

afterAll(async () => {
  await database?.drop();
});

describe("a role change", () => {
  it("writes member.role_changed, tells the person and every Super admin, and lowers into the journal", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner");
    const admin = await memberOf(h, who, orgId, "admin", "admin");
    const readers = await roleAs(h, who, orgId, "Readers", ["member.read"]);
    const done = await changeRoleAs(h, who, orgId, admin.memberId, readers);
    expect(done.ok).toBe(true);
    const event = (await h.events({ event: "member.role_changed", organizationId: orgId })).at(-1);
    expect(event).toMatchObject({
      target_id: admin.memberId,
      metadata: { fromRole: "admin", toRole: readers, reason: "changed", lowered: true },
    });
    expect(event?.step_up_ref).toMatch(/^sti_/);
    const journal = await h.admin.query<{ kind: string }>(
      "SELECT kind FROM audit.journal_entry WHERE audit_event_id = $1",
      [event?.id],
    );
    expect(journal.rows[0]?.kind).toBe("role_lowered");
    const mail = (await h.outbox()).filter((m) => m.template === "orgs/member-role-changed");
    expect(mail.map((m) => `${m.recipient} ${String(m.params.audience)}`)).toEqual(
      expect.arrayContaining([`${admin.who.email} person`, `${who.email} admins`]),
    );
    // Raising them back is counted as giving more access, and journals nothing.
    expect((await changeRoleAs(h, who, orgId, admin.memberId, "admin")).ok).toBe(true);
    const raised = (await h.events({ event: "member.role_changed", organizationId: orgId })).at(-1);
    expect(raised?.metadata).toMatchObject({ lowered: false });
  });

  it("refuses giving beyond one's role, the top role from anyone else, one's own role, and the same role", async () => {
    const { who, orgId, memberId: ownerMember } = await ownerWithOrganization(h, "owner_rules");
    const admin = await memberOf(h, who, orgId, "admin_rules", "admin");
    const other = await memberOf(h, who, orgId, "other_rules", "admin");
    const top = await changeRoleAs(h, admin.who, orgId, other.memberId, "super_admin");
    expect([codeOf(top), extensionsOf(top).problem]).toEqual(["giving_refused", "top_only"]);
    const self = await changeRoleAs(h, admin.who, orgId, admin.memberId, "admin");
    expect(extensionsOf(self).problem).toBe("self");
    const same = await changeRoleAs(h, who, orgId, other.memberId, "admin");
    expect(extensionsOf(same).problem).toBe("unchanged");
    const gone = await changeRoleAs(
      h,
      who,
      orgId,
      other.memberId,
      "rol_01jd0000000000000000000000",
    );
    expect(extensionsOf(gone).problem).toBe("gone");
    const unknown = await changeRoleAs(h, who, orgId, other.memberId, "owner");
    expect(extensionsOf(unknown).problem).toBe("unknown_role");
    // An Admin cannot touch the Super admin (outranked), demote or remove.
    expect(codeOf(await changeRoleAs(h, admin.who, orgId, ownerMember, "admin"))).toBe("outranked");
    expect(codeOf(await removeAs(h, admin.who, orgId, ownerMember))).toBe("outranked");
    // A custom role with member.role may not give a role beyond its own permissions.
    const changers = await roleAs(h, who, orgId, "Changers", ["member.read", "member.role"]);
    const changer = await memberOf(h, who, orgId, "changer", changers);
    const beyond = await changeRoleAs(h, changer.who, orgId, other.memberId, "admin");
    expect([codeOf(beyond), extensionsOf(beyond).problem]).toEqual(["giving_refused", "beyond"]);
    const readers = await roleAs(h, who, orgId, "Plain readers", ["member.read"]);
    // A target whose current role holds something the actor lacks: outranked, even downwards.
    const down = await changeRoleAs(h, changer.who, orgId, other.memberId, readers);
    expect(codeOf(down)).toBe("outranked");
    const plain = await memberOf(h, who, orgId, "plain", readers);
    const up = await changeRoleAs(h, changer.who, orgId, plain.memberId, "admin");
    expect([codeOf(up), extensionsOf(up).problem]).toEqual(["giving_refused", "beyond"]);
  });

  it("checks every rule before asking for a factor (S2-31)", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_order");
    const admin = await memberOf(h, who, orgId, "admin_order", "admin");
    const out = await asActor(
      h,
      admin.who,
      orgId,
      { method: "PATCH", body: { roleKey: "super_admin" } },
      { permission: "member.role", lock: true, stepUp: { kind: "intent", action: "member.role" } },
      (tx, a) =>
        changeMemberRole(h.orgs, tx, a, admin.memberId, {
          roleKey: "super_admin",
          rollCredentials: true,
        }),
    );
    // A refusal, not a step-up: nobody proves a factor for something they cannot do.
    expect(codeOf(out)).toBe("giving_refused");
    const intents = await h.admin.query(
      "SELECT 1 FROM ops.step_up_intent WHERE principal_id = $1 AND action = 'member.role'",
      [admin.who.userId],
    );
    expect(intents.rowCount).toBe(0);
  });
});

describe("the last Super admin", () => {
  it("is acted on only by another Super admin, and never by themselves", async () => {
    const { who, orgId, memberId } = await ownerWithOrganization(h, "lonely");
    // Only a Super admin outranks no Super admin; so the last one can be reached only by
    // themselves (`self`), and `409 last_top_role` guards the race below.
    const second = await memberOf(h, who, orgId, "second_top", "super_admin");
    expect((await changeRoleAs(h, second.who, orgId, memberId, "admin")).ok).toBe(true);
    const last = await changeRoleAs(h, who, orgId, second.memberId, "admin");
    // The demoted owner is no longer a Super admin, so outranked; the second is now the only one.
    expect(codeOf(last)).toBe("outranked");
    const third = await memberOf(h, second.who, orgId, "third_top", "super_admin");
    expect((await removeAs(h, third.who, orgId, second.memberId)).ok).toBe(true);
    const lastStanding = await removeAs(h, third.who, orgId, third.memberId);
    expect(extensionsOf(lastStanding).problem).toBe("self");
  });

  it("stays under two concurrent demotions of the last two: exactly one passes (T-SAT-24)", async () => {
    const { who, orgId, memberId: firstMember } = await ownerWithOrganization(h, "race");
    const second = await memberOf(h, who, orgId, "race_second", "super_admin");
    // Each proves an intent to demote the other, then both re-send at once.
    const ask = (actor: typeof who, target: string, headers: Record<string, string>) =>
      asActor(
        h,
        actor,
        orgId,
        { method: "PATCH", body: { roleKey: "admin", rollCredentials: true }, headers },
        {
          permission: "member.role",
          lock: true,
          stepUp: { kind: "intent", action: "member.role" },
        },
        (tx, a) =>
          changeMemberRole(h.orgs, tx, a, target, { roleKey: "admin", rollCredentials: true }),
      );
    const a = await ask(who, second.memberId, {});
    const b = await ask(second.who, firstMember, {});
    const intentA = String(extensionsOf(a).intent_id);
    const intentB = String(extensionsOf(b).intent_id);
    expect((await prove(h, who, intentA)).status).toBe(200);
    expect((await prove(h, second.who, intentB)).status).toBe(200);
    const [ra, rb] = await Promise.all([
      ask(who, second.memberId, { "fin-step-up-intent": intentA }),
      ask(second.who, firstMember, { "fin-step-up-intent": intentB }),
    ]);
    const outcomes = [codeOf(ra), codeOf(rb)].sort();
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect(outcomes).toContain("outranked");
    const tops = await h.admin.query<{ n: number }>(
      "SELECT count(*)::integer AS n FROM identity.member WHERE organization_id = $1 AND role_key = 'super_admin'",
      [orgId],
    );
    expect(tops.rows[0]?.n).toBe(1);
  });
});

describe("the team list", () => {
  it("lists members with their role and factor chip, No access rows, and pending invitations", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "list");
    const plain = await memberOf(h, who, orgId, "listed", "admin", { factor: false });
    // A role key a later release retired: the row shows as "No access" and allows nothing.
    await seed(h.admin, "UPDATE identity.member SET role_key = 'retired_role' WHERE id = $1", [
      plain.memberId,
    ]);
    const list = await asActor(
      h,
      who,
      orgId,
      { method: "GET" },
      { permission: "member.read", stepUp: { kind: "none" } },
      (tx, a) => teamList(h.orgs, tx, a, { page: 1, size: 25 }),
    );
    expect(list.ok).toBe(true);
    const members = list.ok ? list.value.members : [];
    expect(members).toHaveLength(2);
    const noAccess = members.find((m) => m.memberId === plain.memberId);
    expect(noAccess).toMatchObject({
      roleKnown: false,
      roleLabel: "No access",
      secondFactor: false,
    });
    expect(members.find((m) => m.userId === who.userId)).toMatchObject({
      roleLabel: "Super admin",
      secondFactor: true,
    });
    const searched = await asActor(
      h,
      who,
      orgId,
      { method: "GET" },
      { permission: "member.read", stepUp: { kind: "none" } },
      (tx, a) => teamList(h.orgs, tx, a, { q: plain.who.email.slice(0, 8), page: 1, size: 25 }),
    );
    expect(searched.ok && searched.value.members.map((m) => m.memberId)).toEqual([plain.memberId]);
  });
});
