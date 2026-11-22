// Custom staff roles on Postgres 18 (spec 02 §10.7, §8.4, §8.5, §10.8, §16.4, §17.3; T-SAT-23's
// staff role half): each change runs as the API half runs it (requireStaff, then the action, in
// the realm's unit of work, its intent proved with a passkey) and writes its events, its journal
// entry and its notices with it; every refusal of the editor validation, the name index, the
// editing and deletion rules, the version, the holders a deletion was shown, the 30-role limit and
// the edit allowance writes nothing, and comes before any factor is asked for (the allowance and
// the holders after it as well); a role is read whole; the database refuses a role written
// without its event.
import { type StaffPermission, staffCatalogue } from "@fin/access";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  checkStaffRoleDraft,
  createStaffRole,
  deleteStaffRole,
  nameTakenRefusal,
  STAFF_ROLE_EDIT_BUCKET,
  type StaffRoleDraft,
  updateStaffRole,
} from "./custom-roles.ts";
import { newId } from "./ids.ts";
import { addStaff } from "./members.ts";
import type { UnitTx } from "./ports.ts";
import { requireStaff, type StaffActor } from "./require-staff.ts";
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

// Every test proves intents from one test address, more passkey ceremonies than a person makes in
// a minute: each test starts with that address's passkey allowance (§5.6) anew.
beforeEach(async () => {
  await h.fixture("DELETE FROM ops.rate_window WHERE key LIKE 'passkey_options:%'");
});

const MANAGE = { permission: "staffRoles.manage" } as const;

/** Every staff permission: an Admin's, for the editor's own checks. */
const ALL = new Set<StaffPermission>(staffCatalogue.keys);

/** The holders AdminRoles shows for a role (the list's `holderIds`), which a deletion sends. */
async function shown(roleId: string): Promise<string[]> {
  const roles = await h.db.unit((tx) => listStaffRoles(tx));
  return roles.find((r) => r.key === roleId)?.holderIds ?? [];
}

interface DeleteBody {
  moveTo?: string;
  /** The holders the deletion names; by default those the list shows now. */
  holders?: string[];
}

async function deletion(roleId: string, body: DeleteBody) {
  return { ...body, holders: body.holders ?? (await shown(roleId)) };
}

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

const remove = async (who: Member, roleId: string, input: DeleteBody) => {
  const body = await deletion(roleId, input);
  return stepped(
    h,
    who.browser,
    who.authenticator,
    { method: "POST", path: `/api/staff-roles/${roleId}/delete`, body },
    async (tx, req, ctx) =>
      deleteStaffRole(h.deps, tx, await requireStaff(h.realm, req, ctx, MANAGE), roleId, body),
  );
};

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
const tryDelete = async (who: Member, roleId: string, input: DeleteBody) => {
  const body = await deletion(roleId, input);
  return refusalOf(
    h.route(
      who.browser,
      { method: "POST", path: `/api/staff-roles/${roleId}/delete` },
      async (tx, r, c) =>
        deleteStaffRole(h.deps, tx, await requireStaff(h.realm, r, c, MANAGE), roleId, body),
    ),
  );
};

/** One try of a stepped-up route, with an intent once there is one: the first asks for a factor. */
const attempt = <T>(
  who: Member,
  request: { method: string; path: string },
  run: (tx: UnitTx, actor: StaffActor) => Promise<T>,
  intent?: string,
) =>
  refusalOf(
    h.route(
      who.browser,
      { ...request, ...(intent === undefined ? {} : { intent }) },
      async (tx, r, c) => run(tx, await requireStaff(h.realm, r, c, MANAGE)),
    ),
  );

/** Asks for the route's intent with a first try and proves it; returns the intent's ID. */
async function provedIntent(
  who: Member,
  first: () => Promise<{ code: string; extensions: Record<string, unknown> }>,
): Promise<string> {
  const asked = await first();
  expect(asked.code).toBe("step_up_required");
  const intent = String(asked.extensions.intent_id);
  expect((await h.prove(who.browser, who.authenticator, intent)).status).toBe(200);
  return intent;
}

/** Fills a person's role edit allowance, both windows (§8.4: 30 an hour, 100 a day). */
async function fillAllowance(staffId: string): Promise<void> {
  const now = Date.now();
  for (const [ms, max] of [
    [3_600_000, 30],
    [86_400_000, 100],
  ] as const) {
    await h.fixture(
      `INSERT INTO ops.rate_window (key, window_start, count) VALUES ($1, $2, $3)
       ON CONFLICT (key, window_start) DO UPDATE SET count = EXCLUDED.count`,
      [`${STAFF_ROLE_EDIT_BUCKET}:${ms}:${staffId}`, new Date(Math.floor(now / ms) * ms), max],
    );
  }
}

async function clearAllowance(staffId: string): Promise<void> {
  await h.fixture("DELETE FROM ops.rate_window WHERE key LIKE $1", [
    `${STAFF_ROLE_EDIT_BUCKET}:%:${staffId}`,
  ]);
}

async function unspent(intent: string): Promise<boolean> {
  return (
    (await count("SELECT 1 FROM ops.step_up_intent WHERE id = $1 AND consumed_at IS NULL", [
      intent,
    ])) === 1
  );
}

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
      holderIds: [],
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
    await fillAllowance(otherAdmin.staffId);
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
      expect(await unspent(intent)).toBe(true);
    } finally {
      await clearAllowance(otherAdmin.staffId);
    }
  });

  it("counts a save and a deletion against the same allowance, refusing each past it with the role untouched and the intent unspent", async () => {
    const kept = await create(otherAdmin, draft("Allowance check", ["customers.read"]));
    const spare = await create(otherAdmin, draft("Allowance spare", ["audit.read"]));
    const save = { ...draft("Allowance check", ["customers.read", "audit.read"]), version: 1 };
    const changes: {
      label: string;
      request: { method: string; path: string };
      run: (tx: UnitTx, actor: StaffActor) => Promise<unknown>;
    }[] = [
      {
        label: "save",
        request: { method: "PUT", path: `/api/staff-roles/${kept.roleId}` },
        run: (tx: UnitTx, actor: StaffActor) =>
          updateStaffRole(h.deps, tx, actor, kept.roleId, save),
      },
      {
        label: "delete",
        request: { method: "POST", path: `/api/staff-roles/${spare.roleId}/delete` },
        run: (tx: UnitTx, actor: StaffActor) =>
          deleteStaffRole(h.deps, tx, actor, spare.roleId, { holders: [] }),
      },
    ];
    await fillAllowance(otherAdmin.staffId);
    try {
      for (const change of changes) {
        const intent = await provedIntent(otherAdmin, () =>
          attempt(otherAdmin, change.request, change.run),
        );
        const before = await snapshot();
        const refused = await attempt(otherAdmin, change.request, change.run, intent);
        expect(refused.code, change.label).toBe("rate_limited");
        expect(Number(refused.extensions.retry_after), change.label).toBeGreaterThan(0);
        expect(await snapshot(), change.label).toEqual(before);
        expect(await unspent(intent), change.label).toBe(true);
      }
      expect(await roleRow(kept.roleId)).toMatchObject({
        version: 1,
        permissions: ["customers.read"],
      });
      expect(await roleRow(spare.roleId)).toMatchObject({ version: 1 });
    } finally {
      await clearAllowance(otherAdmin.staffId);
    }
  });

  it("refuses a name the database's name index holds for another role, even one the editor tells apart, before any factor is asked for", async (ctx) => {
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
    expect(() =>
      checkStaffRoleDraft(ALL, draft(dotted, ["customers.read"]), ["Info desk"]),
    ).not.toThrow();
    await create(admin, draft("Info desk", ["customers.read"]));
    const renamed = await create(admin, draft("Help desk", ["customers.read"]));
    const before = await snapshot();
    const taken = {
      code: "invalid",
      extensions: { fields: [{ path: "name", code: "name_taken" }] },
    };
    expect(await tryCreate(admin, draft(dotted, ["customers.read"]))).toEqual(taken);
    expect(
      await tryUpdate(admin, renamed.roleId, { ...draft(dotted, ["customers.read"]), version: 1 }),
    ).toEqual(taken);
    expect(await snapshot()).toEqual(before);
  });

  it("answers the name index's own refusal as the editor's name_taken, should a write ever reach it", async () => {
    const seeded = await h.seedCustomRole("Backstop role", ["audit.read"]);
    let refused: unknown;
    try {
      await h.fixture(
        "INSERT INTO staff.role (id, name, description, created_by) VALUES ($1, 'BACKSTOP ROLE', '', $2)",
        [newId("srl", { now: () => new Date() }), admin.staffId],
      );
    } catch (error) {
      refused = error;
    } finally {
      await h.fixture("DELETE FROM staff.role WHERE id = $1", [seeded]);
    }
    expect(refused).toMatchObject({ code: "23505", constraint: "staff_role_name" });
    expect(nameTakenRefusal(refused)).toMatchObject({
      code: "invalid",
      status: 400,
      lineReason: "staff_role.name_taken",
      extensions: { fields: [{ path: "name", code: "name_taken" }] },
    });
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

describe("reading a custom staff role (§10.7, §8.4)", () => {
  it("answers one save's name, permissions, description and version even while another Admin saves, so a save from it is stale", async () => {
    const made = await create(
      admin,
      draft("Case readers", ["customers.read", "customers.reveal", "documents.view"], "First."),
    );
    // A read whose first statement on the role is followed at once by another Admin's save, which
    // commits before the read goes on.
    let raced = false;
    const racing = {
      async query(text: string, values?: readonly unknown[]) {
        const result = await h.admin.query(text, values);
        if (!raced && /\bstaff\.role\b/.test(text)) {
          raced = true;
          await update(otherAdmin, made.roleId, {
            ...draft("Case readers", ["customers.read"], "Second."),
            version: 1,
          });
        }
        return result;
      },
    } as unknown as UnitTx;
    const detail = await getStaffRole(racing, made.roleId);
    expect(raced).toBe(true);
    expect({
      label: detail.label,
      description: detail.description,
      summary: detail.summary,
      permissions: detail.permissions,
      held: detail.groups.flatMap((g) => g.permissions.filter((p) => p.held).map((p) => p.key)),
      version: detail.version,
    }).toEqual({
      label: "Case readers",
      description: "First.",
      summary: "First.",
      permissions: ["customers.read", "customers.reveal", "documents.view"],
      held: ["customers.read", "customers.reveal", "documents.view"],
      version: 1,
    });
    // The editor's save from that answer names the version it was read at, and is stale: what the
    // other Admin took away does not come back.
    const stale = await tryUpdate(admin, made.roleId, {
      ...draft(detail.label, detail.permissions, "Changed."),
      version: detail.version ?? 0,
    });
    expect(stale.code).toBe("conflict");
    expect(await roleRow(made.roleId)).toMatchObject({
      version: 2,
      description: "Second.",
      permissions: ["customers.read"],
    });
  });

  it("answers a prebuilt role with no version, and a key that names nothing as not found", async () => {
    const operator = await h.db.unit((tx) => getStaffRole(tx, "operator"));
    expect(operator).toMatchObject({
      key: "operator",
      kind: "prebuilt",
      builtIn: true,
      version: null,
    });
    for (const key of ["superuser", newId("srl", { now: () => new Date() })]) {
      expect(await refusalOf(h.db.unit((tx) => getStaffRole(tx, key))), key).toEqual({
        code: "not_found",
        extensions: {},
      });
    }
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

  it("moves only the holders the Admin was shown: someone given the role after the proof is a conflict, and the intent binds them", async () => {
    const leads = await create(
      admin,
      draft("Team leads", ["staff.read", "staff.add", "audit.read"]),
    );
    const auditors = await create(admin, draft("Auditors", ["audit.read"]));
    const lead = await enrolled("roles.lead", leads.roleId);
    const first = await h.seedMember(unique("roles.auditor"), auditors.roleId, "pending");
    // The dialog shows one holder, and the deletion names them.
    const holders = await shown(auditors.roleId);
    expect(holders).toEqual([first]);
    const request = { method: "POST", path: `/api/staff-roles/${auditors.roleId}/delete` };
    const deleting =
      (body: { moveTo: string; holders: string[] }) => (tx: UnitTx, actor: StaffActor) =>
        deleteStaffRole(h.deps, tx, actor, auditors.roleId, body);
    const asked = { moveTo: "admin", holders };
    const intent = await provedIntent(admin, () => attempt(admin, request, deleting(asked)));

    // Meanwhile a team lead, who may give Auditors but never Admin, gives Auditors to someone new.
    const addAs = (email: string, roleKey: string) =>
      stepped(
        h,
        lead.browser,
        lead.authenticator,
        { method: "POST", path: "/api/staff", body: { email, roleKey } },
        async (tx, req, ctx) =>
          addStaff(h.deps, tx, await requireStaff(h.realm, req, ctx, { permission: "staff.add" }), {
            email,
            roleKey,
          }),
      );
    expect(await refusalOf(addAs(unique("roles.climber"), "admin"))).toMatchObject({
      code: "giving_refused",
      extensions: { problem: "top_only" },
    });
    const added = await addAs(unique("roles.newcomer"), auditors.roleId);

    // The Admin's proved re-send: the role's holders are not those shown, so nobody moves.
    const before = await snapshot();
    expect(await attempt(admin, request, deleting(asked), intent)).toEqual({
      code: "conflict",
      extensions: {},
    });
    // Naming the holders there are now does not fit the intent proved for the one shown.
    const now = await shown(auditors.roleId);
    expect(now.sort()).toEqual([first, added.staffId].sort());
    expect(
      await attempt(admin, request, deleting({ moveTo: "admin", holders: now }), intent),
    ).toEqual({ code: "step_up_invalid", extensions: { reason: "digest" } });
    expect(await snapshot()).toEqual(before);
    expect(await unspent(intent)).toBe(true);
    const roles = await h.admin.query<{ role_key: string }>(
      "SELECT role_key FROM staff.member WHERE id = ANY($1::text[])",
      [[first, added.staffId]],
    );
    expect(roles.rows.map((r) => r.role_key)).toEqual([auditors.roleId, auditors.roleId]);

    // Shown both, the Admin proves a factor for both, and both move.
    expect(await remove(admin, auditors.roleId, { moveTo: "admin" })).toEqual({
      roleId: auditors.roleId,
      movedTo: "admin",
      membersMoved: 2,
    });
  });

  it("refuses a deletion naming holders the role does not have, before any factor is asked for", async () => {
    const made = await create(admin, draft("Quiet watchers", ["audit.read"]));
    const holder = await h.seedMember(unique("roles.quiet"), made.roleId, "pending");
    const stranger = await h.seedMember(unique("roles.stranger"), "viewer", "pending");
    const before = await snapshot();
    for (const holders of [[], [stranger], [holder, stranger]]) {
      expect(await tryDelete(admin, made.roleId, { moveTo: "viewer", holders })).toEqual({
        code: "conflict",
        extensions: {},
      });
    }
    expect(await snapshot()).toEqual(before);
    // The same holder named twice is still the one holder.
    expect(
      (await tryDelete(admin, made.roleId, { moveTo: "viewer", holders: [holder, holder] })).code,
    ).toBe("step_up_required");
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
