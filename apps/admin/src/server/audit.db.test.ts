// Fin Admin's audit log through the API half (spec 02 §14.3, §14.5, §16.4; AdminAudit): behind the
// Access check, requireStaff, `audit.read` and aal2; a page newest first in the answer's shape,
// with the address the tunnel gave and the device, the Staff member filter's people only for a
// reader who may see staff, cursor paging, one entry by its ID and 404 for anything else, every
// query refusal naming the field, and one request line per read.
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
import { auditEntryAnswer, auditPageAnswer } from "../client/routes/audit/-audit/contract.ts";

let h: StaffHarness;
let host: AdminHost;
let admin: HostMember;
let auditor: HostMember;
let staffOnly: HostMember;

beforeAll(async () => {
  h = await createStaffHarness("sun00auditapi");
  host = await createAdminHost(h);
  admin = await enrolThroughHost(h, host, unique("api.admin"), "admin");
  auditor = await enrolThroughHost(
    h,
    host,
    unique("api.auditor"),
    await h.seedCustomRole("Auditors", ["audit.read"]),
  );
  staffOnly = await enrolThroughHost(
    h,
    host,
    unique("api.staffonly"),
    await h.seedCustomRole("Staff readers", ["staff.read"]),
  );
}, 120_000);

afterAll(async () => {
  await h?.close();
});

interface Item {
  id: string;
  event: string;
  actor: { id: string | null; email: string | null };
  address: string | null;
  device: string | null;
}

describe("GET /api/audit", () => {
  it("answers the staff rows newest first, in the screen's contract, with no-store", async () => {
    const reply = await admin.client.get("/api/audit");
    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toContain("no-store");
    expect(reply.headers.get("access-control-allow-origin")).toBeNull();
    const page = auditPageAnswer.parse(reply.json);
    const items = page.items as Item[];
    expect(items.length).toBeGreaterThan(3);
    expect(items.map((i) => i.id)).toEqual(
      items
        .map((i) => i.id)
        .sort()
        .reverse(),
    );
    // The admin's own enrolment, from the address the tunnel gave and the browser that sent it.
    const mine = items.find(
      (i) => i.event === "staff.factor_enrolled" && i.actor.id === admin.staffId,
    );
    expect(mine).toMatchObject({
      actor: { email: admin.email },
      address: admin.client.ip,
      device: "Chrome on Mac",
    });
    // An Admin may see staff: the Staff member filter lists them.
    expect(page.people.map((p) => p.email)).toEqual(
      expect.arrayContaining([admin.email, auditor.email, staffOnly.email]),
    );
    const lines = host.captured
      .events("request")
      .filter((line) => line.route === "/api/audit" && line.outcome === "ok");
    expect(lines.length).toBeGreaterThan(0);
  });

  it("lists no people for a reader who may not see staff", async () => {
    const reply = await auditor.client.get("/api/audit?limit=5");
    expect(reply.status).toBe(200);
    const page = auditPageAnswer.parse(reply.json);
    expect(page.items).toHaveLength(5);
    expect(page.people).toEqual([]);
  });

  it("refuses a role without audit.read, after the guard and before any read", async () => {
    const reply = await staffOnly.client.get("/api/audit");
    expect(reply.status).toBe(403);
    expect(reply.json).toMatchObject({ code: "forbidden", permission: "audit.read" });
  });

  it("pages by cursor, and the previous page's cursor leads back", async () => {
    const first = auditPageAnswer.parse((await admin.client.get("/api/audit?limit=2")).json);
    expect(first.previousCursor).toBeNull();
    expect(first.nextCursor).toBe(first.items[1]?.id);
    const second = auditPageAnswer.parse(
      (await admin.client.get(`/api/audit?limit=2&cursor=${first.nextCursor}`)).json,
    );
    expect(String(second.items[0]?.id) < String(first.items[1]?.id)).toBe(true);
    const back = auditPageAnswer.parse(
      (await admin.client.get(`/api/audit?limit=2&before=${second.previousCursor}`)).json,
    );
    expect(back.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));
  });

  it("answers a page past either end with the real count and the way back, never as an empty log", async () => {
    const all = auditPageAnswer.parse((await admin.client.get("/api/audit?limit=100")).json);
    const newest = `aud_${"z".repeat(26)}`;
    const oldest = `aud_${"0".repeat(26)}`;
    const pastNewest = auditPageAnswer.parse(
      (await admin.client.get(`/api/audit?limit=50&before=${newest}`)).json,
    );
    expect(pastNewest).toMatchObject({
      items: [],
      total: all.total,
      nextCursor: newest,
      previousCursor: null,
    });
    const pastOldest = auditPageAnswer.parse(
      (await admin.client.get(`/api/audit?limit=50&cursor=${oldest}`)).json,
    );
    expect(pastOldest).toMatchObject({
      items: [],
      total: all.total,
      nextCursor: null,
      previousCursor: oldest,
    });
    expect(all.total).toBeGreaterThan(0);
  });

  it("filters by comma-separated actions and actors, and by the two views", async () => {
    const reply = await admin.client.get(
      `/api/audit?action=staff.signed_in,staff.factor_enrolled&actor=${auditor.staffId},${admin.staffId}`,
    );
    const page = auditPageAnswer.parse(reply.json);
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items as Item[]) {
      expect(["staff.signed_in", "staff.factor_enrolled"]).toContain(item.event);
      expect([auditor.staffId, admin.staffId]).toContain(item.actor.id);
    }
    const mine = auditPageAnswer.parse((await auditor.client.get("/api/audit?show=mine")).json);
    expect((mine.items as Item[]).every((i) => i.actor.id === auditor.staffId)).toBe(true);
    const rejections = auditPageAnswer.parse(
      (await admin.client.get("/api/audit?show=rejections")).json,
    );
    expect(rejections.items).toEqual([]);
  });

  it("refuses a query it does not take, naming the field and never the value", async () => {
    const cases: [string, string][] = [
      ["limit=0", "limit"],
      ["limit=101", "limit"],
      ["actor=bob", "actor.0"],
      ["action=staff.signed_in,DROP", "action.1"],
      [`cursor=aud_01jd${"0".repeat(22)}&before=aud_01jd${"1".repeat(22)}`, "before"],
      ["date=7d&from=2026-11-01", "date"],
      ["from=21-11-2026", "from"],
      ["q=nadia", ""],
    ];
    for (const [query, path] of cases) {
      const reply = await admin.client.get(`/api/audit?${query}`);
      expect(reply.status, query).toBe(400);
      expect(reply.json?.code, query).toBe("invalid");
      const fields = reply.json?.fields as { path: string; code: string }[];
      expect(
        fields.some((f) => f.path === path),
        `${query}: ${JSON.stringify(fields)}`,
      ).toBe(true);
      expect(JSON.stringify(reply.json)).not.toContain("nadia");
      expect(JSON.stringify(reply.json)).not.toContain("bob");
    }
  });
});

describe("GET /api/audit/:eventId", () => {
  it("answers one entry as the list draws it, and 404 for an ID it does not hold", async () => {
    const page = auditPageAnswer.parse((await admin.client.get("/api/audit?limit=1")).json);
    const id = page.items[0]?.id ?? "";
    const reply = await auditor.client.get(`/api/audit/${id}`);
    expect(reply.status).toBe(200);
    expect(auditEntryAnswer.parse(reply.json).entry).toEqual(page.items[0]);
    for (const path of [`/api/audit/aud_01jd${"9".repeat(22)}`, "/api/audit/not-an-id"]) {
      const missing = await auditor.client.get(path);
      expect(missing.status, path).toBe(404);
      expect(missing.json).toMatchObject({ code: "not_found" });
    }
    expect((await staffOnly.client.get(`/api/audit/${id}`)).status).toBe(403);
  });
});
