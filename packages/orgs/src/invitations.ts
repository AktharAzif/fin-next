// Invitations (spec 02 §9.3; [SA-32], [SA-34], S2-15, S2-29). The token is 32 random bytes; only its
// SHA-256 is stored; it travels in the link's fragment and in a request body only, never in a path,
// and is exchanged for a host-only cookie. Accepting needs the account's address to equal the
// invitation's exactly, the invitation pending and unexpired, the inviter still allowed to give the
// role (re-read inside the team-change lock), and an intent once the person has a factor. Changing
// its role or resending it issues a new token, so the old link stops working.
import type { RoleLookup } from "@fin/access";
import type { UnitTx } from "@fin/identity";
import { revokeTrustedBrowsers } from "./browsers.ts";
import { displayValue, orgNameForEmail, roleLabelForEmail } from "./email.ts";
import { notFound, OrgRefusal } from "./errors.ts";
import type { Guarded, OrgActor } from "./guard.ts";
import { isId, newId } from "./ids.ts";
import { PENDING_INVITATIONS } from "./limits.ts";
import { notifyEach, type Orgs } from "./orgs.ts";
import { checkActing, checkGiving, type LockedActor, lockTeam } from "./rules.ts";
import {
  addressesOfRoles,
  CATALOGUE,
  customRolesOf,
  labelOf,
  lockOrganization,
  lookupRole,
  membershipOf,
  permissionsFor,
} from "./store.ts";
import { maskAddress, newInvitationToken, tokenHash } from "./tokens.ts";

export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role_key: string;
  invited_by: string;
  created_at: Date;
  expires_at: Date;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
}

const INVITATION_COLUMNS =
  "i.id, i.organization_id, i.email, i.role_key, i.invited_by, i.created_at, i.expires_at, i.status";

function live(row: InvitationRow, now: Date): boolean {
  return row.status === "pending" && row.expires_at.getTime() > now.getTime();
}

async function invitationById(
  tx: UnitTx,
  id: string,
  options: { orgId?: string; lock?: boolean } = {},
): Promise<InvitationRow | null> {
  const result = await tx.query<InvitationRow>(
    `SELECT ${INVITATION_COLUMNS} FROM identity.invitation i
      WHERE i.id = $1 AND ($2::text IS NULL OR i.organization_id = $2)${options.lock === true ? " FOR UPDATE" : ""}`,
    [id, options.orgId ?? null],
  );
  return result.rows[0] ?? null;
}

export type InvitationState = "for_you" | "other_account" | "signed_out";

export interface InvitationView {
  invitationId: string;
  orgName: string;
  inviter: { name: string; email: string } | null;
  roleLabel: string;
  email: string;
  expiresAt: string;
  state: InvitationState;
}

/** The same answer for an unknown, expired, answered or cancelled invitation (§9.3). */
function unusable(reason: string): OrgRefusal {
  return new OrgRefusal("invitation_unusable", `invitation.${reason}`);
}

async function viewOf(
  tx: UnitTx,
  row: InvitationRow,
  viewer: { email: string } | null,
): Promise<InvitationView> {
  const org = await tx.query<{ name: string }>(
    "SELECT name FROM identity.organization WHERE id = $1 AND deleted_at IS NULL",
    [row.organization_id],
  );
  const orgName = org.rows[0]?.name;
  if (orgName === undefined) throw unusable("organisation_deleted");
  const inviter = await tx.query<{ name: string; email: string }>(
    'SELECT name, email FROM identity."user" WHERE id = $1',
    [row.invited_by],
  );
  const roles = await customRolesOf(tx, row.organization_id);
  return {
    invitationId: row.id,
    orgName,
    inviter: inviter.rows[0] ?? null,
    roleLabel: labelOf(lookupRole(roles, row.role_key)),
    email: maskAddress(row.email),
    expiresAt: row.expires_at.toISOString(),
    state:
      viewer === null ? "signed_out" : viewer.email === row.email ? "for_you" : "other_account",
  };
}

/**
 * `POST /api/invitations/open` (§9.3), public: a live token answers the display data and the
 * cookie's value; anything else is the one `404 invitation_unusable`.
 */
export async function openInvitation(
  orgs: Orgs,
  tx: UnitTx,
  token: string,
  viewer: { email: string } | null,
): Promise<{ view: InvitationView; cookie: string }> {
  const result = await tx.query<InvitationRow>(
    `SELECT ${INVITATION_COLUMNS} FROM identity.invitation i WHERE i.token_hash = $1`,
    [tokenHash(token)],
  );
  const row = result.rows[0];
  const now = orgs.clock.now();
  if (row === undefined || !live(row, now)) throw unusable("token");
  const view = await viewOf(tx, row, viewer);
  return { view, cookie: orgs.invitationCookie.sign(row.id, now) };
}

/** `GET /api/invitation` (§14.2), public: the invitation the cookie names, with its state. */
export async function invitationFromCookie(
  orgs: Orgs,
  tx: UnitTx,
  cookie: string | null,
  viewer: { email: string } | null,
): Promise<InvitationView> {
  const now = orgs.clock.now();
  const id = orgs.invitationCookie.verify(cookie, now);
  if (id === null) throw unusable("cookie");
  const row = await invitationById(tx, id);
  if (row === null || !live(row, now)) throw unusable("cookie");
  return viewOf(tx, row, viewer);
}

/** `GET /api/invitations/mine` (§9.3): pending invitations for the signed-in person's address. */
export async function myInvitations(
  orgs: Orgs,
  tx: UnitTx,
  who: Guarded,
): Promise<{ invitationId: string; orgName: string; roleLabel: string; expiresAt: string }[]> {
  return pendingInvitationsFor(orgs, tx, who.person.email);
}

export async function pendingInvitationsFor(
  orgs: Orgs,
  tx: UnitTx,
  email: string,
): Promise<{ invitationId: string; orgName: string; roleLabel: string; expiresAt: string }[]> {
  const rows = await tx.query<InvitationRow & { org_name: string }>(
    `SELECT ${INVITATION_COLUMNS}, o.name AS org_name FROM identity.invitation i
       JOIN identity.organization o ON o.id = i.organization_id AND o.deleted_at IS NULL
      WHERE i.email = $1 AND i.status = 'pending' AND i.expires_at > $2
      ORDER BY i.created_at, i.id`,
    [email.toLowerCase(), orgs.clock.now()],
  );
  const out: { invitationId: string; orgName: string; roleLabel: string; expiresAt: string }[] = [];
  for (const row of rows.rows) {
    const roles = await customRolesOf(tx, row.organization_id);
    out.push({
      invitationId: row.id,
      orgName: row.org_name,
      roleLabel: labelOf(lookupRole(roles, row.role_key)),
      expiresAt: row.expires_at.toISOString(),
    });
  }
  return out;
}

/**
 * Reads the invitation for an answer by its invitee: the organisation's team-change lock first, then
 * the row; the address rule, pending and unexpired. Anything else is `404 invitation_unusable`.
 */
async function lockForInvitee(
  orgs: Orgs,
  tx: UnitTx,
  who: Guarded,
  invitationId: string,
): Promise<InvitationRow> {
  if (!isId(invitationId, "inv")) throw unusable("id");
  const first = await invitationById(tx, invitationId);
  if (first === null) throw unusable("id");
  const org = await lockOrganization(tx, first.organization_id);
  if (org === null) throw unusable("organisation_deleted");
  const row = await invitationById(tx, invitationId, { lock: true });
  // Every account's address is mailbox-proved (§5.1): the address rule is an exact match.
  if (row === null || row.email !== who.person.email || !live(row, orgs.clock.now())) {
    throw unusable("address_or_state");
  }
  return row;
}

/**
 * `POST /api/invitations/:invitationId/accept` (§9.3): makes the membership, writes `member.joined`,
 * queues `member-joined` to the inviter and every Super admin, and makes the organisation current.
 */
export async function acceptInvitation(
  orgs: Orgs,
  tx: UnitTx,
  who: Guarded,
  invitationId: string,
): Promise<{ orgId: string; memberId: string; roleKey: string }> {
  const row = await lockForInvitee(orgs, tx, who, invitationId);
  const orgId = row.organization_id;
  if ((await membershipOf(tx, orgId, who.person.id)) !== null) {
    throw new OrgRefusal("already_member", "invitation.already_member");
  }
  // The inviter must still be allowed to give the role, read again inside the lock.
  const inviter = await membershipOf(tx, orgId, row.invited_by, { lock: true });
  const roles = await customRolesOf(tx, orgId, { lock: true });
  const offered = lookupRole(roles, row.role_key);
  if (inviter === null) throw unusable("inviter_gone");
  const inviterRole = lookupRole(roles, inviter.roleKey);
  const me: LockedActor = {
    member: inviter,
    roleKey: inviter.roleKey,
    role: inviterRole,
    permissions: permissionsFor(inviterRole),
    roles,
  };
  if (!me.permissions.has("member.invite")) throw unusable("inviter_cannot_invite");
  try {
    checkGiving(me, { targetIsSelf: false, next: offered });
  } catch {
    throw unusable("inviter_cannot_give");
  }
  await who.confirm({ body: {}, target: row.id, organizationId: orgId });
  const now = orgs.clock.now();
  const memberId = newId("mem", orgs.clock);
  await tx.query(
    `INSERT INTO identity.member (id, organization_id, user_id, role_key, invited_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [memberId, orgId, who.person.id, row.role_key, row.invited_by, now],
  );
  await tx.query(
    `UPDATE identity.invitation SET status = 'accepted', answered_at = $2, answered_by = $3
      WHERE id = $1`,
    [row.id, now, who.person.id],
  );
  await tx.query(
    "UPDATE identity.session SET current_organization_id = $1, updated_at = $3 WHERE id = $2",
    [orgId, who.person.sessionId, now],
  );
  await orgs.audit(tx, {
    event: "member.joined",
    actor: who.actor,
    target: memberId,
    refs: [row.id, who.person.id, orgId],
    organizationId: orgId,
    metadata: { roleKey: row.role_key },
    context: who.context,
  });
  const org = await tx.query<{ name: string; live_status: string }>(
    "SELECT name, live_status FROM identity.organization WHERE id = $1",
    [orgId],
  );
  const orgName = org.rows[0]?.name ?? "";
  if (org.rows[0]?.live_status === "approved") {
    // Joining an organisation with Production access ends any trusted browser (§6.6, S2-40).
    await revokeTrustedBrowsers(
      orgs,
      tx,
      [who.person.id],
      "production_access",
      who.actor,
      who.context,
    );
  }
  const personName = displayValue("personName", who.person.name);
  const params = {
    orgId,
    userId: who.person.id,
    orgName: orgNameForEmail(orgName),
    roleLabel: roleLabelForEmail(labelOf(offered)),
    ...(personName === undefined ? {} : { personName }),
  };
  const recipients = [
    inviter,
    ...(await addressesOfRoles(tx, orgId, [CATALOGUE.topRoleKey])),
  ].filter((r) => r.userId !== who.person.id);
  await notifyEach(
    orgs,
    tx,
    recipients.map((r) => ({ template: "orgs/member-joined" as const, to: r.email, params })),
  );
  return { orgId, memberId, roleKey: row.role_key };
}

/** `POST /api/invitations/:invitationId/decline` (§9.3): the same address rule. */
export async function declineInvitation(
  orgs: Orgs,
  tx: UnitTx,
  who: Guarded,
  invitationId: string,
): Promise<{ invitationId: string }> {
  const row = await lockForInvitee(orgs, tx, who, invitationId);
  await tx.query(
    `UPDATE identity.invitation SET status = 'declined', answered_at = $2, answered_by = $3
      WHERE id = $1`,
    [row.id, orgs.clock.now(), who.person.id],
  );
  await orgs.audit(tx, {
    event: "member.invitation_declined",
    actor: who.actor,
    target: row.id,
    refs: [who.person.id, row.organization_id],
    organizationId: row.organization_id,
    metadata: {},
    context: who.context,
  });
  return { invitationId: row.id };
}

async function countInvitationSent(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  email: string,
): Promise<void> {
  const address = orgs.limits.addressSubject(email);
  await orgs.limits.count(tx, "invite_org", actor.organization.id);
  await orgs.limits.count(tx, "invite_inviter", actor.person.id);
  await orgs.limits.count(tx, "invite_org_address", `${actor.organization.id}:${address}`);
  await orgs.limits.count(tx, "invite_address", address);
}

async function queueInvitation(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  invitation: { id: string; email: string; role: RoleLookup },
  token: string,
): Promise<void> {
  const personName = displayValue("personName", actor.person.name);
  await orgs.email(tx, {
    template: "orgs/invitation",
    to: invitation.email,
    params: {
      invitationId: invitation.id,
      orgId: actor.organization.id,
      token,
      orgName: orgNameForEmail(actor.organization.name),
      roleLabel: roleLabelForEmail(labelOf(invitation.role)),
      ...(personName === undefined ? {} : { personName }),
    },
  });
}

/**
 * `POST /api/team/invitations` (§9.3): `member.invite`, an intent, the giving rule and §5.6's
 * limits. An existing member is `409 already_member`; a pending invitation for the address is
 * replaced; at most 25 are pending.
 */
export async function inviteMember(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  body: { email: string; roleKey: string },
): Promise<{ invitationId: string; expiresAt: string }> {
  const orgId = actor.organization.id;
  const email = body.email.trim().toLowerCase();
  const { me } = await lockTeam(tx, actor, [], "member.invite");
  const role = lookupRole(me.roles, body.roleKey);
  checkGiving(me, { targetIsSelf: false, next: role });
  const existing = await tx.query(
    `SELECT 1 FROM identity.member m JOIN identity."user" u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND u.email = $2`,
    [orgId, email],
  );
  if (existing.rowCount > 0) throw new OrgRefusal("already_member", "invitation.already_member");
  const now = orgs.clock.now();
  const pending = await tx.query<{ n: number }>(
    `SELECT count(*)::integer AS n FROM identity.invitation
      WHERE organization_id = $1 AND status = 'pending' AND expires_at > $2 AND email <> $3`,
    [orgId, now, email],
  );
  if (Number(pending.rows[0]?.n ?? Number.NaN) >= PENDING_INVITATIONS) {
    throw new OrgRefusal("limit_reached", "limits.pending_invitations", {
      limit: PENDING_INVITATIONS,
    });
  }
  await actor.confirm({
    body: { email, roleKey: body.roleKey },
    target: null,
    organizationId: orgId,
  });
  await countInvitationSent(orgs, tx, actor, email);
  const replaced = await tx.query<{ id: string }>(
    `UPDATE identity.invitation SET status = 'cancelled', cancel_reason = 'replaced', answered_at = $3
      WHERE organization_id = $1 AND email = $2 AND status = 'pending' RETURNING id`,
    [orgId, email, now],
  );
  for (const old of replaced.rows) {
    await orgs.audit(tx, {
      event: "member.invitation_cancelled",
      actor: actor.actor,
      target: old.id,
      refs: [orgId],
      organizationId: orgId,
      metadata: { reason: "replaced" },
      context: actor.context,
    });
  }
  const id = newId("inv", orgs.clock);
  const token = newInvitationToken();
  const expiresAt = new Date(now.getTime() + INVITATION_LIFETIME_MS);
  await tx.query(
    `INSERT INTO identity.invitation (id, organization_id, email, role_key, token_hash, invited_by,
       created_at, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
    [id, orgId, email, body.roleKey, tokenHash(token), actor.person.id, now, expiresAt],
  );
  await orgs.audit(tx, {
    event: "member.invited",
    actor: actor.actor,
    target: id,
    refs: [orgId],
    organizationId: orgId,
    metadata: { roleKey: body.roleKey },
    context: actor.context,
  });
  await queueInvitation(orgs, tx, actor, { id, email, role }, token);
  return { invitationId: id, expiresAt: expiresAt.toISOString() };
}

async function lockInvitationOf(
  tx: UnitTx,
  actor: OrgActor,
  invitationId: string,
): Promise<InvitationRow> {
  if (!isId(invitationId, "inv")) throw notFound("invitation.id");
  const row = await invitationById(tx, invitationId, {
    orgId: actor.organization.id,
    lock: true,
  });
  // Another organisation's invitation, or one no longer pending, is not found here.
  if (row === null || row.status !== "pending") throw notFound("invitation.not_pending");
  return row;
}

/**
 * `PATCH /api/team/invitations/:invitationId` (§9.3, [SA-34]): the outrank rule on both roles, an
 * intent, a new token (the old link stops working), `member.invitation_changed`, and the invitation
 * queued again.
 */
export async function changeInvitation(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  invitationId: string,
  body: { roleKey: string },
): Promise<{ invitationId: string; expiresAt: string }> {
  const { me } = await lockTeam(tx, actor, [], "member.invite");
  const row = await lockInvitationOf(tx, actor, invitationId);
  const current = lookupRole(me.roles, row.role_key);
  const next = lookupRole(me.roles, body.roleKey);
  checkGiving(me, { targetIsSelf: false, current, next });
  await actor.confirm({
    body: { roleKey: body.roleKey },
    target: row.id,
    organizationId: actor.organization.id,
  });
  await countInvitationSent(orgs, tx, actor, row.email);
  const now = orgs.clock.now();
  const token = newInvitationToken();
  const expiresAt = new Date(now.getTime() + INVITATION_LIFETIME_MS);
  await tx.query(
    `UPDATE identity.invitation SET role_key = $2, token_hash = $3, expires_at = $4 WHERE id = $1`,
    [row.id, body.roleKey, tokenHash(token), expiresAt],
  );
  await orgs.audit(tx, {
    event: "member.invitation_changed",
    actor: actor.actor,
    target: row.id,
    refs: [actor.organization.id],
    organizationId: actor.organization.id,
    metadata: {
      fromRole: row.role_key,
      toRole: body.roleKey,
      reason: "edited",
    },
    context: actor.context,
  });
  await queueInvitation(orgs, tx, actor, { id: row.id, email: row.email, role: next }, token);
  return { invitationId: row.id, expiresAt: expiresAt.toISOString() };
}

/** `POST /api/team/invitations/:invitationId/resend` (§9.3): a new token, counted in the limits. */
export async function resendInvitation(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  invitationId: string,
): Promise<{ invitationId: string; expiresAt: string }> {
  const { me } = await lockTeam(tx, actor, [], "member.invite");
  const row = await lockInvitationOf(tx, actor, invitationId);
  const role = lookupRole(me.roles, row.role_key);
  checkActing(me, { targetIsSelf: false, role });
  await actor.confirm({ body: {}, target: row.id, organizationId: actor.organization.id });
  await countInvitationSent(orgs, tx, actor, row.email);
  const now = orgs.clock.now();
  const token = newInvitationToken();
  const expiresAt = new Date(now.getTime() + INVITATION_LIFETIME_MS);
  await tx.query("UPDATE identity.invitation SET token_hash = $2, expires_at = $3 WHERE id = $1", [
    row.id,
    tokenHash(token),
    expiresAt,
  ]);
  await orgs.audit(tx, {
    event: "member.invitation_resent",
    actor: actor.actor,
    target: row.id,
    refs: [actor.organization.id],
    organizationId: actor.organization.id,
    metadata: {},
    context: actor.context,
  });
  await queueInvitation(orgs, tx, actor, { id: row.id, email: row.email, role }, token);
  return { invitationId: row.id, expiresAt: expiresAt.toISOString() };
}

/** `DELETE /api/team/invitations/:invitationId` (§9.3): the outrank rule, an intent; no email. */
export async function cancelInvitation(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  invitationId: string,
): Promise<{ invitationId: string }> {
  const { me } = await lockTeam(tx, actor, [], "member.invite");
  const row = await lockInvitationOf(tx, actor, invitationId);
  checkActing(me, { targetIsSelf: false, role: lookupRole(me.roles, row.role_key) });
  await actor.confirm({ body: {}, target: row.id, organizationId: actor.organization.id });
  await tx.query(
    `UPDATE identity.invitation SET status = 'cancelled', cancel_reason = 'cancelled', answered_at = $2
      WHERE id = $1`,
    [row.id, orgs.clock.now()],
  );
  await orgs.audit(tx, {
    event: "member.invitation_cancelled",
    actor: actor.actor,
    target: row.id,
    refs: [actor.organization.id],
    organizationId: actor.organization.id,
    metadata: { reason: "cancelled" },
    context: actor.context,
  });
  return { invitationId: row.id };
}
