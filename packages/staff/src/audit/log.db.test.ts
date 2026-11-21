// Fin Admin's audit log reads on the real platform (spec 02 §14.3, §14.5, §16.4; ARCHITECTURE
// §8.6; spec 08 §3.11): the staff rows newest first with their actor, labels, chip, address and
// device; nothing of an organisation's or a person's log, by the list or by an entry's ID; paging
// both ways by cursor within its limits; the filters and the two views; and the database's own
// re-check of the reader (the door's stand-in), which refuses whatever the guard would, even when
// called past it, and leaves fin_admin no way to read audit.event but the two reads.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accessFor,
  type Browser,
  createStaffHarness,
  type StaffHarness,
  unique,
} from "../../test/harness.ts";
import { newId } from "../ids.ts";
import { requireStaff, type StaffActor } from "../require-staff.ts";
import {
  type StaffAuditEntry,
  type StaffAuditPage,
  type StaffAuditQuery,
  type StaffAuditReader,
  staffAuditEntry,
  staffAuditLog,
} from "./log.ts";

let h: StaffHarness;
let admin: { staffId: string; browser: Browser; email: string };
let viewer: { staffId: string; browser: Browser; email: string };
let reader: { staffId: string; browser: Browser; email: string };
let nonReader: { staffId: string; browser: Browser; email: string };
let personRow: string;
let orgRow: string;
let orgStaffRow: string;
let rejection: string;
let operatorRow: string;
const ORG = `org_01jd${"7".repeat(22)}`;

async function member(roleKey: string, label: string) {
  const email = unique(label);
  const { staffId, browser } = await h.enrolled(email, roleKey);
  return { staffId, browser, email };
}

/** The guard as the route runs it, without a permission, so the database's own check is tested. */
function who(browser: Browser): Promise<StaffActor> {
  return h.route(browser, { method: "GET", path: "/api/audit" }, (_tx, request, context) =>
    requireStaff(h.realm, request, context),
  );
}

function readerOf(browser: Browser, actor: StaffActor, sub?: string): StaffAuditReader {
  return {
    staffId: actor.staffId,
    sessionId: actor.sessionId,
    accessSub: sub ?? browser.access?.sub ?? null,
  };
}

async function list(
  browser: Browser,
  query: Partial<StaffAuditQuery> = {},
  sub?: string,
): Promise<StaffAuditPage> {
  const actor = await who(browser);
  return h.route(browser, { method: "GET", path: "/api/audit" }, (tx) =>
    staffAuditLog(h.deps, tx, readerOf(browser, actor, sub), { limit: 50, ...query }),
  );
}

async function entry(browser: Browser, id: string): Promise<StaffAuditEntry> {
  const actor = await who(browser);
  return h.route(browser, { method: "GET", path: `/api/audit/${id}` }, (tx) =>
    staffAuditEntry(h.deps, tx, readerOf(browser, actor), id),
  );
}

async function refused(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
    throw error;
  }
  return "none";
}

/** A row written straight into audit.event, as a fixture (another scope, or a later area's event). */
async function seedRow(input: {
  event: string;
  scope: "organisation" | "person" | "staff";
  category: string;
  actorKind: string;
  actorId: string | null;
  target: string;
  organizationId?: string;
  subjectUserId?: string;
}): Promise<string> {
  const id = newId("aud", { now: () => new Date() });
  await h.fixture(
    `INSERT INTO audit.event_type (name, area, category, scope, roles, synced_release)
     VALUES ($1, 'fixture', $2, $3, ARRAY['fin_owner'], 'test') ON CONFLICT (name) DO NOTHING`,
    [input.event, input.category, input.scope],
  );
  await h.fixture(
    `INSERT INTO audit.event (id, epoch, event, category, scope, organization_id, subject_user_id,
        actor_kind, actor_id, actor_via, target_id, release, db_login, app_name, backend_pid, xid,
        recorded_at)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, 'admin', $9, 'test', 'fin_owner', 'fixture',
        pg_backend_pid(), pg_current_xact_id(), clock_timestamp())`,
    [
      id,
      input.event,
      input.category,
      input.scope,
      input.organizationId ?? null,
      input.subjectUserId ?? null,
      input.actorKind,
      input.actorId,
      input.target,
    ],
  );
  return id;
}

beforeAll(async () => {
  h = await createStaffHarness("sun00audit");
  admin = await member("admin", "audit.admin");
  viewer = await member("viewer", "audit.viewer");
  reader = await member(await h.seedCustomRole("Auditors", ["audit.read"]), "audit.reader");
  nonReader = await member(await h.seedCustomRole("Staff readers", ["staff.read"]), "audit.no");
  personRow = await seedRow({
    event: "user.created",
    scope: "person",
    category: "security",
    actorKind: "staff",
    actorId: admin.staffId,
    target: `usr_01jd${"5".repeat(22)}`,
    subjectUserId: `usr_01jd${"5".repeat(22)}`,
  });
  orgRow = await seedRow({
    event: "organization.created",
    scope: "organisation",
    category: "organisation",
    actorKind: "staff",
    actorId: admin.staffId,
    target: ORG,
    organizationId: ORG,
  });
  orgStaffRow = await seedRow({
    event: "staff.organization_paused",
    scope: "staff",
    category: "staff",
    actorKind: "staff",
    actorId: viewer.staffId,
    target: ORG,
    organizationId: ORG,
  });
  rejection = await seedRow({
    event: "staff.customer_rejected",
    scope: "staff",
    category: "staff",
    actorKind: "staff",
    actorId: admin.staffId,
    target: `cus_01jd${"6".repeat(22)}`,
    organizationId: ORG,
  });
  operatorRow = await seedRow({
    event: "staff.bootstrapped",
    scope: "staff",
    category: "staff",
    actorKind: "operator",
    actorId: "run_fixture",
    target: admin.staffId,
  });
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe("the staff log", () => {
  it("lists the staff rows newest first, with the actor, labels, chip, address and device", async () => {
    const page = await list(admin.browser);
    expect(page.items.length).toBeGreaterThan(5);
    const ids = page.items.map((item) => item.id);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(page.total).toBe(page.items.length);
    expect(page).toMatchObject({ totalCapped: false, nextCursor: null, previousCursor: null });

    // The viewer's own enrolment, as the realm wrote it, from the browser that did it, its
    // target named by the staff table as it is now.
    const enrolled = page.items.find(
      (item) => item.event === "staff.factor_enrolled" && item.actor.id === viewer.staffId,
    );
    expect(enrolled).toMatchObject({
      category: "security",
      actor: { kind: "staff", via: "admin", email: viewer.email },
      target: { id: viewer.staffId, label: viewer.email },
      address: viewer.browser.ip,
      device: "Chrome on Mac",
      verification: "session",
    });

    // The operator's row: no chip, no address; its target named by the staff table.
    const bootstrapped = page.items.find((item) => item.id === operatorRow);
    expect(bootstrapped).toMatchObject({
      actor: { kind: "operator", id: "run_fixture", email: null },
      verification: null,
      address: null,
      device: null,
      target: { id: admin.staffId, label: admin.email },
    });
    expect(page.items.find((item) => item.id === orgStaffRow)?.organisationId).toBe(ORG);
  });

  it("never returns a row of an organisation's or a person's log", async () => {
    const page = await list(admin.browser, { limit: 100 });
    const ids = page.items.map((item) => item.id);
    expect(ids).not.toContain(personRow);
    expect(ids).not.toContain(orgRow);
    // Not by the organisation they are about, nor by an actor filter that names their actor.
    const byOrg = await list(admin.browser, { orgs: [ORG] });
    expect(byOrg.items.map((item) => item.id).sort()).toEqual([orgStaffRow, rejection].sort());
    const byActor = await list(admin.browser, { actors: [admin.staffId], limit: 100 });
    expect(byActor.items.map((item) => item.id)).not.toContain(personRow);
    expect(byActor.items.map((item) => item.id)).not.toContain(orgRow);
    // Nor by its ID.
    expect(await refused(entry(admin.browser, personRow))).toBe("not_found");
    expect(await refused(entry(admin.browser, orgRow))).toBe("not_found");
    expect(await refused(entry(admin.browser, `aud_01jd${"9".repeat(22)}`))).toBe("not_found");
    expect(await refused(entry(admin.browser, "aud_not-an-id"))).toBe("not_found");
  });

  it("reads one entry by its ID, as the list draws it", async () => {
    const page = await list(admin.browser);
    const first = page.items[0] as StaffAuditEntry;
    expect(await entry(viewer.browser, first.id)).toEqual(first);
  });

  it("pages older and newer by cursor, within its limits", async () => {
    const all = (await list(admin.browser, { limit: 100 })).items.map((item) => item.id);
    const first = await list(admin.browser, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(all.slice(0, 2));
    expect(first.previousCursor).toBeNull();
    expect(first.nextCursor).toBe(all[1]);
    expect(first.total).toBe(all.length);

    const second = await list(admin.browser, { limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.items.map((item) => item.id)).toEqual(all.slice(2, 4));
    expect(second.previousCursor).toBe(all[2]);
    expect(second.nextCursor).toBe(all[3]);

    const back = await list(admin.browser, { limit: 2, before: second.previousCursor ?? "" });
    expect(back.items.map((item) => item.id)).toEqual(all.slice(0, 2));
    expect(back.previousCursor).toBeNull();
    expect(back.nextCursor).toBe(all[1]);

    const last = await list(admin.browser, { limit: 2, cursor: all.at(-3) ?? "" });
    expect(last.items.map((item) => item.id)).toEqual(all.slice(-2));
    expect(last.nextCursor).toBeNull();
    expect(last.previousCursor).toBe(all.at(-2));

    for (const limit of [0, 101]) {
      expect(await refused(list(admin.browser, { limit }))).toBe("invalid");
    }
    expect(await refused(list(admin.browser, { cursor: all[1] ?? "", before: all[0] ?? "" }))).toBe(
      "invalid",
    );
  });

  it("filters by action, actor and days, and reads the two views", async () => {
    const enrolments = await list(admin.browser, { actions: ["staff.factor_enrolled"] });
    expect(enrolments.items.length).toBeGreaterThanOrEqual(4);
    expect(new Set(enrolments.items.map((item) => item.event))).toEqual(
      new Set(["staff.factor_enrolled"]),
    );

    const byViewer = await list(admin.browser, { actors: [viewer.staffId] });
    expect(byViewer.items.length).toBeGreaterThan(0);
    expect(byViewer.items.every((item) => item.actor.id === viewer.staffId)).toBe(true);

    // My actions: the reader's own rows, as the database knows the reader.
    const mine = await list(viewer.browser, { show: "mine" });
    expect(mine.items.map((item) => item.id).sort()).toEqual(
      byViewer.items.map((item) => item.id).sort(),
    );
    expect((await list(viewer.browser, { show: "mine", actors: [admin.staffId] })).items).toEqual(
      [],
    );

    // Rejections this week: the staff rejections since Monday, and nothing else.
    const rejections = await list(admin.browser, { show: "rejections" });
    expect(rejections.items.map((item) => item.id)).toEqual([rejection]);
    expect(
      (await list(admin.browser, { show: "rejections", actions: ["staff.factor_enrolled"] })).items,
    ).toEqual([]);

    const today = new Date().toISOString().slice(0, 10);
    expect((await list(admin.browser, { from: today, to: today })).total).toBeGreaterThan(5);
    expect((await list(admin.browser, { to: "2026-01-01" })).items).toEqual([]);
    expect((await list(admin.browser, { range: "today" })).total).toBeGreaterThan(5);
  });
});

describe("the database's own check of the reader (the door's stand-in)", () => {
  it("lets a custom role holding audit.read read, and refuses one without it", async () => {
    expect((await list(reader.browser)).items.length).toBeGreaterThan(0);
    const before = h.lines.named("staff.audit_read_refused").length;
    expect(await refused(list(nonReader.browser))).toBe("forbidden");
    expect(await refused(entry(nonReader.browser, operatorRow))).toBe("forbidden");
    expect(h.lines.named("staff.audit_read_refused").slice(before)).toEqual([
      { staffId: nonReader.staffId },
      { staffId: nonReader.staffId },
    ]);
  });

  it("refuses a session presented under another Access identity", async () => {
    expect(await refused(list(viewer.browser, {}, accessFor(admin.email).sub))).toBe("forbidden");
    expect(await refused(list(viewer.browser, {}, ""))).toBe("forbidden");
  });

  it("refuses a pending member's aal1 session, an ended session and a removed member", async () => {
    const pending = await h.pendingSession(unique("audit.pending"), "admin");
    const pendingActor = await h.route(
      pending.browser,
      { method: "GET", path: "/api/audit" },
      (_tx, request, context) => requireStaff(h.realm, request, context, { reach: ["pending"] }),
    );
    expect(
      await refused(
        h.route(pending.browser, { method: "GET", path: "/api/audit" }, (tx) =>
          staffAuditLog(h.deps, tx, readerOf(pending.browser, pendingActor), { limit: 10 }),
        ),
      ),
    ).toBe("forbidden");

    const leaving = await member("viewer", "audit.leaving");
    const actor = await who(leaving.browser);
    const read = () =>
      h.route(leaving.browser, { method: "GET", path: "/api/audit" }, (tx) =>
        staffAuditLog(h.deps, tx, readerOf(leaving.browser, actor), { limit: 10 }),
      );
    expect((await read()).items.length).toBeGreaterThan(0);
    await h.fixture(
      "UPDATE staff.session SET expires_at = now() - interval '1 second' WHERE id = $1",
      [actor.sessionId],
    );
    expect(await refused(read())).toBe("forbidden");
    await h.fixture(
      "UPDATE staff.session SET expires_at = now() + interval '30 minutes' WHERE id = $1",
      [actor.sessionId],
    );
    expect((await read()).items.length).toBeGreaterThan(0);
    await h.fixture(
      "UPDATE staff.member SET status = 'removed', removed_at = now() WHERE id = $1",
      [leaving.staffId],
    );
    expect(await refused(read())).toBe("forbidden");
  });
});

describe("what fin_admin may run", () => {
  let fin: Pool;
  beforeAll(() => {
    fin = h.login("fin_admin_a", 2);
  });

  const denied = (run: Promise<unknown>) => expect(run).rejects.toMatchObject({ code: "42501" });

  it("is the two reads, never audit.event, the reader check or the filter", async () => {
    await denied(fin.query("SELECT 1 FROM audit.event"));
    await denied(fin.query("SELECT 1 FROM audit.event_context"));
    await denied(fin.query("SELECT staff.audit_reader('sts_x', 'sub')"));
    await denied(
      fin.query(
        "SELECT staff.audit_matches('staff', 'x', 'e', NULL, now(), NULL, NULL, NULL, NULL, NULL)",
      ),
    );
    // Without a working session the reads themselves refuse.
    await denied(
      fin.query(
        "SELECT * FROM staff.audit_log('sts_x', 'sub', false, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 10)",
      ),
    );
    await denied(fin.query("SELECT * FROM staff.audit_entry('sts_x', 'sub', $1)", [operatorRow]));
  });

  it("is not given to any other service", async () => {
    for (const login of ["fin_api_a", "fin_worker_a", "fin_console_a"]) {
      const pool = h.login(login, 1);
      await denied(
        pool.query(
          "SELECT * FROM staff.audit_log('sts_x', 'sub', false, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 10)",
        ),
      );
      await denied(pool.query("SELECT * FROM staff.audit_entry('sts_x', 'sub', $1)", [orgRow]));
    }
  });
});
