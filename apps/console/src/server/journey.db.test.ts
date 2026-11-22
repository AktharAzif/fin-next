// The console's API end to end (the lane's journey over HTTP, AC-SAT-15's server half): the API half
// booted on a real socket with the ingress check and the origin gate in front, the developer realm
// and Fin's routes behind, on Postgres 18 as the console's own login. A person signs up with the
// emailed code, enrols an authenticator, gets the first organisation, makes a custom role, invites
// someone with an intent; the invitee opens the link, signs in and accepts; the owner changes the
// invitee's role and removes them. Every step's audit event is on the organisation's audit log with
// the address and the device, and every notice is queued.
import { randomBytes } from "node:crypto";
import { bootApi } from "@fin/web-host/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  DROP_TIMEOUT_MS,
  type TestDatabase,
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

let database: TestDatabase;
let api: Booted;

beforeAll(async () => {
  database = await createTestDatabase("journey");
  api = await bootApi(defineConsoleService({ pool: database.login("fin_console") }), {
    service: "console",
    roles: ["console"],
    env: {
      FIN_PUBLIC_ORIGIN: ORIGIN,
      FIN_CONNECTOR_SERVICES: "cloudflared-public",
      FIN_DOCS_ORIGIN: "https://developer.example.com",
      BETTER_AUTH_SECRETS: `2:${randomBytes(32).toString("base64url")},1:${randomBytes(32).toString("base64url")}`,
      FIN_LIMIT_KEY_1: randomBytes(32).toString("hex"),
    },
  });
});

afterAll(async () => {
  await api?.stop();
  await database?.drop();
}, DROP_TIMEOUT_MS);

const tag = randomBytes(3).toString("hex");
const ownerEmail = `owner.${tag}@example.com`;
const inviteeEmail = `invitee.${tag}@example.com`;

describe("the console's API, end to end", () => {
  // Genuinely heavy, so a timeout of its own: the whole journey is one test, about 40 requests over
  // a real socket through the front door, with two code sign-ins, a factor enrolment and four
  // stepped-up actions with their proofs. Alone it takes 0.9 to 1.4 s; in the full db run on 4
  // CPUs, 2.4 s to past the 5 s default.
  it("signs up, enrols a factor, creates an organisation, invites, accepts, changes a role and removes a member", async () => {
    const owner = new Client(api);

    // Sign up: a code to the address, the account made only when the code comes back (S2-05).
    const signUp = await owner.call("POST", "/api/sign-up", {
      name: "Ada Owner",
      email: ownerEmail,
    });
    expect(signUp.status).toBe(202);
    expect(signUp.json).toEqual({ status: "code_sent" });
    const signedIn = await owner.call("POST", "/api/auth/sign-in/email-otp", {
      email: ownerEmail,
      otp: await latestCode(database.admin, ownerEmail),
    });
    expect(signedIn.status).toBe(200);
    const fresh = await owner.call("GET", "/api/viewer");
    expect(fresh.status).toBe(200);
    expect(fresh.json).toMatchObject({ gate: "ok", memberships: [], currentOrgId: null });
    expect(fresh.json.canSkipProtect).toBe(true);

    // The first factor, within the first-factor window (§6.3).
    await enrolAuthenticator(owner);

    // The first organisation, as its Super admin (§5.9).
    const first = await owner.call("POST", "/api/orgs/first");
    expect(first.status).toBe(201);
    const orgId = String(first.json.orgId);
    const viewer = await owner.call("GET", "/api/viewer");
    expect(viewer.json).toMatchObject({ gate: "ok", currentOrgId: orgId });
    expect((viewer.json.permissions as string[]).length).toBe(26);
    expect(viewer.json.factors).toMatchObject({ authenticator: true, backupCodesLeft: 10 });

    // A custom role, made with an intent (§8.4).
    const role = await steppedUp(database.admin, owner, (headers) =>
      owner.org(
        orgId,
        "POST",
        "/api/roles",
        { name: "Support", description: "", permissions: ["member.read", "auditLog.read"] },
        headers,
      ),
    );
    expect(role.asked.json).toMatchObject({ code: "step_up_required", reason_key: "create_role" });
    expect(role.done.status).toBe(201);
    const roleId = String(role.done.json.roleId);

    // The invitation, with an intent bound to the address and the role (§7.6, §9.3).
    const invite = await steppedUp(database.admin, owner, (headers) =>
      owner.org(
        orgId,
        "POST",
        "/api/team/invitations",
        { email: inviteeEmail, roleKey: "admin" },
        headers,
      ),
    );
    expect(invite.done.status).toBe(201);
    const invitationId = String(invite.done.json.invitationId);
    const team = await owner.org(orgId, "GET", "/api/team");
    expect(
      (team.json.invitations as { invitationId: string }[]).map((i) => i.invitationId),
    ).toEqual([invitationId]);

    // The invitee opens the link (the token from the fragment, in a body), then signs in.
    const mail = await database.admin.query<{ token: string }>(
      `SELECT params ->> 'token' AS token FROM email_private.outbox
        WHERE recipient = $1 AND template = 'orgs/invitation'`,
      [inviteeEmail],
    );
    const token = String(mail.rows[0]?.token);
    const invitee = new Client(api);
    const opened = await invitee.call("POST", "/api/invitations/open", { token });
    expect(opened.status).toBe(200);
    expect(opened.json).toMatchObject({ invitationId, state: "signed_out", roleLabel: "Admin" });
    expect(String(opened.json.email)).toMatch(/^i•••@example\.com$/);
    expect(opened.cookies.some((c) => c.startsWith("__Host-fin.invitation="))).toBe(true);
    const unknown = await invitee.call("POST", "/api/invitations/open", {
      token: randomBytes(32).toString("base64url"),
    });
    expect(unknown).toMatchObject({ status: 404, json: { code: "invitation_unusable" } });

    const sent = await invitee.call("POST", "/api/auth/email-otp/send-verification-otp", {
      email: inviteeEmail,
      type: "sign-in",
    });
    expect(sent.status).toBe(200);
    const inviteeIn = await invitee.call("POST", "/api/auth/sign-in/email-otp", {
      email: inviteeEmail,
      otp: await latestCode(database.admin, inviteeEmail),
    });
    expect(inviteeIn.status).toBe(200);
    const fromCookie = await invitee.call("GET", "/api/invitation");
    expect(fromCookie.json).toMatchObject({ invitationId, state: "for_you" });
    const mine = await invitee.call("GET", "/api/invitations/mine");
    expect((mine.json.invitations as { invitationId: string }[])[0]?.invitationId).toBe(
      invitationId,
    );

    // Accepting: the invitee has no factor yet, so no intent (§7.6); the Admin role then holds them.
    const accepted = await invitee.call("POST", `/api/invitations/${invitationId}/accept`);
    expect(accepted.status).toBe(200);
    const memberId = String(accepted.json.memberId);
    const held = await invitee.call("GET", "/api/viewer");
    expect(held.json).toMatchObject({ gate: "protect_account", canSkipProtect: false });
    const used = await invitee.call("POST", "/api/invitations/open", { token });
    expect(used.status).toBe(404);

    // The owner changes the invitee's role to the custom one, with an intent.
    const changed = await steppedUp(database.admin, owner, (headers) =>
      owner.org(orgId, "PATCH", `/api/team/members/${memberId}`, { roleKey: roleId }, headers),
    );
    expect(changed.done.status).toBe(200);
    const notHeld = await invitee.call("GET", "/api/viewer");
    expect(notHeld.json).toMatchObject({ gate: "ok", currentOrgId: orgId });
    expect([...(notHeld.json.permissions as string[])].sort()).toEqual([
      "auditLog.read",
      "member.read",
    ]);
    const refused = await invitee.org(orgId, "POST", "/api/team/invitations", {
      email: `other.${tag}@example.com`,
      roleKey: roleId,
    });
    expect(refused).toMatchObject({
      status: 403,
      json: { code: "forbidden", permission: "member.invite" },
    });

    // The owner removes them, with an intent; their access to the organisation ends at once.
    const removed = await steppedUp(database.admin, owner, (headers) =>
      owner.org(orgId, "POST", `/api/team/members/${memberId}/remove`, {}, headers),
    );
    expect(removed.done.status).toBe(200);
    expect(removed.done.json.credentials).toEqual({
      listed: 0,
      rolledNow: 0,
      rollingWithinHour: 0,
    });
    const gone = await invitee.org(orgId, "GET", "/api/team");
    expect(gone).toMatchObject({ status: 404, json: { code: "not_found" } });

    // The organisation's audit log: every step, with the address and the device ([BC-03]).
    const log = await owner.org(orgId, "GET", "/api/audit-log?range=all&size=100");
    expect(log.status).toBe(200);
    const items = log.json.items as {
      event: string;
      address: string | null;
      device: string | null;
      verification: string;
      actor: { id: string };
    }[];
    const events = items.map((i) => i.event);
    for (const event of [
      "organization.created",
      "role.created",
      "member.invited",
      "member.joined",
      "member.role_changed",
      "member.removed",
    ]) {
      expect(events, event).toContain(event);
    }
    const removal = items.find((i) => i.event === "member.removed");
    expect(removal).toMatchObject({ address: owner.ip, verification: "totp" });
    expect(removal?.device).toBe("Chrome on Mac");
    const joined = items.find((i) => i.event === "member.joined");
    expect(joined?.address).toBe(invitee.ip);

    // The filtered view of §15.2.1: the member's own rows only.
    const filtered = await owner.org(orgId, "GET", `/api/audit-log?range=all&target=${memberId}`);
    const filteredEvents = (filtered.json.items as { event: string }[]).map((i) => i.event).sort();
    expect(filteredEvents).toEqual(["member.joined", "member.removed", "member.role_changed"]);
    // The member no longer exists, so the object has no current label (§14.5).
    expect(filtered.json.filterLabel).toBeNull();
    const byRole = await owner.org(orgId, "GET", `/api/audit-log?range=all&target=${roleId}`);
    expect((byRole.json.items as { event: string }[]).map((i) => i.event)).toEqual([
      "role.created",
    ]);
    expect(byRole.json.filterLabel).toBe("Support");
    const roles = await owner.org(orgId, "GET", "/api/audit-log?range=all&targetKind=role");
    expect((roles.json.items as { event: string }[]).map((i) => i.event)).toEqual(["role.created"]);

    // The notices, each queued in its action's transaction.
    const outbox = await database.admin.query<{ template: string; recipient: string }>(
      "SELECT template, recipient FROM email_private.outbox WHERE template LIKE 'orgs/%' ORDER BY created_at, id",
    );
    const sentTo = outbox.rows.map((r) => `${r.template} ${r.recipient}`);
    expect(sentTo).toEqual(
      expect.arrayContaining([
        `orgs/invitation ${inviteeEmail}`,
        `orgs/member-joined ${ownerEmail}`,
        `orgs/member-role-changed ${inviteeEmail}`,
        `orgs/member-role-changed ${ownerEmail}`,
        `orgs/member-removed ${inviteeEmail}`,
        `orgs/member-removed ${ownerEmail}`,
      ]),
    );

    // The request lines carry no address, name or token (spec 02 §18).
    const leaked = api.stdout.filter((l) => JSON.stringify(l).includes(inviteeEmail));
    expect(leaked).toEqual([]);
  }, 20_000);
});
