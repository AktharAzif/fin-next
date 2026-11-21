// The audit reads (spec 02 §14.5, §15.2.1, S2-43; T-SAT-37's checks, in the read-only functions that
// stand in for `api`'s door): the session, the gate, the membership and `auditLog.read` are re-checked
// from the session's own row; `target` and `targetKind` match only the organisation's own rows; an
// ID from another organisation returns no rows and no label; the person's activity is theirs alone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/db.ts";
import {
  asActor,
  asPerson,
  codeOf,
  createHarness,
  type Harness,
  memberOf,
  ownerWithOrganization,
  person,
  roleAs,
} from "../test/harness.ts";
import { type AuditLogQuery, organisationLog, personActivity } from "./audit-log.ts";

let database: TestDatabase;
let h: Harness;

beforeAll(async () => {
  database = await createTestDatabase("audit_log");
  h = await createHarness(database);
});

afterAll(async () => {
  await database?.drop();
});

const QUERY: AuditLogQuery = { range: "all", tz: "UTC", page: 1, size: 100 };

function log(
  who: Parameters<typeof asActor>[1],
  orgId: string,
  query: Partial<AuditLogQuery> = {},
) {
  return asActor(
    h,
    who,
    orgId,
    { method: "GET" },
    { permission: "auditLog.read", stepUp: { kind: "none" } },
    (tx, a) => organisationLog(tx, a, { ...QUERY, ...query }, new Date()),
  );
}

describe("the organisation's audit log", () => {
  it("shows the organisation's own rows, filtered to one object only inside them", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner");
    const roleId = await roleAs(h, who, orgId, "Support", ["member.read", "auditLog.read"]);
    const other = await ownerWithOrganization(h, "other");
    const otherRole = await roleAs(h, other.who, other.orgId, "Elsewhere", ["member.read"]);
    const all = await log(who, orgId);
    expect(all.ok && all.value.items.map((i) => i.event).sort()).toEqual([
      "organization.created",
      "role.created",
    ]);
    const role = await log(who, orgId, { target: roleId });
    expect(role.ok && role.value).toMatchObject({ filterLabel: "Support", total: 1 });
    const kind = await log(who, orgId, { targetKind: "role" });
    expect(kind.ok && kind.value.items.map((i) => i.target)).toEqual([roleId]);
    // Another organisation's ID matches nothing here and is never named.
    const foreign = await log(who, orgId, { target: otherRole });
    expect(foreign.ok && foreign.value).toMatchObject({ items: [], total: 0, filterLabel: null });
    const byType = await log(who, orgId, { type: "team" });
    expect(byType.ok && byType.value.items.map((i) => i.event)).toEqual(["role.created"]);
    const search = await log(who, orgId, { q: "role." });
    expect(search.ok && search.value.items.map((i) => i.event)).toEqual(["role.created"]);
  });

  it("is refused to a member whose role cannot read it, in the route and in the database", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_refused");
    const readers = await roleAs(h, who, orgId, "Readers", ["member.read"]);
    const reader = await memberOf(h, who, orgId, "reader", readers);
    expect(codeOf(await log(reader.who, orgId))).toBe("forbidden");
    // The database refuses on its own, whatever the caller asserts (the door's re-check).
    const direct = await asPerson(
      h,
      reader.who,
      { method: "GET" },
      { stepUp: { kind: "none" } },
      (tx, g) =>
        tx.query(
          "SELECT * FROM identity.organization_audit_log($1, $2, NULL, NULL, NULL, NULL, NULL, NULL, 10, 0)",
          [g.person.sessionId, orgId],
        ),
    );
    expect(direct.ok).toBe(false);
    expect((direct as { error: { code?: string } }).error.code).toBe("42501");
  });

  it("is refused for a session at the factor step and for one that is not live", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_gate");
    const session = await h.admin.query<{ id: string }>(
      "SELECT id FROM identity.session WHERE user_id = $1",
      [who.userId],
    );
    const sessionId = String(session.rows[0]?.id);
    const asConsole = async () => {
      const client = await h.pool.connect();
      try {
        await client.query(
          "SELECT * FROM identity.organization_audit_log($1, $2, NULL, NULL, NULL, NULL, NULL, NULL, 10, 0)",
          [sessionId, orgId],
        );
        return "ok";
      } catch (error) {
        return String((error as { code?: string }).code);
      } finally {
        client.release();
      }
    };
    expect(await asConsole()).toBe("ok");
    await h.admin.query("ALTER TABLE identity.session DISABLE TRIGGER USER");
    await h.admin.query("UPDATE identity.session SET assurance = 'aal1' WHERE id = $1", [
      sessionId,
    ]);
    await h.admin.query("ALTER TABLE identity.session ENABLE TRIGGER USER");
    expect(await asConsole()).toBe("42501");
    await h.admin.query("ALTER TABLE identity.session DISABLE TRIGGER USER");
    await h.admin.query(
      "UPDATE identity.session SET assurance = 'aal2', expires_at = now() - interval '1 second' WHERE id = $1",
      [sessionId],
    );
    await h.admin.query("ALTER TABLE identity.session ENABLE TRIGGER USER");
    expect(await asConsole()).toBe("42501");
  });
});

describe("the person's activity", () => {
  it("shows the person's own rows only", async () => {
    const a = await person(h, "activity_a");
    const b = await person(h, "activity_b");
    const mine = await asPerson(h, a, { method: "GET" }, { stepUp: { kind: "none" } }, (tx, g) =>
      personActivity(tx, g, { page: 1, size: 50 }),
    );
    expect(mine.ok).toBe(true);
    const events = mine.ok ? mine.value.items : [];
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.event === "user.created")).toBe(true);
    expect(events.every((e) => e.actor.id === a.userId || e.actor.kind === "system")).toBe(true);
    const theirs = await asPerson(h, b, { method: "GET" }, { stepUp: { kind: "none" } }, (tx, g) =>
      personActivity(tx, g, { page: 1, size: 50 }),
    );
    const ids = new Set(events.map((e) => e.id));
    expect(theirs.ok && theirs.value.items.some((e) => ids.has(e.id))).toBe(false);
  });
});
