// T-SAT-30 (spec 02 §7.1 to §7.5, [SA-08]; AC-SAT-06, AC-SAT-32): generated from the route policy,
// for every intent route of Fin Admin, through the API half: refused with no intent (and then an
// intent bound to it exists), with that intent unproved, expired, for another action, of another
// member's session, or for other parameters; passes once with a fresh proved one; and two
// concurrent re-sends with one intent make exactly one change.

import { randomBytes } from "node:crypto";
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
import { ADMIN_POLICIES, type PolicyId } from "./policy/index.ts";

let h: StaffHarness;
let host: AdminHost;
let admin: HostMember;
let other: HostMember;

beforeAll(async () => {
  h = await createStaffHarness("sat04stepup");
  host = await createAdminHost(h);
  admin = await enrolThroughHost(h, host, unique("step.admin"), "admin");
  other = await enrolThroughHost(h, host, unique("step.other"), "admin");
}, 120_000);

afterAll(async () => {
  await h?.close();
});

interface Scenario {
  path: string;
  body: Record<string, unknown>;
  /** The same route with other bound parameters or another target (none if nothing is bound). */
  tampered: { path: string; body: Record<string, unknown> } | null;
}

async function signedInSession(member: HostMember): Promise<string> {
  const second = host.client(member.email);
  const signedIn = await second.passkey(member.authenticator);
  expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
  const account = await second.get("/api/account");
  const sessions = account.json?.sessions as { id: string; current: boolean }[];
  return (sessions.find((s) => s.current) as { id: string }).id;
}

/** A custom staff role's name no other role in the file has (letters only, §8.6). */
function roleName(): string {
  const letters = randomBytes(6)
    .toString("hex")
    .replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)] ?? "q");
  return `Step ${letters}`;
}

/** A custom staff role made through the API half, stepped up as the client does. */
async function madeRole(): Promise<string> {
  const reply = await admin.client.stepped(admin.authenticator, "POST", "/api/staff-roles", {
    name: roleName(),
    description: "",
    permissions: ["customers.read"],
  });
  expect(reply.status, JSON.stringify(reply.json)).toBe(201);
  return String(reply.json?.roleId);
}

async function switchState(): Promise<"on" | "off"> {
  const row = await h.admin.query<{ state: "on" | "off" }>(
    "SELECT state FROM ops.kill_switch WHERE name = 'outbound_webhooks'",
  );
  return row.rows[0]?.state ?? "off";
}

async function scenario(id: PolicyId): Promise<Scenario> {
  // One client proves every route's intents from one address, more passkey ceremonies than a
  // person makes in a minute: each route starts with that address's passkey allowance (§5.6) anew.
  await h.fixture("DELETE FROM ops.rate_window WHERE key LIKE 'passkey_options:%'");
  const fresh = async (roleKey = "viewer") =>
    (await enrolThroughHost(h, host, unique(`step.${id}`), roleKey)).staffId;
  switch (id) {
    case "account.session_revoke": {
      const a = await signedInSession(admin);
      const b = await signedInSession(admin);
      return {
        path: `/api/account/sessions/${a}/revoke`,
        body: {},
        tampered: { path: `/api/account/sessions/${b}/revoke`, body: {} },
      };
    }
    case "account.sessions_revoke_others":
      return { path: "/api/account/sessions/revoke-others", body: {}, tampered: null };
    case "staff.add": {
      const email = unique("step.added");
      return {
        path: "/api/staff",
        body: { email, roleKey: "viewer" },
        tampered: { path: "/api/staff", body: { email, roleKey: "compliance" } },
      };
    }
    case "staff.role": {
      const a = await fresh();
      return {
        path: `/api/staff/${a}`,
        body: { roleKey: "compliance" },
        tampered: { path: `/api/staff/${a}`, body: { roleKey: "operator" } },
      };
    }
    case "staff.remove":
    case "staff.reset_factors": {
      const [a, b] = [await fresh(), await fresh()];
      const verb = id === "staff.remove" ? "remove" : "reset-factors";
      return {
        path: `/api/staff/${a}/${verb}`,
        body: {},
        tampered: { path: `/api/staff/${b}/${verb}`, body: {} },
      };
    }
    case "staff.enrolment_code": {
      const a = await h.seedMember(unique("step.pending.a"), "viewer", "pending");
      const b = await h.seedMember(unique("step.pending.b"), "viewer", "pending");
      return {
        path: `/api/staff/${a}/enrolment-code`,
        body: {},
        tampered: { path: `/api/staff/${b}/enrolment-code`, body: {} },
      };
    }
    case "switches.set": {
      const next = (await switchState()) === "on" ? "off" : "on";
      return {
        path: "/api/switches/outbound_webhooks",
        body: { state: next, reasonCode: "drill" },
        tampered: {
          path: "/api/switches/outbound_webhooks",
          body: { state: next, reasonCode: "other_reason" },
        },
      };
    }
    case "staff_roles.create": {
      const body = { name: roleName(), description: "", permissions: ["customers.read"] };
      return {
        path: "/api/staff-roles",
        body,
        tampered: { path: "/api/staff-roles", body: { ...body, permissions: ["money.read"] } },
      };
    }
    case "staff_roles.update": {
      const roleId = await madeRole();
      const body = {
        name: roleName(),
        description: "",
        permissions: ["customers.read", "rfis.read"],
        version: 1,
      };
      return {
        path: `/api/staff-roles/${roleId}`,
        body,
        tampered: {
          path: `/api/staff-roles/${roleId}`,
          body: { ...body, permissions: ["customers.read"] },
        },
      };
    }
    case "staff_roles.delete": {
      const [a, b] = [await madeRole(), await madeRole()];
      return {
        path: `/api/staff-roles/${a}/delete`,
        body: {},
        tampered: { path: `/api/staff-roles/${b}/delete`, body: {} },
      };
    }
    default:
      throw new Error(`no scenario for ${id}`);
  }
}

const intentRoutes = ADMIN_POLICIES.filter((p) => p.stepUp === "intent");

// @fin/identity's own staff actions name their reasons in its own keys, not §15.5's action keys
// (recorded in the pull request); the staff area's actions use the action key.
const IDENTITY_REASON_KEYS: Readonly<Record<string, string>> = {
  "staff.session_revoke": "sign_out_session",
  "staff.sessions_revoke_others": "sign_out_everywhere",
  // The custom staff role actions' keys in the lower case the intent table's column takes.
  "staffRole.create": "staff_role.create",
  "staffRole.update": "staff_role.update",
  "staffRole.delete": "staff_role.delete",
};

describe("every intent route of Fin Admin (§7.5)", () => {
  it("is the policy's full set", () => {
    expect(intentRoutes.map((p) => p.id).sort()).toEqual(
      [
        "account.session_revoke",
        "account.sessions_revoke_others",
        "staff.add",
        "staff.enrolment_code",
        "staff.remove",
        "staff.reset_factors",
        "staff.role",
        "staff_roles.create",
        "staff_roles.delete",
        "staff_roles.update",
        "switches.set",
      ].sort(),
    );
  });

  it.each(intentRoutes.map((p) => [p.id, p.method, p.action] as const))(
    "%s refuses every intent but its own proved, unspent one, and passes once",
    async (id, method, action) => {
      const s = await scenario(id);
      const client = admin.client;
      // 1. No intent: refused, and an intent of this session, member and action now exists.
      const asked = await client.send(method, s.path, s.body);
      expect(asked.status).toBe(403);
      expect(asked.json).toMatchObject({
        code: "step_up_required",
        step_up_kind: "intent",
        reason_key: IDENTITY_REASON_KEYS[action ?? ""] ?? action,
        methods: ["passkey"],
      });
      const intent = String(asked.json?.intent_id);
      const row = await h.admin.query<{ realm: string; principal_id: string; action: string }>(
        "SELECT realm, principal_id, action FROM ops.step_up_intent WHERE id = $1",
        [intent],
      );
      expect(row.rows[0]).toEqual({ realm: "staff", principal_id: admin.staffId, action });
      const resend = (intentId: string, request = s) =>
        client.send(method, request.path, request.body, { "fin-step-up-intent": intentId });

      // 2. Unproved.
      expect((await resend(intent)).json).toMatchObject({
        code: "step_up_invalid",
        reason: "unproved",
      });
      // 3. Another member's intent, proved in their own session.
      const theirs = await other.client.post("/api/account/sessions/revoke-others", {});
      const theirIntent = String(theirs.json?.intent_id);
      expect((await other.client.passkey(other.authenticator, theirIntent)).status).toBe(200);
      expect((await resend(theirIntent)).json).toMatchObject({
        code: "step_up_invalid",
        reason: "other_session",
      });
      // 4. An intent of this session for another action.
      if (id !== "account.sessions_revoke_others") {
        const elsewhere = await client.post("/api/account/sessions/revoke-others", {});
        const otherAction = String(elsewhere.json?.intent_id);
        expect((await client.passkey(admin.authenticator, otherAction)).status).toBe(200);
        expect((await resend(otherAction)).json).toMatchObject({
          code: "step_up_invalid",
          reason: "other_action",
        });
      }
      // 5. Proved, but for other parameters or another target.
      expect((await client.passkey(admin.authenticator, intent)).status).toBe(200);
      if (s.tampered !== null) {
        expect((await resend(intent, { ...s.tampered, tampered: null })).json).toMatchObject({
          code: "step_up_invalid",
          reason: "digest",
        });
      }
      // 6. Proved, then past its 5 minutes.
      await h.fixture(
        "UPDATE ops.step_up_intent SET created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' WHERE id = $1",
        [intent],
      );
      expect((await resend(intent)).json).toMatchObject({
        code: "step_up_invalid",
        reason: "expired",
      });

      // 7. A fresh intent, proved: passes once, and its spending is the event's step-up.
      const again = await client.send(method, s.path, s.body);
      const fresh = String(again.json?.intent_id);
      expect((await client.passkey(admin.authenticator, fresh)).status).toBe(200);
      const passed = await resend(fresh);
      expect(passed.status, JSON.stringify(passed.json)).toBeLessThan(300);
      const spent = await h.admin.query<{ consumed: boolean }>(
        "SELECT consumed_at IS NOT NULL AS consumed FROM ops.step_up_intent WHERE id = $1",
        [fresh],
      );
      expect(spent.rows[0]?.consumed).toBe(true);
      const carried = await h.admin.query("SELECT 1 FROM audit.event WHERE step_up_ref = $1", [
        fresh,
      ]);
      expect(carried.rowCount).toBeGreaterThan(0);
      // 8. Never twice.
      const twice = await resend(fresh);
      expect(twice.status).toBeGreaterThanOrEqual(400);
    },
  );

  it("makes exactly one change from two concurrent re-sends with one intent (AC-SAT-32)", async () => {
    await signedInSession(admin);
    await signedInSession(admin);
    const asked = await admin.client.post("/api/account/sessions/revoke-others", {});
    const intent = String(asked.json?.intent_id);
    expect((await admin.client.passkey(admin.authenticator, intent)).status).toBe(200);
    const headers = { "fin-step-up-intent": intent };
    const replies = await Promise.all([
      admin.client.post("/api/account/sessions/revoke-others", {}, headers),
      admin.client.post("/api/account/sessions/revoke-others", {}, headers),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(replies.find((r) => r.status === 403)?.json).toMatchObject({
      code: "step_up_invalid",
      reason: "used",
    });
    const events = await h.admin.query("SELECT 1 FROM audit.event WHERE step_up_ref = $1", [
      intent,
    ]);
    expect(events.rowCount).toBe(1);
  });
});
