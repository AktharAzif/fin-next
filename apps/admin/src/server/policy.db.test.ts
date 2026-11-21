// T-SAT-31 (spec 02 §6.4, §10.5, §14.1, §14.3; AC-SAT-04, AC-SAT-13, AC-SAT-28): generated from the
// route policy, through the API half: every route refuses a request without the Access token
// before any handler; every route but the two refuses a request with no session, an aal1 session
// of a pending member and one at the factor step; every permission check refuses a role lacking
// the permission; and a session presented under another Access identity is ended and refused.
import { createStaffHarness, type StaffHarness, unique } from "@fin/staff/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_POLICIES, type PolicyId } from "./policy/index.ts";
import {
  type AdminClient,
  type AdminHost,
  createAdminHost,
  enrolThroughHost,
  type HostMember,
  pendingThroughHost,
} from "./testing/host.ts";

let h: StaffHarness;
let host: AdminHost;
let admin: HostMember;
let target: HostMember;
/** One aal1 session of a member with a factor, at the factor step (a code sign-in, once). */
let stepping: AdminClient;
let stepper: HostMember;

beforeAll(async () => {
  h = await createStaffHarness("sat04policy");
  host = await createAdminHost(h);
  admin = await enrolThroughHost(h, host, unique("policy.admin"), "admin");
  target = await enrolThroughHost(h, host, unique("policy.target"), "viewer");
  stepper = await enrolThroughHost(h, host, unique("policy.stepper"), "admin");
  stepping = host.client(stepper.email);
  const signedIn = await stepping.signInByCode((email) => h.latestCode(email));
  if (signedIn.status !== 200) throw new Error(`factor-step sign-in: ${signedIn.status}`);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

/** A request each route accepts as input, so that only the guard can refuse it. */
function sample(id: PolicyId): { path: string; body?: unknown } {
  const s = target.staffId;
  switch (id) {
    case "viewer.get":
      return { path: "/api/viewer" };
    case "enrolment.redeem":
      return { path: "/api/enrolment/redeem", body: { code: "0000-0000-0000-0000" } };
    case "account.get":
      return { path: "/api/account" };
    case "account.session_revoke":
      return { path: "/api/account/sessions/sts_01jd0000000000000000000000/revoke", body: {} };
    case "account.sessions_revoke_others":
      return { path: "/api/account/sessions/revoke-others", body: {} };
    case "staff.list":
      return { path: "/api/staff?page=1&size=25" };
    case "staff.add":
      return { path: "/api/staff", body: { email: unique("sample"), roleKey: "viewer" } };
    case "staff.role":
      return { path: `/api/staff/${s}`, body: { roleKey: "compliance" } };
    case "staff.remove":
      return { path: `/api/staff/${s}/remove`, body: {} };
    case "staff.reset_factors":
      return { path: `/api/staff/${s}/reset-factors`, body: {} };
    case "staff.enrolment_code":
      return { path: `/api/staff/${s}/enrolment-code`, body: {} };
    case "staff_roles.list":
      return { path: "/api/staff-roles" };
    case "staff_roles.get":
      return { path: "/api/staff-roles/operator" };
    case "switches.list":
      return { path: "/api/switches" };
    case "switches.set":
      return { path: "/api/switches/signups", body: { state: "on", reasonCode: "drill" } };
  }
}

function send(client: AdminClient, id: PolicyId) {
  const policy = ADMIN_POLICIES.find((p) => p.id === id);
  if (policy === undefined) throw new Error(id);
  const { path, body } = sample(id);
  return client.send(policy.method, path, policy.method === "GET" ? undefined : body);
}

const routes = ADMIN_POLICIES.map((p) => p.id);
const guarded = ADMIN_POLICIES.filter((p) => p.assurance === "aal2_or_working").map((p) => p.id);

describe("every Fin Admin route", () => {
  it.each(routes)("%s needs the Access token before anything else", async (id) => {
    const anonymous = host.client(null);
    const reply = await send(anonymous, id);
    expect(reply.status).toBe(401);
    expect(reply.json).toMatchObject({ code: "access_required" });
    const forged = host.client(admin.email);
    forged.token = host.standIn.issue({ email: admin.email, signWith: "stranger" });
    expect((await send(forged, id)).status).toBe(401);
  });

  it.each(guarded)("%s refuses a request with no session", async (id) => {
    const reply = await send(host.client(unique("no.session")), id);
    expect(reply.status).toBe(401);
    expect(reply.json).toMatchObject({ code: "unauthenticated" });
  });

  it.each(guarded)("%s refuses a pending member's aal1 session", async (id) => {
    const pending = await pendingThroughHost(h, host, unique("pending"));
    const reply = await send(pending, id);
    expect(reply.status).toBe(403);
    expect(reply.json).toMatchObject({ code: "factor_step_required", methods: [] });
  });

  it.each(guarded)("%s refuses a session at the factor step", async (id) => {
    const reply = await send(stepping, id);
    expect(reply.status).toBe(403);
    expect(reply.json).toMatchObject({ code: "factor_step_required", methods: ["passkey"] });
  });
});

describe("the two routes below aal2 (§6.4)", () => {
  it("answer the viewer in every state", async () => {
    const email = unique("viewer.states");
    expect((await host.client(email).get("/api/viewer")).json).toEqual({
      state: "signed_out",
      accessEmail: email,
    });
    const pending = await pendingThroughHost(h, host, email);
    expect((await pending.get("/api/viewer")).json).toEqual({ state: "pending", email });
    expect((await stepping.get("/api/viewer")).json).toEqual({
      state: "factor_step",
      email: stepper.email,
      methods: ["passkey"],
    });
  });

  it("let only a pending member redeem a code", async () => {
    const pending = await pendingThroughHost(h, host, unique("redeemer"));
    const wrong = await send(pending, "enrolment.redeem");
    expect(wrong.status).toBe(400);
    expect(wrong.json).toMatchObject({ code: "invalid", reason: "void" });
    expect((await send(stepping, "enrolment.redeem")).json).toMatchObject({
      code: "factor_step_required",
    });
    expect((await send(admin.client, "enrolment.redeem")).json).toMatchObject({
      code: "forbidden",
    });
    expect((await send(host.client(unique("none")), "enrolment.redeem")).json).toMatchObject({
      code: "unauthenticated",
    });
  });
});

describe("every permission check (§8.3)", () => {
  const withPermission = ADMIN_POLICIES.filter((p) => p.permission !== null);
  let viewer: HostMember;
  let auditor: HostMember;

  beforeAll(async () => {
    viewer = await enrolThroughHost(h, host, unique("perm.viewer"), "viewer");
    const auditRole = await h.seedCustomRole("Auditors", ["audit.read"]);
    auditor = await enrolThroughHost(h, host, unique("perm.auditor"), auditRole);
  }, 120_000);

  it.each(withPermission.map((p) => p.id))(
    "%s refuses a role lacking its permission",
    async (id) => {
      const policy = withPermission.find((p) => p.id === id);
      // Every prebuilt role reads staff, so the staff reads are tried with a custom role that does not.
      const who = policy?.permission === "staff.read" ? auditor : viewer;
      const reply = await send(who.client, id);
      expect(reply.status).toBe(403);
      expect(reply.json).toMatchObject({ code: "forbidden", permission: policy?.permission });
    },
  );

  it.each(withPermission.map((p) => p.id))(
    "%s passes the guard for a role holding it",
    async (id) => {
      const reply = await send(admin.client, id);
      // Past the guard: an answer, a step-up request, or a refusal of the action's own rules.
      expect(reply.json?.code === "forbidden" || reply.status === 401).toBe(false);
    },
  );
});

describe("the same person on every request (§10.5)", () => {
  it("ends and refuses a session sent under another Access identity", async () => {
    const member = await enrolThroughHost(h, host, unique("same.person"), "viewer");
    const thief = host.client(unique("someone.else"));
    for (const [k, v] of member.client.jar) thief.jar.set(k, v);
    const reply = await thief.get("/api/staff");
    expect(reply.status).toBe(403);
    expect(reply.json).toMatchObject({ code: "access_mismatch" });
    // The session is gone for its owner too, and the mismatch was logged.
    expect((await member.client.get("/api/viewer")).json).toMatchObject({ state: "signed_out" });
    expect(h.lines.named("staff.access_mismatch").some((l) => l.staffId === member.staffId)).toBe(
      true,
    );
  });
});
