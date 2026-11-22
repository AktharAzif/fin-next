// Fin Admin's audit log reads on the real platform (spec 02 §14.3, §14.5, §16.4; ARCHITECTURE
// §8.6; spec 08 §3.11): the staff rows newest first with their actor, labels, chip, address and
// device; nothing of an organisation's or a person's log, by the list or by an entry's ID; paging
// both ways by cursor within its limits, with the count and a way back on a page past either end;
// the filters and the two views; the database's own re-check of the reader (the door's stand-in),
// each of whose checks refuses on its own what the guard would, even when called past it; and the
// grants as the database holds them, which leave fin_admin no way to read audit.event but the two
// reads and give them to no other login.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accessFor,
  type Browser,
  createStaffHarness,
  type StaffHarness,
  signInByCode,
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

type Member = { staffId: string; browser: Browser; email: string };

let h: StaffHarness;
let admin: Member;
let viewer: Member;
let reader: Member;
let nonReader: Member;
/** Tried by an emailed code that failed, under another Access identity and under their own. */
let tried: Member;
let personRow: string;
let orgRow: string;
let orgStaffRow: string;
let rejection: string;
let operatorRow: string;
const ORG = `org_01jd${"7".repeat(22)}`;

async function member(roleKey: string, label: string): Promise<Member> {
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

/** The two reads, called past the guard with the session the guard read for `actor`. */
function readsOf(browser: Browser, actor: StaffActor) {
  const as = readerOf(browser, actor);
  return {
    log: () =>
      h.route(browser, { method: "GET", path: "/api/audit" }, (tx) =>
        staffAuditLog(h.deps, tx, as, { limit: 10 }),
      ),
    entry: (id: string) =>
      h.route(browser, { method: "GET", path: `/api/audit/${id}` }, (tx) =>
        staffAuditEntry(h.deps, tx, as, id),
      ),
  };
}

/** Both reads answer for this reader. */
async function bothRead(browser: Browser, actor: StaffActor): Promise<void> {
  const reads = readsOf(browser, actor);
  expect((await reads.log()).items.length).toBeGreaterThan(0);
  expect((await reads.entry(operatorRow)).id).toBe(operatorRow);
}

/** Both reads refuse this reader (403 forbidden), and each refusal writes one line naming them. */
async function bothRefuse(browser: Browser, actor: StaffActor): Promise<void> {
  const reads = readsOf(browser, actor);
  const before = h.lines.named("staff.audit_read_refused").length;
  expect(await refused(reads.log())).toBe("forbidden");
  expect(await refused(reads.entry(operatorRow))).toBe("forbidden");
  expect(h.lines.named("staff.audit_read_refused").slice(before)).toEqual([
    { staffId: actor.staffId },
    { staffId: actor.staffId },
  ]);
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
  tried = await member("viewer", "audit.tried");
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

  it("answers a page past either end with the real count and a way back into the log", async () => {
    const all = (await list(admin.browser, { limit: 100 })).items.map((item) => item.id);
    const oldest = `aud_${"0".repeat(26)}`;
    const newest = `aud_${"z".repeat(26)}`;

    // Older than the oldest row: no rows, the count of every matching row, and the cursor itself
    // as the way back to the newer rows (a stale link, or rows that left a rolling window).
    const pastOldest = await list(admin.browser, { limit: 2, cursor: oldest });
    expect(pastOldest).toEqual({
      items: [],
      total: all.length,
      totalCapped: false,
      nextCursor: null,
      previousCursor: oldest,
    });
    const up = await list(admin.browser, { limit: 2, before: pastOldest.previousCursor ?? "" });
    expect(up.items.map((item) => item.id)).toEqual(all.slice(-2));

    // Newer than the newest row: the same, the way back leading to the newest rows.
    const pastNewest = await list(admin.browser, { limit: 2, before: newest });
    expect(pastNewest).toEqual({
      items: [],
      total: all.length,
      totalCapped: false,
      nextCursor: newest,
      previousCursor: null,
    });
    const down = await list(admin.browser, { limit: 2, cursor: pastNewest.nextCursor ?? "" });
    expect(down.items.map((item) => item.id)).toEqual(all.slice(0, 2));
    expect(down.previousCursor).toBeNull();

    // Nothing matching at all: no count and nowhere to go.
    expect(
      await list(admin.browser, { cursor: newest, actions: ["staff.nothing_like_this"] }),
    ).toEqual({ items: [], total: 0, totalCapped: false, nextCursor: null, previousCursor: null });
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

  it("gives a failed sign-in no verification chip: it proves nothing about the member it names", async () => {
    // Someone under another Access identity, with no session, types the member's address.
    const stranger = h.browser(accessFor(unique("audit.stranger")));
    const typed = await stranger.auth("POST", "/sign-in/email-otp", {
      email: tried.email,
      otp: "12345678",
    });
    expect(typed.status).toBe(400);
    // The member themselves, under their own Access identity, sends a wrong emailed code.
    const own = h.browser(accessFor(tried.email));
    const sent = await own.auth("POST", "/email-otp/send-verification-otp", {
      email: tried.email,
      type: "sign-in",
    });
    expect(sent.status).toBe(200);
    const code = (await h.latestCode(tried.email)) ?? "";
    const wrong = String((Number(code) + 1) % 10 ** code.length).padStart(code.length, "0");
    const signIn = await own.auth("POST", "/sign-in/email-otp", { email: tried.email, otp: wrong });
    expect(signIn.status).toBe(400);
    expect(own.sessionToken()).toBeNull();

    const failed = await list(admin.browser, {
      actions: ["staff.sign_in_failed"],
      actors: [tried.staffId],
    });
    expect(failed.items.map((item) => item.metadata.reason).sort()).toEqual([
      "access_mismatch",
      "wrong_code",
    ]);
    for (const item of failed.items) {
      expect(item).toMatchObject({ actor: { id: tried.staffId }, refs: [], verification: null });
    }
    const typedRow = failed.items.find((item) => item.metadata.reason === "access_mismatch");
    expect(typedRow?.address).toBe(stranger.ip);
  });
});

describe("the database's own check of the reader (the door's stand-in)", () => {
  // Each case's member is enrolled here, through the real ceremonies, so the cases themselves
  // only read and change fixtures (and this block's rows come after the list's exact counts).
  let pending: { staffId: string; browser: Browser };
  let leaving: Member;
  let stepping: Member;
  let locked: Member;
  let bare: Member;
  let old: Member;
  beforeAll(async () => {
    pending = await h.pendingSession(unique("audit.pending"), "admin");
    leaving = await member("viewer", "audit.leaving");
    stepping = await member("viewer", "audit.stepping");
    locked = await member("viewer", "audit.locked");
    bare = await member("viewer", "audit.bare");
    old = await member("viewer", "audit.old");
  }, 180_000);

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

  // Each check below is the only one the reader fails, so each case fails if its check goes (each
  // was run with its check taken out of the migration, and failed).

  it("refuses an active member's session held at the factor step (aal1)", async () => {
    // Signed in again by an emailed code alone, in another browser: an aal1 session, at the factor
    // step, of an active member with a passkey and a role holding audit.read.
    const browser = h.browser(accessFor(stepping.email));
    await signInByCode(h, browser, stepping.email);
    const actor = await h.route(
      browser,
      { method: "GET", path: "/api/audit" },
      (_tx, request, context) =>
        requireStaff(h.realm, request, context, { reach: ["factor_step"] }),
    );
    expect(actor).toMatchObject({ staffId: stepping.staffId, gate: "factor_step" });
    await bothRefuse(browser, actor);
    // The same member's working session still reads.
    await bothRead(stepping.browser, await who(stepping.browser));
  });

  it("refuses a session whose step-ups are locked (five failures), and not one with four", async () => {
    const actor = await who(locked.browser);
    await h.fixture("UPDATE staff.session SET step_up_failures = 4 WHERE id = $1", [
      actor.sessionId,
    ]);
    await bothRead(locked.browser, actor);
    await h.fixture("UPDATE staff.session SET step_up_failures = 5 WHERE id = $1", [
      actor.sessionId,
    ]);
    await bothRefuse(locked.browser, actor);
  });

  it("refuses an active member left with no second factor, and counts only a confirmed authenticator", async () => {
    const actor = await who(bare.browser);
    await bothRead(bare.browser, actor);
    // The session stays aal2; only the factors go.
    await h.fixture("DELETE FROM staff.passkey WHERE user_id = $1", [bare.staffId]);
    await h.fixture("DELETE FROM staff.two_factor WHERE user_id = $1", [bare.staffId]);
    await bothRefuse(bare.browser, actor);
    // An authenticator whose setup was never confirmed is no second factor; a confirmed one is.
    await h.fixture(
      `INSERT INTO staff.two_factor (id, secret, backup_codes, user_id, verified)
       VALUES ($1, 'fixture', 'fixture', $2, false)`,
      [newId("stf", { now: () => new Date() }).replace(/^stf_/, "tfa_"), bare.staffId],
    );
    await bothRefuse(bare.browser, actor);
    await h.fixture("UPDATE staff.two_factor SET verified = true WHERE user_id = $1", [
      bare.staffId,
    ]);
    await bothRead(bare.browser, actor);
  });

  it("refuses a session past its absolute lifetime by its own check, not only the table's", async () => {
    const actor = await who(old.browser);
    await bothRead(old.browser, actor);
    // The table never lets a session's expiry outlive its absolute lifetime, so the live check
    // alone would refuse any session the absolute check would.
    const pastAbsolute =
      "UPDATE staff.session SET absolute_expires_at = now() - interval '1 second' WHERE id = $1";
    expect(await refused(h.fixture(pastAbsolute, [actor.sessionId]))).toBe("23514");
    // To show the read's own check refuses it too (and still would were the table's check to go),
    // this fixture lifts the table's check while one session outlives its absolute lifetime, then
    // ends that session and puts the check back.
    await h.fixture("ALTER TABLE staff.session DROP CONSTRAINT staff_session_within_absolute");
    try {
      await h.fixture(pastAbsolute, [actor.sessionId]);
      await bothRefuse(old.browser, actor);
    } finally {
      await h.fixture(
        "UPDATE staff.session SET expires_at = absolute_expires_at WHERE id = $1 AND expires_at > absolute_expires_at",
        [actor.sessionId],
      );
      await h.fixture(
        `ALTER TABLE staff.session ADD CONSTRAINT staff_session_within_absolute
           CHECK (expires_at <= absolute_expires_at)`,
      );
    }
  });
});

describe("what fin_admin may run", () => {
  let fin: Pool;
  beforeAll(() => {
    fin = h.login("fin_admin_a", 2);
  });

  const READS = [
    "staff.audit_log(text, text, boolean, text[], text[], text[], timestamptz, timestamptz, text, text, integer)",
    "staff.audit_entry(text, text, text)",
  ];
  const HELPERS = [
    "staff.audit_reader(text, text)",
    "staff.audit_matches(text, text, text, text, timestamptz, text[], text[], text[], timestamptz, timestamptz)",
  ];

  /**
   * Refused by the grants themselves: on the object, or on its schema for a login with no use of
   * it at all. A read's own refusal of a reader is also SQLSTATE 42501, so the code alone would
   * pass with or without a grant: the message says which it was.
   */
  const denied = (run: Promise<unknown>, kind: "table" | "function") =>
    expect(run).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(new RegExp(`^permission denied for (${kind}|schema) `)),
    });

  it("is the two reads, never audit.event, the reader check or the filter", async () => {
    await denied(fin.query("SELECT 1 FROM audit.event"), "table");
    await denied(fin.query("SELECT 1 FROM audit.event_context"), "table");
    await denied(fin.query("SELECT staff.audit_reader('sts_x', 'sub')"), "function");
    await denied(
      fin.query(
        "SELECT staff.audit_matches('staff', 'x', 'e', NULL, now(), NULL, NULL, NULL, NULL, NULL)",
      ),
      "function",
    );
    // fin_admin may run the reads; without a working session they refuse on their own.
    await expect(
      fin.query(
        "SELECT * FROM staff.audit_log('sts_x', 'sub', false, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 10)",
      ),
    ).rejects.toMatchObject({
      code: "42501",
      message: "staff audit read: no working staff session",
    });
    await expect(
      fin.query("SELECT * FROM staff.audit_entry('sts_x', 'sub', $1)", [operatorRow]),
    ).rejects.toMatchObject({
      code: "42501",
      message: "staff audit read: no working staff session",
    });
  });

  it("is not given to any other service, refused by the grant before any check of the reader", async () => {
    for (const login of ["fin_api_a", "fin_worker_a", "fin_console_a", "fin_edge_a"]) {
      const pool = h.login(login, 1);
      await denied(
        pool.query(
          "SELECT * FROM staff.audit_log('sts_x', 'sub', false, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 10)",
        ),
        "function",
      );
      await denied(
        pool.query("SELECT * FROM staff.audit_entry('sts_x', 'sub', $1)", [orgRow]),
        "function",
      );
    }
  });

  it("holds EXECUTE on the reads for fin_admin alone, whatever fragment granted it", async () => {
    // Every privilege the database holds on the four functions, but their owner's.
    const acl = await h.admin.query<{ fn: string; grantee: string; privilege: string }>(
      `SELECT p.proname AS fn,
              CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
              a.privilege_type AS privilege
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE n.nspname = 'staff'
          AND p.proname IN ('audit_reader', 'audit_matches', 'audit_log', 'audit_entry')
          AND a.grantee <> p.proowner
        ORDER BY 1, 2, 3`,
    );
    expect(acl.rows).toEqual([
      { fn: "audit_entry", grantee: "fin_admin", privilege: "EXECUTE" },
      { fn: "audit_log", grantee: "fin_admin", privilege: "EXECUTE" },
    ]);
    // And through role membership: of every Fin role, only fin_admin's logins (and the owner)
    // may run a read, and only the owner the reader check or the filter.
    const roles = await h.admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname LIKE 'fin\\_%' ORDER BY rolname",
    );
    expect(roles.rows.length).toBeGreaterThan(10);
    for (const { rolname } of roles.rows) {
      for (const fn of [...READS, ...HELPERS]) {
        const held = await h.admin.query<{ held: boolean }>(
          "SELECT has_function_privilege($1, $2, 'EXECUTE') AS held",
          [rolname, fn],
        );
        const owner = rolname === "fin_owner";
        const reader = ["fin_admin", "fin_admin_a", "fin_admin_b"].includes(rolname);
        expect(held.rows[0]?.held, `${rolname} on ${fn}`).toBe(
          owner || (reader && READS.includes(fn)),
        );
      }
    }
  });
});
