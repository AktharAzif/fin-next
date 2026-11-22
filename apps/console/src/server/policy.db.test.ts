// The refusal matrix, generated from the route policy (spec 02 §14.1; T-SAT-31, AC-SAT-04, AC-SAT-13;
// T-SAT-30's full per-route step-up matrix is step-up.db.test.ts): for every route of the console's
// policy, over HTTP through the real front door, as the policy declares it,
//   - signed out: `401 unauthenticated` (every route but the public ones);
//   - an organisation route without `Fin-Organization`: `400 organization_required`; with another
//     organisation's: `404 not_found`, the same as an unknown one;
//   - a role lacking the route's permission: `403 forbidden` naming the permission;
//   - a step-up route with no intent: `403 step_up_required` with its action's reason; with an intent
//     proved for another action: `403 step_up_invalid` (`other_action`); a window route with no fresh
//     proof: `403 step_up_required` of kind `window`;
//   - a read: 200 for a member who may read it.
// Every route must have its sample here, so a route added to the policy without one fails the test.
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
  steppedUp,
} from "../../test/client.ts";
import { defineConsoleService } from "./main.ts";
import { CONSOLE_POLICY, type RouteId } from "./policy/index.ts";

let database: TestDatabase;
let api: Booted;

const tag = randomBytes(3).toString("hex");
const address = (label: string) => `${label}.${tag}@example.com`;

async function signIn(email: string, factor: boolean): Promise<Client> {
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
  if (factor) await enrolAuthenticator(client);
  return client;
}

interface Fixture {
  owner: Client;
  limited: Client;
  invitee: Client;
  stranger: Client;
  orgId: string;
  orgName: string;
  otherOrgId: string;
  limitedMemberId: string;
  limitedRoleId: string;
  roleVersion: number;
  invitationId: string;
  inviteeInvitationId: string;
  ownerOtherSessionId: string;
  trustedBrowserId: string;
}

let f: Fixture;

beforeAll(async () => {
  database = await createTestDatabase("policy");
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
  const owner = await signIn(address("owner"), true);
  const first = await owner.call("POST", "/api/orgs/first");
  const orgId = String(first.json.orgId);
  const org = await owner.org(orgId, "GET", "/api/org");
  const role = await steppedUp(database.admin, owner, (h) =>
    owner.org(
      orgId,
      "POST",
      "/api/roles",
      { name: "Webhook readers", permissions: ["webhooks.read"] },
      h,
    ),
  );
  const limitedRoleId = String(role.done.json.roleId);
  const limitedEmail = address("limited");
  const invited = await steppedUp(database.admin, owner, (h) =>
    owner.org(
      orgId,
      "POST",
      "/api/team/invitations",
      { email: limitedEmail, roleKey: limitedRoleId },
      h,
    ),
  );
  const limited = await signIn(limitedEmail, false);
  const joined = await limited.call(
    "POST",
    `/api/invitations/${String(invited.done.json.invitationId)}/accept`,
  );
  const pending = await steppedUp(database.admin, owner, (h) =>
    owner.org(
      orgId,
      "POST",
      "/api/team/invitations",
      { email: address("pending"), roleKey: limitedRoleId },
      h,
    ),
  );
  const inviteeEmail = address("invitee");
  const inviteeInvitation = await steppedUp(database.admin, owner, (h) =>
    owner.org(
      orgId,
      "POST",
      "/api/team/invitations",
      { email: inviteeEmail, roleKey: limitedRoleId },
      h,
    ),
  );
  const invitee = await signIn(inviteeEmail, true);
  const other = await signIn(address("other"), true);
  const otherOrg = await other.call("POST", "/api/orgs/first");
  // A second session of the owner's, and a trusted browser row, for the account routes.
  await signIn(address("owner"), false).catch(() => undefined);
  const sessions = await database.admin.query<{ id: string; user_id: string }>(
    `SELECT s.id, s.user_id FROM identity.session s JOIN identity."user" u ON u.id = s.user_id
      WHERE u.email = $1 ORDER BY s.created_at`,
    [address("owner")],
  );
  const ownerUserId = String(sessions.rows[0]?.user_id);
  const ownerCurrent = await owner.call("GET", "/api/account/sessions");
  const currentId = (ownerCurrent.json.items as { id: string; current: boolean }[]).find(
    (s) => s.current,
  )?.id;
  const otherSession = sessions.rows.find((s) => s.id !== currentId)?.id;
  const trustedBrowserId = "tbr_01jd0000000000000000000001";
  await seed(
    database.admin,
    `INSERT INTO identity.trusted_browser (id, user_id, token_hash, label, expires_at)
     VALUES ($1, $2, decode(repeat('cd', 32), 'hex'), 'Chrome on Mac', now() + interval '30 days')`,
    [trustedBrowserId, ownerUserId],
  );
  f = {
    owner,
    limited,
    invitee,
    stranger: new Client(api),
    orgId,
    orgName: String(org.json.name),
    otherOrgId: String(otherOrg.json.orgId),
    limitedMemberId: String(joined.json.memberId),
    limitedRoleId,
    roleVersion: 1,
    invitationId: String(pending.done.json.invitationId),
    inviteeInvitationId: String(inviteeInvitation.done.json.invitationId),
    ownerOtherSessionId: String(otherSession),
    trustedBrowserId,
  };
  // Window step-ups need a fresh proof: the fixture's proofs are made stale.
  await database.admin.query(
    "UPDATE identity.assurance SET created_at = created_at - interval '1 hour'",
  );
}, 120_000);

afterAll(async () => {
  await api?.stop();
  await database?.drop();
}, DROP_TIMEOUT_MS);

interface Sample {
  path: () => string;
  body?: () => unknown;
  /** Who reaches the step-up for this route (the owner unless named). */
  as?: () => Client;
}

const SAMPLES: Record<RouteId, Sample> = {
  signUp: {
    path: () => "/api/sign-up",
    body: () => ({ name: "New Person", email: address("new") }),
  },
  codeLink: { path: () => "/api/sign-in/code-link", body: () => ({ email: address("new") }) },
  viewer: { path: () => "/api/viewer" },
  viewerOrganization: { path: () => "/api/viewer/organization", body: () => ({ orgId: f.orgId }) },
  invitationOpen: {
    path: () => "/api/invitations/open",
    body: () => ({ token: randomBytes(32).toString("base64url") }),
  },
  invitationCurrent: { path: () => "/api/invitation" },
  invitationsMine: { path: () => "/api/invitations/mine" },
  invitationAccept: {
    path: () => `/api/invitations/${f.inviteeInvitationId}/accept`,
    as: () => f.invitee,
  },
  invitationDecline: { path: () => `/api/invitations/${f.inviteeInvitationId}/decline` },
  accountSecurity: { path: () => "/api/account/security" },
  accountPasskeys: { path: () => "/api/account/passkeys" },
  accountSessions: { path: () => "/api/account/sessions" },
  accountActivity: { path: () => "/api/account/activity" },
  accountName: { path: () => "/api/account/name", body: () => ({ name: "Ada Renamed" }) },
  sessionRevoke: { path: () => `/api/account/sessions/${f.ownerOtherSessionId}/revoke` },
  sessionsRevokeOthers: { path: () => "/api/account/sessions/revoke-others" },
  trustedBrowserRevoke: { path: () => `/api/account/trusted-browsers/${f.trustedBrowserId}` },
  orgsList: { path: () => "/api/orgs" },
  orgsCreate: { path: () => "/api/orgs", body: () => ({ name: "Another Team" }) },
  orgsFirst: { path: () => "/api/orgs/first" },
  orgGet: { path: () => "/api/org" },
  orgRename: { path: () => "/api/org", body: () => ({ name: "Renamed Team" }) },
  orgDelete: { path: () => "/api/org", body: () => ({ confirmName: f.orgName }) },
  team: { path: () => "/api/team" },
  memberCredentials: { path: () => `/api/team/members/${f.limitedMemberId}/credentials` },
  memberRole: {
    path: () => `/api/team/members/${f.limitedMemberId}`,
    body: () => ({ roleKey: "admin" }),
  },
  memberRemove: { path: () => `/api/team/members/${f.limitedMemberId}/remove`, body: () => ({}) },
  invite: {
    path: () => "/api/team/invitations",
    body: () => ({ email: address("matrix"), roleKey: "admin" }),
  },
  invitationChange: {
    path: () => `/api/team/invitations/${f.invitationId}`,
    body: () => ({ roleKey: "admin" }),
  },
  invitationResend: { path: () => `/api/team/invitations/${f.invitationId}/resend` },
  invitationCancel: { path: () => `/api/team/invitations/${f.invitationId}` },
  roles: { path: () => "/api/roles" },
  role: { path: () => "/api/roles/admin" },
  roleCreate: {
    path: () => "/api/roles",
    body: () => ({ name: "Matrix readers", permissions: ["member.read"] }),
  },
  roleUpdate: {
    path: () => `/api/roles/${f.limitedRoleId}`,
    body: () => ({
      name: "Webhook readers",
      permissions: ["webhooks.read", "member.read"],
      version: f.roleVersion,
    }),
  },
  roleDelete: {
    path: () => `/api/roles/${f.limitedRoleId}/delete`,
    body: () => ({ moveTo: "admin" }),
  },
  auditLog: { path: () => "/api/audit-log" },
};

function send(
  client: Client,
  routeId: RouteId,
  orgId: string | null,
  headers: Record<string, string> = {},
) {
  const policy = CONSOLE_POLICY.find((p) => p.id === routeId);
  if (policy === undefined) throw new Error(routeId);
  const sample = SAMPLES[routeId];
  const body = policy.body === "none" ? undefined : (sample.body?.() ?? {});
  return orgId === null
    ? client.call(policy.method, sample.path(), body, headers)
    : client.org(orgId, policy.method, sample.path(), body, headers);
}

describe("the refusal matrix, from the policy", () => {
  it("has a sample for every route", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(CONSOLE_POLICY.map((p) => p.id).sort());
  });

  for (const policy of CONSOLE_POLICY) {
    const id = policy.id as RouteId;
    const org = policy.scope === "organization";

    if (policy.guard !== "public") {
      it(`${id}: signed out is 401 unauthenticated`, async () => {
        const res = await send(f.stranger, id, org ? f.orgId : null);
        expect(res.status, JSON.stringify(res.json)).toBe(401);
        expect(res.json.code).toBe("unauthenticated");
      });
    }

    if (org) {
      it(`${id}: no Fin-Organization is 400, another organisation's is 404`, async () => {
        const missing = await send(f.owner, id, null);
        expect(missing.status).toBe(400);
        expect(missing.json.code).toBe("organization_required");
        const foreign = await send(f.owner, id, f.otherOrgId);
        expect(foreign.status).toBe(404);
        expect(foreign.json.code).toBe("not_found");
      });
    }

    const permissions =
      policy.permission !== undefined ? [policy.permission] : (policy.anyOf ?? []);
    if (org && permissions.length > 0) {
      it(`${id}: a role without ${permissions.join(" or ")} is 403 forbidden`, async () => {
        const res = await send(f.limited, id, f.orgId);
        expect(res.status, JSON.stringify(res.json)).toBe(403);
        expect(res.json.code).toBe("forbidden");
        expect(String(res.json.permission)).toContain(permissions[0] as string);
      });
    }

    if (policy.stepUp === "intent" || policy.stepUp === "intent_if_factor") {
      it(`${id}: no intent is 403 step_up_required; another action's intent is step_up_invalid`, async () => {
        const who = SAMPLES[id].as?.() ?? f.owner;
        // Each route makes two intents; the session's allowance (30 per 10 minutes) is not under test.
        await database.admin.query("DELETE FROM ops.rate_window");
        const asked = await send(who, id, org ? f.orgId : null);
        expect(asked.status, JSON.stringify(asked.json)).toBe(403);
        expect(asked.json).toMatchObject({ code: "step_up_required", step_up_kind: "intent" });
        expect(asked.json.intent_id).toMatch(/^sti_/);
        // An intent proved for another action never serves this one.
        const elsewhere = await who.call("POST", "/api/orgs", { name: "Elsewhere" });
        const otherIntent = String(elsewhere.json.intent_id);
        await database.admin.query("UPDATE identity.totp_step SET last_step = 0");
        await who.call(
          "POST",
          "/api/auth/two-factor/verify-totp",
          { code: totpCode(who.secret as Uint8Array, new Date()) },
          { "fin-step-up-intent": otherIntent },
        );
        const refused = await send(who, id, org ? f.orgId : null, {
          "fin-step-up-intent": otherIntent,
        });
        if (id === "orgsCreate") {
          // The same action: the digest is the refusal, the name differing.
          expect(refused.json).toMatchObject({ code: "step_up_invalid", reason: "digest" });
        } else {
          expect(refused.json).toMatchObject({ code: "step_up_invalid", reason: "other_action" });
        }
        // Proving now made a fresh window; it must not open an intent route on its own.
        const still = await send(who, id, org ? f.orgId : null);
        expect(still.json.code).toBe("step_up_required");
        await database.admin.query(
          "UPDATE identity.assurance SET created_at = created_at - interval '1 hour'",
        );
      });
    }

    if (policy.stepUp === "window") {
      it(`${id}: no fresh proof is 403 step_up_required of kind window`, async () => {
        const res = await send(f.owner, id, null);
        expect(res.status).toBe(403);
        expect(res.json).toMatchObject({ code: "step_up_required", step_up_kind: "window" });
        expect(res.json.intent_id).toBeUndefined();
      });
    }

    if (policy.method === "GET" && policy.guard !== "public") {
      it(`${id}: a member who may read it gets 200`, async () => {
        const res = await send(f.owner, id, org ? f.orgId : null);
        expect(res.status, JSON.stringify(res.json)).toBe(200);
      });
    }
  }
});
