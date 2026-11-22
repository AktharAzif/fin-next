// Custom staff roles through Fin Admin's API half (spec 02 §10.7, §14.3, §8.4; stretch 3), as the
// admin tunnel reaches it: the Access token, the origin gate, the staff realm and the route policy,
// on the real platform. An Admin lists the four prebuilt roles, makes a custom role with an intent,
// gives it to a member, changes it (a stale save is a conflict, and so is a save adding a
// permission that names other holders than the role's), and deletes it with the member moved,
// naming the holders the list showed (others are a conflict); every refusal is a problem document
// naming its code and never the value (a name the database's index holds, or one the database
// cannot store, never an internal error), and every answer is what the AdminRoles and
// AdminRoleEditor screens read.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaffHarness,
  type StaffHarness,
  unique,
} from "../../../../packages/staff/test/index.ts";
import {
  type AdminHost,
  createAdminHost,
  enrolThroughHost,
  type HostMember,
} from "../../test/host.ts";

let h: StaffHarness;
let host: AdminHost;
let admin: HostMember;

beforeAll(async () => {
  h = await createStaffHarness("satrolesapi");
  host = await createAdminHost(h);
  admin = await enrolThroughHost(h, host, unique("api.roles.admin"), "admin");
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const ROLE_FIELDS = [
  "builtIn",
  "description",
  "holderIds",
  "holders",
  "key",
  "kind",
  "label",
  "permissionCount",
  "permissions",
  "summary",
  "topRole",
  "version",
].sort();

describe("the staff roles routes", () => {
  it("list the prebuilt roles first, in the catalogue's order, each with what the screens read", async () => {
    const reply = await admin.client.get("/api/staff-roles");
    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toContain("no-store");
    const roles = reply.json?.roles as Record<string, unknown>[];
    expect(roles.map((r) => r.key).slice(0, 4)).toEqual([
      "viewer",
      "compliance",
      "operator",
      "admin",
    ]);
    for (const role of roles) expect(Object.keys(role).sort()).toEqual(ROLE_FIELDS);
    expect(roles[3]).toMatchObject({
      key: "admin",
      builtIn: true,
      topRole: true,
      permissionCount: 26,
      version: null,
      description: "",
    });
  });

  it("make, give, change and delete a custom role, each with its intent", async () => {
    // Made: 201 with the new ID and its first version.
    const made = await admin.client.stepped(admin.authenticator, "POST", "/api/staff-roles", {
      name: "Request handlers",
      description: "Handles requests for information.",
      permissions: ["customers.read", "rfis.read", "rfis.manage"],
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    expect(made.json).toEqual({ roleId: expect.stringMatching(/^srl_/), version: 1 });
    const roleId = String(made.json?.roleId);

    const detail = await admin.client.get(`/api/staff-roles/${roleId}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({
      key: roleId,
      kind: "custom",
      builtIn: false,
      label: "Request handlers",
      description: "Handles requests for information.",
      summary: "Handles requests for information.",
      permissions: ["customers.read", "rfis.read", "rfis.manage"],
      permissionCount: 3,
      holders: 0,
      version: 1,
    });
    expect(((detail.json?.groups ?? []) as unknown[]).length).toBeGreaterThan(5);

    // Given to a new member, as any role is.
    const added = await admin.client.stepped(admin.authenticator, "POST", "/api/staff", {
      email: unique("api.roles.holder"),
      roleKey: roleId,
    });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
    expect(added.json).toMatchObject({ roleKey: roleId, roleLabel: "Request handlers" });
    const holderId = String(added.json?.staffId);

    // Changed: 200 with the next version; the same version again is a conflict.
    const body = {
      name: "Request handlers",
      description: "",
      permissions: ["customers.read", "rfis.read"],
      version: 1,
      holders: [holderId],
    };
    const saved = await admin.client.stepped(
      admin.authenticator,
      "PUT",
      `/api/staff-roles/${roleId}`,
      body,
    );
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json).toEqual({ roleId, version: 2 });
    const stale = await admin.client.send("PUT", `/api/staff-roles/${roleId}`, body);
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "conflict" });
    expect((await admin.client.get(`/api/staff-roles/${roleId}`)).json).toMatchObject({
      holders: 1,
      holderIds: [holderId],
      version: 2,
      permissionCount: 2,
      summary: expect.any(String),
    });

    // Deleted while held: the holders shown are named, the move is required, then the member
    // moves to Viewer. Naming other holders than the role's is a conflict.
    const holders = [holderId];
    const unmoved = await admin.client.post(`/api/staff-roles/${roleId}/delete`, { holders });
    expect(unmoved.status).toBe(403);
    expect(unmoved.json).toMatchObject({ code: "giving_refused", problem: "move_required" });
    const otherHolders = await admin.client.post(`/api/staff-roles/${roleId}/delete`, {
      moveTo: "viewer",
      holders: [],
    });
    expect(otherHolders.status).toBe(409);
    expect(otherHolders.headers.get("content-type")).toContain("application/problem+json");
    expect(otherHolders.json).toMatchObject({ code: "conflict" });
    const deleted = await admin.client.stepped(
      admin.authenticator,
      "POST",
      `/api/staff-roles/${roleId}/delete`,
      { moveTo: "viewer", holders },
    );
    expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);
    expect(deleted.json).toEqual({ roleId, movedTo: "viewer", membersMoved: 1 });
    expect((await admin.client.get(`/api/staff-roles/${roleId}`)).status).toBe(404);
    const holder = await h.admin.query<{ role_key: string }>(
      "SELECT role_key FROM staff.member WHERE id = $1",
      [holderId],
    );
    expect(holder.rows[0]?.role_key).toBe("viewer");
    const events = (await h.events())
      .filter((e) => e.target_id === roleId || e.ref_ids.includes(roleId))
      .map((e) => e.event);
    expect(events).toEqual([
      "staff.role_created",
      "staff.role_updated",
      "staff.role_changed",
      "staff.role_deleted",
    ]);
  });

  it("refuse with problem documents that name the field and the problem, never the value", async () => {
    const invalid = await admin.client.post("/api/staff-roles", {
      name: "Admins",
      description: "",
      permissions: ["customers.read"],
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("content-type")).toContain("application/problem+json");
    expect(invalid.json).toMatchObject({
      code: "invalid",
      fields: [{ path: "name", code: "reads_as_built_in" }],
    });
    expect(JSON.stringify(invalid.json)).not.toContain("Admins");

    const beyond = await admin.client.post("/api/staff-roles", {
      name: "Unknown powers",
      description: "",
      permissions: ["customers.read", "everything.do"],
    });
    expect(beyond.status).toBe(403);
    expect(beyond.json).toMatchObject({ code: "giving_refused", problem: "beyond" });

    // The schema: unknown fields, a malformed ID in the path, a body that is not JSON's object.
    const extra = await admin.client.post("/api/staff-roles", {
      name: "Extra",
      description: "",
      permissions: ["customers.read"],
      holders: 3,
    });
    expect(extra.status).toBe(400);
    const prebuilt = await admin.client.send("PUT", "/api/staff-roles/viewer", {
      name: "Viewer",
      description: "",
      permissions: ["customers.read"],
      version: 1,
      holders: [],
    });
    expect(prebuilt.status).toBe(404);
    expect(
      (
        await admin.client.post("/api/staff-roles/rol_01jd0000000000000000000000/delete", {
          holders: [],
        })
      ).status,
    ).toBe(404);
    // A deletion names the holders it was shown, each a member's ID.
    const unnamed = "/api/staff-roles/srl_01jd0000000000000000000000/delete";
    for (const body of [
      {},
      { holders: ["someone"] },
      { holders: "stf_01jd0000000000000000000000" },
    ]) {
      const refused = await admin.client.post(unnamed, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.json).toMatchObject({ code: "invalid" });
    }
  });

  it("refuse a name the database's name index holds for another role as taken, before any factor, never as an internal error", async (ctx) => {
    // A capital I with a dot above: the editor's own comparison keeps "İnfo desk" apart from
    // "Info desk", while the server's collation folds both to one key in the name index.
    const dotted = "İnfo desk";
    const folds = await h.admin.query<{ same: boolean }>("SELECT lower($1) = lower($2) AS same", [
      dotted,
      "Info desk",
    ]);
    if (folds.rows[0]?.same !== true) {
      ctx.skip("this database's collation keeps the two names apart, as the editor does");
    }
    const draft = { description: "", permissions: ["customers.read"] };
    const made = await admin.client.stepped(admin.authenticator, "POST", "/api/staff-roles", {
      ...draft,
      name: "Info desk",
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const other = await admin.client.stepped(admin.authenticator, "POST", "/api/staff-roles", {
      ...draft,
      name: "Front desk",
    });
    expect(other.status, JSON.stringify(other.json)).toBe(201);
    const taken = { code: "invalid", fields: [{ path: "name", code: "name_taken" }] };
    const again = await admin.client.post("/api/staff-roles", { ...draft, name: dotted });
    expect(again.status, JSON.stringify(again.json)).toBe(400);
    expect(again.json).toMatchObject(taken);
    const renamed = await admin.client.send("PUT", `/api/staff-roles/${other.json?.roleId}`, {
      ...draft,
      name: dotted,
      version: 1,
      holders: [],
    });
    expect(renamed.status, JSON.stringify(renamed.json)).toBe(400);
    expect(renamed.json).toMatchObject(taken);
    for (const name of [dotted, "Info desk", "Front desk"]) {
      expect(JSON.stringify([again.json, renamed.json])).not.toContain(name);
    }
  });

  it("refuse a name holding a character the database refuses as the name rule does, before any intent, never as an internal error", async () => {
    const made = await admin.client.stepped(admin.authenticator, "POST", "/api/staff-roles", {
      name: "Night desk",
      description: "",
      permissions: ["customers.read"],
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const intents = async () => {
      const result = await h.admin.query<{ n: number }>(
        "SELECT count(*)::integer AS n FROM ops.step_up_intent",
      );
      return Number(result.rows[0]?.n);
    };
    const before = await intents();
    const named = { code: "invalid", fields: [{ path: "name", code: "name" }] };
    const draft = { description: "", permissions: ["customers.read"] };
    const createdNul = await admin.client.post("/api/staff-roles", {
      ...draft,
      name: "Night\u0000shift",
    });
    expect(createdNul.status, JSON.stringify(createdNul.json)).toBe(400);
    expect(createdNul.json).toMatchObject(named);
    const savedNul = await admin.client.send("PUT", `/api/staff-roles/${made.json?.roleId}`, {
      ...draft,
      name: "Plain\u0000role",
      version: 1,
      holders: [],
    });
    expect(savedNul.status, JSON.stringify(savedNul.json)).toBe(400);
    expect(savedNul.json).toMatchObject(named);
    expect(await intents()).toBe(before);
  });

  it("refuse a save that adds a permission unless it names the role's holders now, before any intent", async () => {
    const made = await admin.client.stepped(admin.authenticator, "POST", "/api/staff-roles", {
      name: "Raised desk",
      description: "",
      permissions: ["customers.read"],
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const roleId = String(made.json?.roleId);
    const added = await admin.client.stepped(admin.authenticator, "POST", "/api/staff", {
      email: unique("api.roles.raised"),
      roleKey: roleId,
    });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
    const holderId = String(added.json?.staffId);
    const save = {
      name: "Raised desk",
      description: "",
      permissions: ["customers.read", "audit.read"],
      version: 1,
    };
    for (const holders of [[], [holderId, admin.staffId]]) {
      const refused = await admin.client.send("PUT", `/api/staff-roles/${roleId}`, {
        ...save,
        holders,
      });
      expect(refused.status, JSON.stringify(holders)).toBe(409);
      expect(refused.headers.get("content-type")).toContain("application/problem+json");
      expect(refused.json).toMatchObject({ code: "conflict" });
      expect(refused.json?.intent_id).toBeUndefined();
    }
    const saved = await admin.client.stepped(
      admin.authenticator,
      "PUT",
      `/api/staff-roles/${roleId}`,
      { ...save, holders: [holderId] },
    );
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json).toEqual({ roleId, version: 2 });
  });

  it("are Admin-only for writes, and readable by every prebuilt role", async () => {
    const operator = await enrolThroughHost(h, host, unique("api.roles.operator"), "operator");
    expect((await operator.client.get("/api/staff-roles")).status).toBe(200);
    const refused = await operator.client.post("/api/staff-roles", {
      name: "Operators two",
      description: "",
      permissions: ["customers.read"],
    });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: "forbidden", permission: "staffRoles.manage" });
  });
});
