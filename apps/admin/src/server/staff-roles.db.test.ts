// Custom staff roles through Fin Admin's API half (spec 02 §10.7, §14.3, §8.4; stretch 3), as the
// admin tunnel reaches it: the Access token, the origin gate, the staff realm and the route policy,
// on the real platform. An Admin lists the four prebuilt roles, makes a custom role with an intent,
// gives it to a member, changes it (a stale save is a conflict), and deletes it with the member
// moved; every refusal is a problem document naming its code and never the value, and every
// answer is what the AdminRoles and AdminRoleEditor screens read.

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
      version: 2,
      permissionCount: 2,
      summary: expect.any(String),
    });

    // Deleted while held: the move is required, then the member moves to Viewer.
    const unmoved = await admin.client.post(`/api/staff-roles/${roleId}/delete`, {});
    expect(unmoved.status).toBe(403);
    expect(unmoved.json).toMatchObject({ code: "giving_refused", problem: "move_required" });
    const deleted = await admin.client.stepped(
      admin.authenticator,
      "POST",
      `/api/staff-roles/${roleId}/delete`,
      { moveTo: "viewer" },
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
    });
    expect(prebuilt.status).toBe(404);
    expect(
      (await admin.client.post("/api/staff-roles/rol_01jd0000000000000000000000/delete", {}))
        .status,
    ).toBe(404);
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
