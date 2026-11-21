// The audit reads (spec 02 §14.5, §15.2.1, S2-43; T-SAT-37's checks, in the read-only functions that
// stand in for `api`'s door): the session, the gate, the membership and `auditLog.read` are re-checked
// from the session's own row; `target` and `targetKind` match only the organisation's own rows; an
// ID from another organisation returns no rows and no label; the person's activity is theirs alone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, seed, type TestDatabase } from "../test/db.ts";
import {
  asActor,
  asPerson,
  codeOf,
  createHarness,
  extensionsOf,
  type Harness,
  memberOf,
  ownerWithOrganization,
  person,
  removeAs,
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

/** An address as Postgres writes it back (no leading zeros, the longest zero run compressed). */
const canonical = (ip: string) => new URL(`http://[${ip}]`).hostname.slice(1, -1);

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
    expect(kind.ok && kind.value.items.map((i) => i.target)).toEqual([
      { id: roleId, label: "Support" },
    ]);
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

describe("an audit row", () => {
  it("names its target and refs by their current labels, for a reader who cannot list the team", async () => {
    const { who, orgId, name } = await ownerWithOrganization(h, "owner_labels");
    const auditors = await roleAs(h, who, orgId, "Auditors", ["auditLog.read"]);
    const auditor = await memberOf(h, who, orgId, "auditor", auditors);
    const out = await log(auditor.who, orgId);
    expect(out.ok).toBe(true);
    const items = out.ok ? out.value.items : [];
    const created = items.find((i) => i.event === "role.created");
    expect(created?.target).toEqual({ id: auditors, label: "Auditors" });
    expect(created?.refs).toEqual([{ id: orgId, label: name }]);
    const joined = items.find((i) => i.event === "member.joined");
    expect(joined?.target).toEqual({ id: auditor.memberId, label: auditor.who.email });
    const refLabels = new Map(joined?.refs.map((r) => [r.id, r.label]));
    expect(refLabels.get(auditor.who.userId)).toBe(auditor.who.email);
    expect(refLabels.get(orgId)).toBe(name);
    const invitation = [...refLabels.keys()].find((id) => id.startsWith("inv_")) as string;
    expect(refLabels.get(invitation)).toBe(auditor.who.email);
    // A stepped-up action shows its proof; one without shows the session.
    expect(created?.verification).toBe("totp");
    expect(items.find((i) => i.event === "organization.created")?.verification).toBe("session");
  });

  it("never shows a Fin staff or system actor's address, device or ID to the organisation", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_staff");
    await h.admin.query("SELECT audit.record($1::jsonb)", [
      JSON.stringify({
        id: "aud_01jd00000000000000000000s1",
        event: "organization.updated",
        actor_kind: "staff",
        actor_id: "stf_01jd00000000000000000000s1",
        actor_via: "admin",
        target_id: orgId,
        ref_ids: [],
        organization_id: orgId,
        metadata: { fields: ["name"] },
        release: "test",
        context: {
          client_ip: "2001:db8:5:1::9",
          user_agent: "Mozilla/5.0 (X11; Linux) Firefox/130.0",
        },
      }),
    ]);
    const out = await log(who, orgId);
    const row = out.ok
      ? out.value.items.find((i) => i.id === "aud_01jd00000000000000000000s1")
      : null;
    expect(row).toMatchObject({
      actor: { kind: "staff", id: null, name: null, email: null },
      address: null,
      device: null,
    });
  });

  it("is paged no further than the 10,000th row, refused as invalid rather than failing", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_paging");
    const far = await log(who, orgId, { page: 102, size: 100 });
    expect([codeOf(far), extensionsOf(far).fields]).toEqual([
      "invalid",
      [{ path: "query.page", code: "too_big" }],
    ]);
    const mine = await asPerson(h, who, { method: "GET" }, { stepUp: { kind: "none" } }, (tx, g) =>
      personActivity(tx, g, { page: 200, size: 100 }),
    );
    expect([codeOf(mine), extensionsOf(mine).fields]).toEqual([
      "invalid",
      [{ path: "query.page", code: "too_big" }],
    ]);
    const last = await asPerson(h, who, { method: "GET" }, { stepUp: { kind: "none" } }, (tx, g) =>
      personActivity(tx, g, { page: 101, size: 100 }),
    );
    expect(last.ok).toBe(true);
  });
});

describe("the person's activity", () => {
  it("never shows another actor's address, device, ID or proof to the person it is about", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_remover");
    const readers = await roleAs(h, who, orgId, "Readers", ["member.read"]);
    const member = await memberOf(h, who, orgId, "removed", readers);
    const browserId = "tbr_01jd00000000000000000000r1";
    await seed(
      h.admin,
      `INSERT INTO identity.trusted_browser (id, user_id, token_hash, label, expires_at)
       VALUES ($1, $2, decode(repeat('ab', 32), 'hex'), 'Firefox on Linux', now() + interval '30 days')`,
      [browserId, member.who.userId],
    );
    expect((await removeAs(h, who, orgId, member.memberId)).ok).toBe(true);
    const activity = await asPerson(
      h,
      member.who,
      { method: "GET" },
      { stepUp: { kind: "none" } },
      (tx, g) => personActivity(tx, g, { page: 1, size: 100 }),
    );
    expect(activity.ok).toBe(true);
    const items = activity.ok ? activity.value.items : [];
    const revoked = items.find((i) => i.event === "browser.trust_revoked");
    expect(revoked).toMatchObject({
      actor: { kind: "user", id: null },
      address: null,
      device: null,
      verification: null,
      metadata: { reason: "removed" },
      target: { id: browserId, label: "Firefox on Linux" },
    });
    expect(JSON.stringify(items)).not.toContain(canonical(who.browser.ip));
    expect(JSON.stringify(items)).not.toContain(who.userId);
    // The person's own rows keep their own address, device and sign-in method.
    const own = items.find((i) => i.event === "session.created");
    expect(own).toMatchObject({
      actor: { id: member.who.userId },
      address: canonical(member.who.browser.ip),
      device: "Chrome on Mac",
      verification: "email_otp",
    });
  });

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
