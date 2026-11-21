// Custom staff roles on Postgres 18 (spec 02 §10.7, §8.4, §8.5, §10.8, §16.4, §17.3; T-SAT-23's
// staff role half): each change runs as the API half runs it (requireStaff, then the action, in
// the realm's unit of work, its intent proved with a passkey) and writes its events, its journal
// entry and its notices with it; every refusal of the editor validation, the editing and deletion
// rules, the version, the 30-role limit and the edit allowance writes nothing, and comes before any
// factor is asked for; the database refuses a role written without its event.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Browser,
  createStaffHarness,
  refusalOf,
  type SoftAuthenticator,
  type StaffHarness,
  stepped,
  unique,
} from "../test/harness.ts";
import { resolveStaffRole, staffPermissionsOf } from "./catalogue.ts";
import {
  createStaffRole,
  deleteStaffRole,
  STAFF_ROLE_EDIT_BUCKET,
  type StaffRoleDraft,
  updateStaffRole,
} from "./custom-roles.ts";
import { newId } from "./ids.ts";
import { requireStaff } from "./require-staff.ts";
import { getStaffRole, listStaffRoles } from "./roles.ts";

let h: StaffHarness;

interface Member {
  staffId: string;
  email: string;
  browser: Browser;
  authenticator: SoftAuthenticator;
}

let admin: Member;
let otherAdmin: Member;

async function enrolled(label: string, roleKey: string): Promise<Member> {
  const email = unique(label);
  const made = await h.enrolled(email, roleKey);
  return { ...made, email };
}

beforeAll(async () => {
  h = await createStaffHarness("satroles");
  admin = await enrolled("roles.admin", "admin");
  otherAdmin = await enrolled("roles.admin2", "admin");
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const MANAGE = { permission: "staffRoles.manage" } as const;

const create = (who: Member, draft: StaffRoleDraft) =>
  stepped(
    h,
    who.browser,
    who.authenticator,
    { method: "POST", path: "/api/staff-roles", body: draft },
    async (tx, req, ctx) =>
      createStaffRole(h.deps, tx, await requireStaff(h.realm, req, ctx, MANAGE), draft),
  );

const update = (who: Member, roleId: string, draft: StaffRoleDraft & { version: number }) =>
  stepped(
    h,
    who.browser,
    who.authenticator,
    { method: "PUT", path: `/api/staff-roles/${roleId}`, body: draft },
    async (tx, req, ctx) =>
      updateStaffRole(h.deps, tx, await requireStaff(h.realm, req, ctx, MANAGE), roleId, draft),
  );

const remove = (who: Member, roleId: string, body: { moveTo?: string }) =>
  stepped(
    h,
    who.browser,
    who.authenticator,
    { method: "POST", path: `/api/staff-roles/${roleId}/delete`, body },
    async (tx, req, ctx) =>
      deleteStaffRole(h.deps, tx, await requireStaff(h.realm, req, ctx, MANAGE), roleId, body),
  );

/** The first try only: a refusal that comes before any factor is asked for. */
const tryCreate = (who: Member, draft: StaffRoleDraft) =>
  refusalOf(
    h.route(who.browser, { method: "POST", path: "/api/staff-roles" }, async (tx, req, ctx) =>
      createStaffRole(h.deps, tx, await requireStaff(h.realm, req, ctx, MANAGE), draft),
    ),
  );
const tryUpdate = (who: Member, roleId: string, draft: StaffRoleDraft & { version: number }) =>
  refusalOf(
    h.route(who.browser, { method: "PUT", path: `/api/staff-roles/${roleId}` }, async (tx, r, c) =>
      updateStaffRole(h.deps, tx, await requireStaff(h.realm, r, c, MANAGE), roleId, draft),
    ),
  );
const tryDelete = (who: Member, roleId: string, body: { moveTo?: string }) =>
  refusalOf(
    h.route(
      who.browser,
      { method: "POST", path: `/api/staff-roles/${roleId}/delete` },
      async (tx, r, c) =>
        deleteStaffRole(h.deps, tx, await requireStaff(h.realm, r, c, MANAGE), roleId, body),
    ),
  );

async function count(sql: string, values: readonly unknown[] = []): Promise<number> {
  const result = await h.admin.query<{ n: number }>(
    `SELECT count(*)::integer AS n FROM (${sql}) q`,
    values,
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** What a refusal must leave untouched: roles, their permissions, events and intents. */
async function snapshot() {
  return {
    roles: await count("SELECT 1 FROM staff.role"),
    permissions: await count("SELECT 1 FROM staff.role_permission"),
    events: await count("SELECT 1 FROM audit.event"),
    intents: await count("SELECT 1 FROM ops.step_up_intent"),
    outbox: await count("SELECT 1 FROM email.outbox"),
  };
}

async function roleRow(roleId: string) {
  const result = await h.admin.query<{
    name: string;
    description: string;
    version: number;
    created_by: string;
  }>("SELECT name, description, version, created_by FROM staff.role WHERE id = $1", [roleId]);
  const permissions = await h.admin.query<{ permission: string }>(
    "SELECT permission FROM staff.role_permission WHERE role_id = $1 ORDER BY permission",
    [roleId],
  );
  return result.rows[0] === undefined
    ? undefined
    : { ...result.rows[0], permissions: permissions.rows.map((r) => r.permission) };
}

const draft = (name: string, permissions: string[], description = ""): StaffRoleDraft => ({
  name,
  description,
  permissions,
});

describe("making a custom staff role (§10.7, §8.4)", () => {
  it("stores the draft, writes staff.role_created with the intent and request, and lists it", async () => {
    const made = await create(
      admin,
      draft("Support desk", ["rfis.read", "customers.read"], "  Answers   questions.  "),
    );
    expect(made).toEqual({ roleId: expect.stringMatching(/^srl_/), version: 1 });
    expect(await roleRow(made.roleId)).toEqual({
      name: "Support desk",
      // Stored as it is checked: trimmed, one space between words.
      description: "Answers questions.",
      version: 1,
      created_by: admin.staffId,
      permissions: ["customers.read", "rfis.read"],
    });
    const [event] = await h
      .events("staff.role_created")
      .then((rows) => rows.filter((e) => e.target_id === made.roleId));
    expect(event).toMatchObject({
      actor_kind: "staff",
      actor_id: admin.staffId,
      actor_via: "admin",
      step_up_kind: "intent",
      db_login: "fin_admin_a",
      // The catalogue's order, and never the typed name or description.
      metadata: { permissions: ["customers.read", "rfis.read"] },
    });
    expect(event?.step_up_ref).toMatch(/^sti_/);
    expect(JSON.stringify(event)).not.toContain("Support");
    expect(h.lines.named("staff.changed").at(-1)).toEqual({
      kind: "role_created",
      roleId: made.roleId,
      actorId: admin.staffId,
    });

    const listed = await h.db.unit((tx) => listStaffRoles(tx));
    expect(listed.slice(0, 4).map((r) => [r.key, r.builtIn])).toEqual([
      ["viewer", true],
      ["compliance", true],
      ["operator", true],
      ["admin", true],
    ]);
    expect(listed.find((r) => r.key === made.roleId)).toEqual({
      key: made.roleId,
      kind: "custom",
      builtIn: false,
      label: "Support desk",
      description: "Answers questions.",
      summary: "Answers questions.",
      topRole: false,
      holders: 0,
      permissions: ["customers.read", "rfis.read"],
      permissionCount: 2,
      version: 1,
    });
    const detail = await h.db.unit((tx) => getStaffRole(tx, made.roleId));
    expect(detail.groups.flatMap((g) => g.permissions).filter((p) => p.held)).toHaveLength(2);
  });

  it("refuses every draft the editor refuses, before any factor is asked for, writing nothing", async () => {
    await create(admin, draft("Reviewers", ["customers.read"]));
    const before = await snapshot();
    const cases: [StaffRoleDraft, string, Record<string, unknown>][] = [
      [
        draft("Admins", ["customers.read"]),
        "invalid",
        { fields: [{ path: "name", code: "reads_as_built_in" }] },
      ],
      // "Admin" with a Cyrillic capital A: mixed scripts, and it reads as the prebuilt role.
      [
        draft("\u0410dmin", ["customers.read"]),
        "invalid",
        {
          fields: [
            { path: "name", code: "name" },
            { path: "name", code: "reads_as_built_in" },
          ],
        },
      ],
      [
        draft("REVIEWERS", ["customers.read"]),
        "invalid",
        { fields: [{ path: "name", code: "name_taken" }] },
      ],
      [
        draft("see example.com", ["customers.read"]),
        "invalid",
        { fields: [{ path: "name", code: "name" }] },
      ],
      [draft("Nobody", []), "invalid", { fields: [{ path: "permissions", code: "empty" }] }],
      [
        draft("Recoverers", ["organisations.read", "accounts.recover"]),
        "invalid",
        { fields: [{ path: "permissions", code: "restricted" }] },
      ],
      [
        draft("Handlers", ["rfis.manage"]),
        "invalid",
        { fields: [{ path: "permissions", code: "missing_need" }] },
      ],
      [
        draft("Too long", ["customers.read"], "x".repeat(121)),
        "invalid",
        { fields: [{ path: "description", code: "description" }] },
      ],
      [
        draft("Strangers", ["customers.read", "everything.do"]),
        "giving_refused",
        { problem: "beyond" },
      ],
    ];
    for (const [input, code, extensions] of cases) {
      const refused = await tryCreate(admin, input);
      expect(refused.code, input.name).toBe(code);
      expect(refused.extensions, input.name).toMatchObject(extensions);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("is only for someone who holds staffRoles.manage, which no custom role can hold", async () => {
    const wide = await h.seedCustomRole("Wide reviewers", [
      "customers.read",
      "staff.read",
      "staff.add",
      "staffRoles.manage",
    ]);
    const holder = await enrolled("roles.wide", wide);
    const operator = await enrolled("roles.operator", "operator");
    const before = await snapshot();
    for (const who of [holder, operator]) {
      const refused = await tryCreate(who, draft("Mine", ["customers.read"]));
      expect(refused).toMatchObject({
        code: "forbidden",
        extensions: { permission: "staffRoles.manage" },
      });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a 31st role with 409 limit_reached", async () => {
    const existing = await count("SELECT 1 FROM staff.role");
    const seeded: string[] = [];
    for (let n = existing; n < 30; n += 1) {
      seeded.push(
        await h.seedCustomRole(`Filler ${String.fromCharCode(97 + (n % 26))}${n}`, [
          "customers.read",
        ]),
      );
    }
    try {
      const before = await snapshot();
      const refused = await tryCreate(admin, draft("One too many", ["customers.read"]));
      expect(refused).toEqual({ code: "limit_reached", extensions: { limit: 30 } });
      expect(await snapshot()).toEqual(before);
    } finally {
      await h.fixture("DELETE FROM staff.role WHERE id = ANY($1::text[])", [seeded]);
    }
  });

  it("serialises two Admins making the same name: one role, and the other told the name is taken", async () => {
    const body = draft("Night shift", ["customers.read"]);
    const intentFor = async (who: Member) => {
      const first = await tryCreate(who, body);
      expect(first.code).toBe("step_up_required");
      const intent = String(first.extensions.intent_id);
      expect((await h.prove(who.browser, who.authenticator, intent)).status).toBe(200);
      return intent;
    };
    const [a, b] = [await intentFor(admin), await intentFor(otherAdmin)];
    const run = (who: Member, intent: string) =>
      h.route(
        who.browser,
        { method: "POST", path: "/api/staff-roles", intent },
        async (tx, req, ctx) =>
          createStaffRole(h.deps, tx, await requireStaff(h.realm, req, ctx, MANAGE), body),
      );
    const results = await Promise.allSettled([run(admin, a), run(otherAdmin, b)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({
      code: "invalid",
      extensions: { fields: [{ path: "name", code: "name_taken" }] },
    });
    expect(await count("SELECT 1 FROM staff.role WHERE lower(name) = 'night shift'")).toBe(1);
  });

  it("counts the edit allowance once the change goes ahead, and refuses past it with nothing written", async () => {
    const now = Date.now();
    const hour = 3_600_000;
    const day = 24 * hour;
    const windows = [
      [hour, 30],
      [day, 100],
    ] as const;
    for (const [ms, max] of windows) {
      await h.fixture(
        `INSERT INTO ops.rate_window (key, window_start, count) VALUES ($1, $2, $3)
         ON CONFLICT (key, window_start) DO UPDATE SET count = EXCLUDED.count`,
        [
          `${STAFF_ROLE_EDIT_BUCKET}:${ms}:${otherAdmin.staffId}`,
          new Date(Math.floor(now / ms) * ms),
          max,
        ],
      );
    }
    try {
      const body = draft("Over the limit", ["customers.read"]);
      const first = await tryCreate(otherAdmin, body);
      expect(first.code).toBe("step_up_required");
      const intent = String(first.extensions.intent_id);
      expect((await h.prove(otherAdmin.browser, otherAdmin.authenticator, intent)).status).toBe(
        200,
      );
      const roles = await count("SELECT 1 FROM staff.role");
      const refused = await refusalOf(
        h.route(
          otherAdmin.browser,
          { method: "POST", path: "/api/staff-roles", intent },
          async (tx, req, ctx) =>
            createStaffRole(h.deps, tx, await requireStaff(h.realm, req, ctx, MANAGE), body),
        ),
      );
      expect(refused.code).toBe("rate_limited");
      expect(Number(refused.extensions.retry_after)).toBeGreaterThan(0);
      expect(await count("SELECT 1 FROM staff.role")).toBe(roles);
      // The whole unit rolled back, the intent's spending with it.
      expect(
        await count("SELECT 1 FROM ops.step_up_intent WHERE id = $1 AND consumed_at IS NULL", [
          intent,
        ]),
      ).toBe(1);
    } finally {
      await h.fixture("DELETE FROM ops.rate_window WHERE key LIKE $1", [
        `${STAFF_ROLE_EDIT_BUCKET}:%:${otherAdmin.staffId}`,
      ]);
    }
  });
});

describe("changing a custom staff role (§8.4)", () => {
  it("saves a new version, journals what it took away, tells holders and Admins, and applies on the next request", async () => {
    const made = await create(
      admin,
      draft("Case handlers", ["customers.read", "rfis.read", "rfis.manage"]),
    );
    const holder = await enrolled("roles.holder", made.roleId);
    // The holder may handle requests for information now.
    const canNow = async () => {
      const role = await h.db.unit(async (tx) => resolveStaffRole(tx, made.roleId));
      return staffPermissionsOf(role);
    };
    expect((await canNow()).has("rfis.manage")).toBe(true);
    const handles = () =>
      refusalOf(
        h.route(holder.browser, { method: "GET", path: "/api/staff" }, async (_tx, req, ctx) =>
          requireStaff(h.realm, req, ctx, { permission: "rfis.manage" }),
        ),
      );
    expect((await handles()).code).toBe("none");

    const saved = await update(admin, made.roleId, {
      ...draft("Case handlers", ["customers.read", "rfis.read", "organisations.read"]),
      version: 1,
    });
    expect(saved).toEqual({ roleId: made.roleId, version: 2, holders: 1, added: 1, removed: 1 });
    expect(await roleRow(made.roleId)).toMatchObject({
      version: 2,
      permissions: ["customers.read", "organisations.read", "rfis.read"],
    });
    const [event] = (await h.events("staff.role_updated")).filter(
      (e) => e.target_id === made.roleId,
    );
    expect(event).toMatchObject({
      actor_id: admin.staffId,
      step_up_kind: "intent",
      metadata: {
        added: ["organisations.read"],
        removed: ["rfis.manage"],
        holders: 1,
        renamed: false,
      },
    });
    const journal = await h.admin.query<{ kind: string }>(
      "SELECT kind FROM audit.journal_entry WHERE audit_event_id = $1",
      [event?.id],
    );
    expect(journal.rows).toEqual([{ kind: "staff_role_lowered" }]);
    const notices = (await h.outbox("staff/staff-role-permissions-changed")).map(
      (n) => n.recipient,
    );
    expect(notices.sort()).toEqual([admin.email, otherAdmin.email, holder.email].sort());
    expect(h.lines.named("staff.changed").at(-1)).toEqual({
      kind: "role_updated",
      roleId: made.roleId,
      actorId: admin.staffId,
      lowered: true,
    });
    // Taken away on the holder's next request, with their session still live.
    expect(await handles()).toMatchObject({
      code: "forbidden",
      extensions: { permission: "rfis.manage" },
    });
  });

  it("renames without a journal entry or a notice", async () => {
    const made = await create(admin, draft("Onboarding", ["golive.read"]));
    const notices = (await h.outbox("staff/staff-role-permissions-changed")).length;
    await update(admin, made.roleId, { ...draft("Go-live desk", ["golive.read"]), version: 1 });
    const [event] = (await h.events("staff.role_updated")).filter(
      (e) => e.target_id === made.roleId,
    );
    expect(event?.metadata).toEqual({ added: [], removed: [], holders: 0, renamed: true });
    expect(
      await count("SELECT 1 FROM audit.journal_entry WHERE audit_event_id = $1", [event?.id]),
    ).toBe(0);
    expect((await h.outbox("staff/staff-role-permissions-changed")).length).toBe(notices);
    expect((await roleRow(made.roleId))?.name).toBe("Go-live desk");
  });

  it("refuses a stale version, a prebuilt role, an unknown role and a draft the editor refuses, writing nothing", async () => {
    const made = await create(admin, draft("Money watchers", ["money.read"]));
    await update(admin, made.roleId, {
      ...draft("Money watchers", ["money.read", "audit.read"]),
      version: 1,
    });
    const before = await snapshot();
    const stale = await tryUpdate(admin, made.roleId, {
      ...draft("Money watchers", ["money.read"]),
      version: 1,
    });
    expect(stale.code).toBe("conflict");
    for (const key of ["viewer", "admin", newId("srl", { now: () => new Date() })]) {
      const refused = await tryUpdate(admin, key, {
        ...draft("Anything", ["money.read"]),
        version: 1,
      });
      expect(refused.code, key).toBe("not_found");
    }
    const taken = await tryUpdate(admin, made.roleId, {
      ...draft("Support desk", ["money.read"]),
      version: 2,
    });
    expect(taken).toMatchObject({
      code: "invalid",
      extensions: { fields: [{ path: "name", code: "name_taken" }] },
    });
    // An Admin-only permission, without what it needs: both said, on the permissions field.
    const restricted = await tryUpdate(admin, made.roleId, {
      ...draft("Money watchers", ["money.read", "staff.reset_factors"]),
      version: 2,
    });
    expect(restricted).toEqual({
      code: "invalid",
      extensions: {
        fields: [
          { path: "permissions", code: "restricted" },
          { path: "permissions", code: "missing_need" },
        ],
      },
    });
    expect(await snapshot()).toEqual(before);
    // Its own name, unchanged, is not "taken" by itself.
    const same = await tryUpdate(admin, made.roleId, {
      ...draft("Money watchers", ["money.read"]),
      version: 2,
    });
    expect(same.code).toBe("step_up_required");
  });
});

describe("deleting a custom staff role (§8.4)", () => {
  it("moves every holder to the role chosen, ending their sessions, with their events and notices", async () => {
    const made = await create(admin, draft("Temporary", ["customers.read", "customers.reveal"]));
    const holder = await enrolled("roles.temp", made.roleId);
    const pendingId = await h.seedMember(unique("roles.temp.pending"), made.roleId, "pending");
    const sessions = await count("SELECT 1 FROM staff.session WHERE user_id = $1", [
      holder.staffId,
    ]);
    expect(sessions).toBeGreaterThan(0);

    const result = await remove(admin, made.roleId, { moveTo: "viewer" });
    expect(result).toEqual({ roleId: made.roleId, movedTo: "viewer", membersMoved: 2 });
    expect(await roleRow(made.roleId)).toBeUndefined();
    expect(
      await count("SELECT 1 FROM staff.role_permission WHERE role_id = $1", [made.roleId]),
    ).toBe(0);
    const roles = await h.admin.query<{ id: string; role_key: string }>(
      "SELECT id, role_key FROM staff.member WHERE id = ANY($1::text[]) ORDER BY id",
      [[holder.staffId, pendingId]],
    );
    expect(roles.rows.map((r) => r.role_key)).toEqual(["viewer", "viewer"]);
    expect(await count("SELECT 1 FROM staff.session WHERE user_id = $1", [holder.staffId])).toBe(0);

    const moved = (await h.events("staff.role_changed")).filter((e) =>
      e.ref_ids.includes(made.roleId),
    );
    expect(moved.map((e) => e.target_id).sort()).toEqual([holder.staffId, pendingId].sort());
    for (const event of moved) {
      expect(event).toMatchObject({
        step_up_kind: "intent",
        metadata: {
          fromRole: made.roleId,
          toRole: "viewer",
          reason: "role_deleted",
          lowered: true,
        },
      });
      // A lowered holder is journalled (spec 08 §3.10).
      expect(
        await count(
          "SELECT 1 FROM audit.journal_entry WHERE audit_event_id = $1 AND kind = 'staff_role_lowered'",
          [event.id],
        ),
      ).toBe(1);
    }
    const [deleted] = (await h.events("staff.role_deleted")).filter(
      (e) => e.target_id === made.roleId,
    );
    expect(deleted?.metadata).toEqual({ movedTo: "viewer", membersMoved: 2 });
    const notices = (await h.outbox("staff/staff-access-changed")).filter(
      (n) => n.params.staffId === holder.staffId && n.params.kind === "role_changed",
    );
    expect(notices.map((n) => [n.recipient, n.params.audience]).sort()).toEqual(
      [
        [admin.email, "admins"],
        [otherAdmin.email, "admins"],
        [holder.email, "person"],
      ].sort(),
    );
    // The moved holder's next request finds no session.
    const next = await refusalOf(
      h.route(holder.browser, { method: "GET", path: "/api/staff" }, async (_tx, req, ctx) =>
        requireStaff(h.realm, req, ctx, { permission: "staff.read" }),
      ),
    );
    expect(next.code).toBe("unauthenticated");
  });

  it("deletes a role nobody holds without a move", async () => {
    const made = await create(admin, draft("Unused", ["audit.read"]));
    expect(await remove(admin, made.roleId, {})).toEqual({
      roleId: made.roleId,
      movedTo: null,
      membersMoved: 0,
    });
    const [deleted] = (await h.events("staff.role_deleted")).filter(
      (e) => e.target_id === made.roleId,
    );
    expect(deleted?.metadata).toEqual({ movedTo: null, membersMoved: 0 });
  });

  it("refuses a missing, unknown or same move, a prebuilt or unknown role, writing nothing", async () => {
    const made = await create(admin, draft("Held role", ["organisations.read"]));
    await h.seedMember(unique("roles.held"), made.roleId, "active");
    const before = await snapshot();
    expect(await tryDelete(admin, made.roleId, {})).toMatchObject({
      code: "giving_refused",
      extensions: { problem: "move_required" },
    });
    expect(await tryDelete(admin, made.roleId, { moveTo: made.roleId })).toMatchObject({
      code: "giving_refused",
      extensions: { problem: "unchanged" },
    });
    expect(
      await tryDelete(admin, made.roleId, { moveTo: newId("srl", { now: () => new Date() }) }),
    ).toMatchObject({ code: "giving_refused", extensions: { problem: "gone" } });
    expect(await tryDelete(admin, made.roleId, { moveTo: "superuser" })).toMatchObject({
      code: "giving_refused",
      extensions: { problem: "unknown_role" },
    });
    for (const key of ["operator", newId("srl", { now: () => new Date() })]) {
      expect((await tryDelete(admin, key, { moveTo: "viewer" })).code, key).toBe("not_found");
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe("the database guard on staff roles (§13.8, [AU-02])", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = h.login("fin_admin_a", 2);
  });

  async function commit(statements: [string, unknown[]][]): Promise<string | null> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const [text, values] of statements) await client.query(text, values);
      await client.query("COMMIT");
      return null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      return (error as { code?: string }).code ?? "error";
    } finally {
      client.release();
    }
  }

  const event = (name: string, target: string): [string, unknown[]] => [
    "SELECT audit.record($1::jsonb)",
    [
      JSON.stringify({
        id: newId("aud", { now: () => new Date() }),
        event: name,
        actor_kind: "staff",
        actor_id: admin.staffId,
        actor_via: "admin",
        target_id: target,
        ref_ids: [],
        metadata: name === "staff.role_created" ? { permissions: ["audit.read"] } : {},
        release: "test",
      }),
    ],
  ];

  it("refuses a role, its permissions, a change or a deletion with no event naming it, and takes them with one", async () => {
    const roleId = newId("srl", { now: () => new Date() });
    const insert: [string, unknown[]] = [
      "INSERT INTO staff.role (id, name, description, created_by) VALUES ($1, 'Quiet role', '', $2)",
      [roleId, admin.staffId],
    ];
    const grant: [string, unknown[]] = [
      "INSERT INTO staff.role_permission (role_id, permission) VALUES ($1, 'audit.read')",
      [roleId],
    ];
    expect(await commit([insert])).toBe("FA010");
    expect(await commit([insert, grant])).toBe("FA010");
    expect(await commit([insert, grant, event("staff.role_created", roleId)])).toBeNull();
    expect(
      await commit([
        [
          "INSERT INTO staff.role_permission (role_id, permission) VALUES ($1, 'golive.read')",
          [roleId],
        ],
      ]),
    ).toBe("FA010");
    expect(
      await commit([["UPDATE staff.role SET name = 'Renamed quietly' WHERE id = $1", [roleId]]]),
    ).toBe("FA010");
    expect(await commit([["DELETE FROM staff.role WHERE id = $1", [roleId]]])).toBe("FA010");
    expect(await roleRow(roleId)).toMatchObject({
      name: "Quiet role",
      permissions: ["audit.read"],
    });
  });
});
