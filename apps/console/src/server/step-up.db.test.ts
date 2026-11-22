// The console's step-up matrix, generated from the route policy (spec 02 §19.2 T-SAT-30; AC-SAT-06):
// over HTTP through the real front door, for every intent route, on its own fresh fixture,
//   - no intent: `403 step_up_required` with a new intent;
//   - that intent unproved: `step_up_invalid` (`unproved`);
//   - proved, sent with any one bound field or the path's target changed: `digest` (each bound field
//     of the policy and the target must have such a request, or a stated reason why none can reach
//     the step-up), so a route that binds the wrong fields or confirms a body other than the one it
//     acts on fails here;
//   - sent from another session of the same person: `other_session`;
//   - expired: `expired`; consumed: `used`;
//   - then the unchanged request passes once, consumes the intent and names it on its event, and the
//     same intent never serves again.
// Every window route passes within the window of a proof and not after it.
import { randomBytes } from "node:crypto";
import { bootApi } from "@fin/web-host/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  DROP_TIMEOUT_MS,
  seed,
  type TestDatabase,
  totpCode,
} from "../../../../packages/orgs/test/index.ts";
import {
  type Booted,
  Client,
  enrolAuthenticator,
  latestCode,
  ORIGIN,
  type Reply,
  steppedUp,
} from "../../test/client.ts";
import { defineConsoleService } from "./main.ts";
import { CONSOLE_POLICY, type RoutePolicy } from "./policy/index.ts";

let database: TestDatabase;
let api: Booted;

const tag = randomBytes(3).toString("hex");
const address = (label: string) => `${label}.${tag}.${randomBytes(3).toString("hex")}@example.com`;

beforeAll(async () => {
  database = await createTestDatabase("step_up_matrix");
  api = await bootApi(defineConsoleService({ pool: database.login("fin_console") }), {
    service: "console",
    roles: ["console"],
    env: {
      FIN_PUBLIC_ORIGIN: ORIGIN,
      FIN_CONNECTOR_SERVICES: "cloudflared-public",
      FIN_DOCS_ORIGIN: "https://developer.example.com",
      BETTER_AUTH_SECRETS: `1:${randomBytes(32).toString("base64url")}`,
      FIN_LIMIT_KEY_1: randomBytes(32).toString("hex"),
    },
  });
}, 60_000);

afterAll(async () => {
  await api?.stop();
  await database?.drop();
}, DROP_TIMEOUT_MS);

async function signIn(email: string): Promise<Client> {
  const client = new Client(api);
  const sent = await client.call("POST", "/api/auth/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  if (sent.status !== 200) throw new Error(`code request answered ${sent.status}`);
  const signedIn = await client.call("POST", "/api/auth/sign-in/email-otp", {
    email,
    otp: await latestCode(database.admin, email),
  });
  if (signedIn.status !== 200) throw new Error(`sign-in answered ${signedIn.status}`);
  return client;
}

/** A right authenticator code, for an intent or (without one) for the session's window. */
async function prove(client: Client, intentId?: string): Promise<void> {
  // Each TOTP step is accepted once; these tests are not about replay.
  await database.admin.query("UPDATE identity.totp_step SET last_step = 0");
  const proved = await client.call(
    "POST",
    "/api/auth/two-factor/verify-totp",
    { code: totpCode(client.secret as Uint8Array, new Date()) },
    intentId === undefined ? {} : { "fin-step-up-intent": intentId },
  );
  if (proved.status !== 200) throw new Error(`the proof answered ${proved.status}`);
}

interface Person {
  client: Client;
  email: string;
}

async function withFactor(label: string): Promise<Person> {
  const email = address(label);
  const client = await signIn(email);
  await enrolAuthenticator(client);
  return { client, email };
}

/** Another session of the same person: a code sign-in raised by the authenticator. */
async function anotherSession(person: Person): Promise<Client> {
  const client = await signIn(person.email);
  client.secret = person.client.secret;
  await prove(client);
  return client;
}

async function currentSessionOf(client: Client): Promise<string> {
  const list = await client.call("GET", "/api/account/sessions");
  const id = (list.json.items as { id: string; current: boolean }[]).find((s) => s.current)?.id;
  if (id === undefined) throw new Error("no current session");
  return id;
}

interface Owner extends Person {
  orgId: string;
  orgName: string;
}

async function owner(label: string): Promise<Owner> {
  const who = await withFactor(label);
  const first = await who.client.call("POST", "/api/orgs/first");
  const orgId = String(first.json.orgId);
  const org = await who.client.org(orgId, "GET", "/api/org");
  return { ...who, orgId, orgName: String(org.json.name) };
}

async function stepped(client: Client, send: (h: Record<string, string>) => Promise<Reply>) {
  const { done } = await steppedUp(database.admin, client, send);
  if (done.status >= 300) throw new Error(`answered ${done.status}: ${JSON.stringify(done.json)}`);
  return done;
}

async function roleIn(o: Owner, name: string, permissions: string[]): Promise<string> {
  const done = await stepped(o.client, (h) =>
    o.client.org(o.orgId, "POST", "/api/roles", { name, description: "", permissions }, h),
  );
  return String(done.json.roleId);
}

async function invitationFrom(o: Owner, email: string, roleKey: string): Promise<string> {
  const done = await stepped(o.client, (h) =>
    o.client.org(o.orgId, "POST", "/api/team/invitations", { email, roleKey }, h),
  );
  return String(done.json.invitationId);
}

/** A member with no factor in the role given, invited by the owner. */
async function memberIn(o: Owner, roleKey: string): Promise<string> {
  const email = address("member");
  const invitationId = await invitationFrom(o, email, roleKey);
  const member = await signIn(email);
  const joined = await member.call("POST", `/api/invitations/${invitationId}/accept`);
  if (joined.status !== 200) throw new Error(`accept answered ${joined.status}`);
  return String(joined.json.memberId);
}

interface Sent {
  path: string;
  body?: unknown;
}

interface Variant {
  path?: string;
  body?: unknown;
  /** The refusal expected; `digest` unless the change also leaves the intent's organisation. */
  reason?: "digest" | "other_action";
}

interface Scenario {
  who: Client;
  orgId: string | null;
  request: Sent;
  /** Requests differing from `request` in one bound field (keyed by it) or in the target. */
  variants: Record<string, Variant>;
  /** A bound field (or the target) no request can differ in and still reach the step-up, and why. */
  unreachable?: Record<string, string>;
  /** Another session of the same person. */
  other: Client;
}

const SCENARIOS: Record<string, () => Promise<Scenario>> = {
  async sessionRevoke() {
    const p = await withFactor("revoker");
    const second = await anotherSession(p);
    const third = await anotherSession(p);
    return {
      who: p.client,
      orgId: null,
      request: { path: `/api/account/sessions/${await currentSessionOf(second)}/revoke` },
      variants: {
        target: { path: `/api/account/sessions/${await currentSessionOf(third)}/revoke` },
      },
      other: third,
    };
  },

  async sessionsRevokeOthers() {
    const p = await withFactor("everywhere");
    return {
      who: p.client,
      orgId: null,
      request: { path: "/api/account/sessions/revoke-others" },
      variants: {},
      other: await anotherSession(p),
    };
  },

  async trustedBrowserRevoke() {
    const p = await withFactor("forgetter");
    const user = await database.admin.query<{ id: string }>(
      'SELECT id FROM identity."user" WHERE email = $1',
      [p.email],
    );
    const ids = ["tbr_01jd000000000000000000mat1", "tbr_01jd000000000000000000mat2"];
    for (const [i, id] of ids.entries()) {
      await seed(
        database.admin,
        `INSERT INTO identity.trusted_browser (id, user_id, token_hash, label, expires_at)
         VALUES ($1, $2, decode(repeat($3, 32), 'hex'), 'Chrome on Mac', now() + interval '30 days')`,
        [id, user.rows[0]?.id, `d${i}`],
      );
    }
    return {
      who: p.client,
      orgId: null,
      request: { path: `/api/account/trusted-browsers/${ids[0]}` },
      variants: { target: { path: `/api/account/trusted-browsers/${ids[1]}` } },
      other: await anotherSession(p),
    };
  },

  async invitationAccept() {
    const a = await owner("host_a");
    const b = await owner("host_b");
    const invitee = await withFactor("joiner");
    const first = await invitationFrom(a, invitee.email, "admin");
    const second = await invitationFrom(b, invitee.email, "admin");
    return {
      who: invitee.client,
      orgId: null,
      request: { path: `/api/invitations/${first}/accept` },
      // The person can hold one pending invitation per organisation, so the other invitation is in
      // another one: the intent is bound to its organisation, which differs first.
      variants: { target: { path: `/api/invitations/${second}/accept`, reason: "other_action" } },
      other: await anotherSession(invitee),
    };
  },

  async orgsCreate() {
    const p = await withFactor("creator");
    return {
      who: p.client,
      orgId: null,
      request: { path: "/api/orgs", body: { name: "Matrix Alpha" } },
      variants: { name: { body: { name: "Matrix Beta" } } },
      other: await anotherSession(p),
    };
  },

  async orgRename() {
    const o = await owner("renamer");
    return {
      who: o.client,
      orgId: o.orgId,
      request: { path: "/api/org", body: { name: "Renamed Alpha" } },
      variants: { name: { body: { name: "Renamed Beta" } } },
      other: await anotherSession(o),
    };
  },

  async orgDelete() {
    const o = await owner("deleter");
    return {
      who: o.client,
      orgId: o.orgId,
      request: { path: "/api/org", body: { confirmName: o.orgName } },
      variants: {},
      unreachable: {
        confirmName: "any other value is refused as the wrong name before the step-up is asked",
      },
      other: await anotherSession(o),
    };
  },

  async memberRole() {
    const o = await owner("changer");
    const readers = await roleIn(o, "Readers", ["member.read"]);
    const viewers = await roleIn(o, "Viewers", ["webhooks.read"]);
    const first = await memberIn(o, readers);
    const second = await memberIn(o, readers);
    const body = { roleKey: "admin", rollCredentials: true };
    return {
      who: o.client,
      orgId: o.orgId,
      request: { path: `/api/team/members/${first}`, body },
      variants: {
        roleKey: { body: { ...body, roleKey: viewers } },
        rollCredentials: { body: { ...body, rollCredentials: false } },
        target: { path: `/api/team/members/${second}` },
      },
      other: await anotherSession(o),
    };
  },

  async memberRemove() {
    const o = await owner("remover");
    const readers = await roleIn(o, "Readers", ["member.read"]);
    const first = await memberIn(o, readers);
    const second = await memberIn(o, readers);
    return {
      who: o.client,
      orgId: o.orgId,
      request: { path: `/api/team/members/${first}/remove`, body: { rollCredentials: true } },
      variants: {
        rollCredentials: { body: { rollCredentials: false } },
        target: { path: `/api/team/members/${second}/remove` },
      },
      other: await anotherSession(o),
    };
  },

  async invite() {
    const o = await owner("inviter");
    const readers = await roleIn(o, "Readers", ["member.read"]);
    const email = address("invited");
    return {
      who: o.client,
      orgId: o.orgId,
      request: { path: "/api/team/invitations", body: { email, roleKey: "admin" } },
      variants: {
        email: { body: { email: address("elsewhere"), roleKey: "admin" } },
        roleKey: { body: { email, roleKey: readers } },
      },
      other: await anotherSession(o),
    };
  },

  async invitationChange() {
    const o = await owner("invitation_changer");
    const readers = await roleIn(o, "Readers", ["member.read"]);
    const viewers = await roleIn(o, "Viewers", ["webhooks.read"]);
    const first = await invitationFrom(o, address("first"), readers);
    const second = await invitationFrom(o, address("second"), readers);
    return {
      who: o.client,
      orgId: o.orgId,
      request: { path: `/api/team/invitations/${first}`, body: { roleKey: "admin" } },
      variants: {
        roleKey: { body: { roleKey: viewers } },
        target: { path: `/api/team/invitations/${second}` },
      },
      other: await anotherSession(o),
    };
  },

  async invitationResend() {
    const o = await owner("resender");
    const first = await invitationFrom(o, address("first"), "admin");
    const second = await invitationFrom(o, address("second"), "admin");
    return {
      who: o.client,
      orgId: o.orgId,
      request: { path: `/api/team/invitations/${first}/resend` },
      variants: { target: { path: `/api/team/invitations/${second}/resend` } },
      other: await anotherSession(o),
    };
  },

  async invitationCancel() {
    const o = await owner("canceller");
    const first = await invitationFrom(o, address("first"), "admin");
    const second = await invitationFrom(o, address("second"), "admin");
    return {
      who: o.client,
      orgId: o.orgId,
      request: { path: `/api/team/invitations/${first}` },
      variants: { target: { path: `/api/team/invitations/${second}` } },
      other: await anotherSession(o),
    };
  },

  async roleCreate() {
    const o = await owner("role_maker");
    const body = { name: "Matrix role", description: "", permissions: ["member.read"] };
    return {
      who: o.client,
      orgId: o.orgId,
      request: { path: "/api/roles", body },
      variants: {
        name: { body: { ...body, name: "Matrix other" } },
        description: { body: { ...body, description: "Reads the team" } },
        permissions: { body: { ...body, permissions: ["member.read", "auditLog.read"] } },
      },
      other: await anotherSession(o),
    };
  },

  async roleUpdate() {
    const o = await owner("role_editor");
    const first = await roleIn(o, "First", ["member.read"]);
    const second = await roleIn(o, "Second", ["member.read"]);
    const body = {
      name: "First renamed",
      description: "",
      permissions: ["member.read"],
      version: 1,
    };
    return {
      who: o.client,
      orgId: o.orgId,
      request: { path: `/api/roles/${first}`, body },
      variants: {
        name: { body: { ...body, name: "First again" } },
        description: { body: { ...body, description: "Reads the team" } },
        permissions: { body: { ...body, permissions: ["member.read", "auditLog.read"] } },
        target: { path: `/api/roles/${second}` },
      },
      unreachable: {
        version: "any other version is refused as a stale save before the step-up is asked",
      },
      other: await anotherSession(o),
    };
  },

  async roleDelete() {
    const o = await owner("role_deleter");
    const first = await roleIn(o, "Leaving", ["member.read"]);
    const second = await roleIn(o, "Staying", ["member.read"]);
    return {
      who: o.client,
      orgId: o.orgId,
      request: { path: `/api/roles/${first}/delete`, body: { moveTo: "admin" } },
      variants: {
        moveTo: { body: { moveTo: second } },
        target: { path: `/api/roles/${second}/delete` },
      },
      other: await anotherSession(o),
    };
  },
};

const WINDOW_SAMPLES: Record<string, Sent> = {
  accountName: { path: "/api/account/name", body: { name: "Ada Window" } },
};

function send(
  s: { orgId: string | null },
  policy: RoutePolicy,
  client: Client,
  request: Sent,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const body = policy.body === "none" ? undefined : (request.body ?? {});
  return s.orgId === null
    ? client.call(policy.method, request.path, body, headers)
    : client.org(s.orgId, policy.method, request.path, body, headers);
}

const INTENT_ROUTES = CONSOLE_POLICY.filter(
  (p) => p.stepUp === "intent" || p.stepUp === "intent_if_factor",
);
const WINDOW_ROUTES = CONSOLE_POLICY.filter((p) => p.stepUp === "window");

describe("the step-up matrix, from the policy", () => {
  it("has a scenario for every intent route and a sample for every window route", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(INTENT_ROUTES.map((p) => p.id).sort());
    expect(Object.keys(WINDOW_SAMPLES).sort()).toEqual(WINDOW_ROUTES.map((p) => p.id).sort());
  });

  for (const policy of INTENT_ROUTES) {
    it(`${policy.id}: refuses every intent but its own, then passes once`, async () => {
      await database.admin.query("DELETE FROM ops.rate_window");
      const scenario = SCENARIOS[policy.id];
      if (scenario === undefined) throw new Error(`no scenario for ${policy.id}`);
      const s = await scenario();
      // Every bound field, and the target when the path names one, has its "other parameters".
      const covered = new Set([...Object.keys(s.variants), ...Object.keys(s.unreachable ?? {})]);
      const needed = [...(policy.bind ?? []), ...(policy.params === undefined ? [] : ["target"])];
      for (const key of needed) expect(covered.has(key), `${policy.id}: ${key}`).toBe(true);
      for (const key of covered) expect(needed, `${policy.id}: ${key}`).toContain(key);

      const asked = await send(s, policy, s.who, s.request);
      expect(asked.status, JSON.stringify(asked.json)).toBe(403);
      expect(asked.json).toMatchObject({ code: "step_up_required", step_up_kind: "intent" });
      const intent = String(asked.json.intent_id);
      const header = { "fin-step-up-intent": intent };
      const refusal = async (request: Sent, client = s.who) => {
        const res = await send(s, policy, client, request, header);
        expect(res.status, JSON.stringify(res.json)).toBe(403);
        expect(res.json.code, JSON.stringify(res.json)).toBe("step_up_invalid");
        return String(res.json.reason);
      };

      expect(await refusal(s.request)).toBe("unproved");
      await prove(s.who, intent);
      for (const [key, variant] of Object.entries(s.variants)) {
        const request = {
          path: variant.path ?? s.request.path,
          body: variant.body ?? s.request.body,
        };
        expect(await refusal(request), `${policy.id}: ${key}`).toBe(variant.reason ?? "digest");
      }
      expect(await refusal(s.request, s.other)).toBe("other_session");
      await seed(
        database.admin,
        `UPDATE ops.step_up_intent
            SET created_at = now() - interval '6 minutes', expires_at = now() - interval '1 second'
          WHERE id = $1`,
        [intent],
      );
      expect(await refusal(s.request)).toBe("expired");
      await seed(
        database.admin,
        `UPDATE ops.step_up_intent
            SET created_at = now(), expires_at = now() + interval '5 minutes', consumed_at = now()
          WHERE id = $1`,
        [intent],
      );
      expect(await refusal(s.request)).toBe("used");
      await seed(database.admin, "UPDATE ops.step_up_intent SET consumed_at = NULL WHERE id = $1", [
        intent,
      ]);

      // None of the refusals spent it: the unchanged request passes once.
      const done = await send(s, policy, s.who, s.request, header);
      expect(done.status, JSON.stringify(done.json)).toBeLessThan(300);
      const row = await database.admin.query<{ consumed_at: Date | null }>(
        "SELECT consumed_at FROM ops.step_up_intent WHERE id = $1",
        [intent],
      );
      expect(row.rows[0]?.consumed_at).not.toBeNull();
      const events = await database.admin.query<{ event: string }>(
        "SELECT event FROM audit.event WHERE step_up_ref = $1",
        [intent],
      );
      expect(events.rows.map((e) => e.event)).toContain(policy.audit[0]);
      const again = await send(s, policy, s.who, s.request, header);
      expect(again.status).toBeGreaterThanOrEqual(400);
      if (again.json.code === "step_up_invalid") expect(again.json.reason).toBe("used");
    }, 120_000);
  }

  for (const policy of WINDOW_ROUTES) {
    it(`${policy.id}: passes within the window of a proof, and not after`, async () => {
      const p = await withFactor(`window_${policy.id.toLowerCase()}`);
      const sample = WINDOW_SAMPLES[policy.id] as Sent;
      const s = { orgId: null };
      // Setting up the authenticator just proved a factor.
      const fresh = await send(s, policy, p.client, sample);
      expect(fresh.status, JSON.stringify(fresh.json)).toBeLessThan(300);
      await database.admin.query(
        `UPDATE identity.assurance SET created_at = created_at - interval '6 minutes'
          WHERE user_id = (SELECT id FROM identity."user" WHERE email = $1)`,
        [p.email],
      );
      const stale = await send(s, policy, p.client, sample);
      expect(stale.json).toMatchObject({ code: "step_up_required", step_up_kind: "window" });
      expect(stale.json.intent_id).toBeUndefined();
      await prove(p.client);
      const again = await send(s, policy, p.client, sample);
      expect(again.status, JSON.stringify(again.json)).toBeLessThan(300);
    }, 60_000);
  }
});
