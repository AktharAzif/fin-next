// Members (spec 02 §9.2, §9.4; [SA-32], [SA-33]): the team list, a role change and a removal. Both
// changes run inside the team-change lock with every role read again, the outrank, giving and
// last-holder rules, then the intent; in the same transaction they write their events, roll the
// credentials the member made or saw, withdraw the invitations the member may no longer give, revoke
// trusted browsers where the rules say, and queue the notices.
import { isTopRole, outranks } from "@fin/access";
import type { UnitTx } from "@fin/identity";
import { revokeTrustedBrowsers } from "./browsers.ts";
import type { ListedCredential, RollOutcome } from "./credentials.ts";
import { displayValue, orgNameForEmail, roleLabelForEmail } from "./email.ts";
import { notFound } from "./errors.ts";
import type { OrgActor } from "./guard.ts";
import { withdrawInvitations } from "./invitations.ts";
import { notifyEach, type Orgs } from "./orgs.ts";
import { checkActing, checkGiving, checkLastTopRole, type LockedActor, lockTeam } from "./rules.ts";
import {
  addressesOfRoles,
  CATALOGUE,
  labelOf,
  lookupRole,
  type MemberRow,
  memberById,
  permissionsFor,
} from "./store.ts";

export interface TeamMember {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  roleKey: string;
  roleLabel: string;
  /** False for a "No access" row: a role key Fin does not know, or a custom role that is gone. */
  roleKnown: boolean;
  secondFactor: boolean;
  joinedAt: string;
}

export interface TeamInvitation {
  invitationId: string;
  email: string;
  roleKey: string;
  roleLabel: string;
  roleKnown: boolean;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "expired";
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** `GET /api/team` (§9.2): members, "No access" rows and pending invitations, searched and paged. */
export async function teamList(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  query: { q?: string | undefined; page: number; size: number },
): Promise<{
  members: TeamMember[];
  invitations: TeamInvitation[];
  total: number;
  totalCapped: boolean;
}> {
  const orgId = actor.organization.id;
  const pattern = query.q === undefined || query.q === "" ? null : likePattern(query.q);
  const offset = (query.page - 1) * query.size;
  const members = await tx.query<{
    id: string;
    user_id: string;
    name: string;
    email: string;
    role_key: string;
    created_at: Date;
    factors: number;
    total: number;
  }>(
    `SELECT m.id, m.user_id, u.name, u.email, m.role_key, m.created_at,
            (SELECT count(*) FROM identity.passkey p WHERE p.user_id = m.user_id)
              + (SELECT count(*) FROM identity.two_factor t WHERE t.user_id = m.user_id AND t.verified)
              AS factors,
            count(*) OVER () AS total
       FROM identity.member m JOIN identity."user" u ON u.id = m.user_id
      WHERE m.organization_id = $1
        AND ($2::text IS NULL OR u.name ILIKE $2 OR u.email ILIKE $2)
      ORDER BY m.created_at, m.id
      LIMIT $3 OFFSET $4`,
    [orgId, pattern, query.size, offset],
  );
  const invitations = await tx.query<{
    id: string;
    email: string;
    role_key: string;
    invited_by: string;
    created_at: Date;
    expires_at: Date;
    expired: boolean;
  }>(
    `SELECT i.id, i.email, i.role_key, i.invited_by, i.created_at, i.expires_at,
            i.expires_at <= $3 AS expired
       FROM identity.invitation i
      WHERE i.organization_id = $1 AND i.status = 'pending'
        AND ($2::text IS NULL OR i.email ILIKE $2)
      ORDER BY i.created_at, i.id`,
    [orgId, pattern, orgs.clock.now()],
  );
  const total = Number(members.rows[0]?.total ?? 0);
  return {
    members: members.rows.map((m) => {
      const role = lookupRole(actor.roles, m.role_key);
      return {
        memberId: m.id,
        userId: m.user_id,
        name: m.name,
        email: m.email,
        roleKey: m.role_key,
        roleLabel: labelOf(role),
        roleKnown: typeof role !== "string",
        secondFactor: Number(m.factors) > 0,
        joinedAt: m.created_at.toISOString(),
      };
    }),
    invitations: invitations.rows.map((i) => {
      const role = lookupRole(actor.roles, i.role_key);
      return {
        invitationId: i.id,
        email: i.email,
        roleKey: i.role_key,
        roleLabel: labelOf(role),
        roleKnown: typeof role !== "string",
        invitedBy: i.invited_by,
        createdAt: i.created_at.toISOString(),
        expiresAt: i.expires_at.toISOString(),
        // Expiry is read, never written: a pending row past its time is shown as expired.
        status: i.expired ? "expired" : "pending",
      };
    }),
    total: Math.min(total, 10_000),
    totalCapped: total > 10_000,
  };
}

/** `GET /api/team/members/:memberId/credentials` (§9.4): what the member made or was shown. */
export async function memberCredentials(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  memberId: string,
): Promise<{
  credentials: (Pick<ListedCredential, "id" | "kind" | "label" | "made" | "seen"> & {
    rolledAtOnce: boolean;
  })[];
}> {
  const target = await memberById(tx, actor.organization.id, memberId);
  if (target === null) throw notFound("team.member_not_found");
  const listed = await orgs.credentials.list(tx, actor.organization.id, target.userId);
  return {
    credentials: listed.map((c) => ({
      id: c.id,
      kind: c.kind,
      label: c.label,
      made: c.made,
      seen: c.seen,
      // Rolled at once only when the actor holds the permission that rolls it (S2-42).
      rolledAtOnce: actor.permissions.has(c.rollPermission),
    })),
  };
}

async function rollFor(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  me: LockedActor,
  target: MemberRow,
  roll: boolean,
): Promise<RollOutcome> {
  return roll
    ? orgs.credentials.rollAll(
        tx,
        actor.organization.id,
        target.userId,
        me.permissions,
        actor.actor,
      )
    : orgs.credentials.countOnly(tx, actor.organization.id, target.userId);
}

/**
 * `PATCH /api/team/members/:memberId` (§9.2): `member.role`, an intent, §8.5's rules inside the
 * lock; `member.role_changed`; `member-role-changed` to the person and every Super admin.
 */
export async function changeMemberRole(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  memberId: string,
  body: { roleKey: string; rollCredentials: boolean },
): Promise<{ memberId: string; roleKey: string }> {
  const orgId = actor.organization.id;
  const { me, targets } = await lockTeam(tx, actor, [memberId], "member.role");
  const target = targets.get(memberId);
  if (target === undefined) throw notFound("team.member_not_found");
  const current = lookupRole(me.roles, target.roleKey);
  const next = lookupRole(me.roles, body.roleKey);
  checkGiving(me, { targetIsSelf: target.userId === actor.person.id, current, next });
  await checkLastTopRole(tx, orgId, target, current, { newRole: next });
  await actor.confirm({
    body: { roleKey: body.roleKey, rollCredentials: body.rollCredentials },
    target: memberId,
    organizationId: orgId,
  });
  const before = permissionsFor(current);
  const after = permissionsFor(next);
  const lowered = outranks(CATALOGUE, before, after);
  const raised =
    outranks(CATALOGUE, after, before) ||
    (isTopRole(CATALOGUE, next) && !isTopRole(CATALOGUE, current));
  // Giving more access is limited; taking it away never is (§5.6).
  if (raised) await orgs.limits.count(tx, "role_raise", actor.person.id);
  const now = orgs.clock.now();
  await tx.query("UPDATE identity.member SET role_key = $2, updated_at = $3 WHERE id = $1", [
    memberId,
    body.roleKey,
    now,
  ]);
  await orgs.audit(tx, {
    event: "member.role_changed",
    actor: actor.actor,
    target: memberId,
    refs: [target.userId, orgId],
    organizationId: orgId,
    metadata: { fromRole: target.roleKey, toRole: body.roleKey, reason: "changed", lowered },
    context: actor.context,
  });
  if (lowered) {
    // A demotion that takes away permissions behind credentials they made or saw (§9.4).
    await rollFor(orgs, tx, actor, me, target, body.rollCredentials);
    // The invitations they sent that the new role no longer lets them give (read after the change).
    await withdrawInvitations(orgs, tx, actor, {
      reason: "inviter_demoted",
      inviters: [target.userId],
      refs: [target.id],
    });
  }
  if (raised) {
    await revokeTrustedBrowsers(
      orgs,
      tx,
      [target.userId],
      "role_elevated",
      actor.actor,
      actor.context,
    );
  }
  const orgName = orgNameForEmail(actor.organization.name);
  const personName = displayValue("personName", target.name);
  const params = {
    orgId,
    userId: target.userId,
    orgName,
    roleLabel: roleLabelForEmail(labelOf(next)),
    previousRoleLabel: roleLabelForEmail(labelOf(current)),
  };
  await notifyEach(orgs, tx, [
    {
      template: "orgs/member-role-changed",
      to: target.email,
      params: { ...params, audience: "person" },
    },
    ...(await addressesOfRoles(tx, orgId, [CATALOGUE.topRoleKey])).map((a) => ({
      template: "orgs/member-role-changed" as const,
      to: a.email,
      params: {
        ...params,
        audience: "admins",
        ...(personName === undefined ? {} : { personName }),
      },
    })),
  ]);
  return { memberId, roleKey: body.roleKey };
}

/**
 * `POST /api/team/members/:memberId/remove` (§9.2): `member.invite`, an intent, §8.5's rules inside
 * the lock. In one transaction: the membership deleted, `member.removed` with its journal entry,
 * their invitations withdrawn, §9.4's credentials handled, their trusted browsers revoked, and
 * `member-removed` to the person and to the remaining Super admins and Admins. Their sessions stay
 * (they may belong elsewhere); this organisation is closed to them from their next request.
 */
export async function removeMember(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  memberId: string,
  body: { rollCredentials: boolean },
): Promise<{ memberId: string; credentials: RollOutcome }> {
  const orgId = actor.organization.id;
  const { me, targets } = await lockTeam(tx, actor, [memberId], "member.invite");
  const target = targets.get(memberId);
  if (target === undefined) throw notFound("team.member_not_found");
  const role = lookupRole(me.roles, target.roleKey);
  checkActing(me, { targetIsSelf: target.userId === actor.person.id, role });
  await checkLastTopRole(tx, orgId, target, role, "remove");
  await actor.confirm({
    body: { rollCredentials: body.rollCredentials },
    target: memberId,
    organizationId: orgId,
  });
  const credentials = await rollFor(orgs, tx, actor, me, target, body.rollCredentials);
  await withdrawInvitations(orgs, tx, actor, {
    reason: "inviter_removed",
    inviters: [target.userId],
    all: true,
    refs: [target.id],
  });
  await tx.query("DELETE FROM identity.member WHERE id = $1", [memberId]);
  await revokeTrustedBrowsers(orgs, tx, [target.userId], "removed", actor.actor, actor.context);
  await orgs.audit(tx, {
    event: "member.removed",
    actor: actor.actor,
    target: memberId,
    // The organisation, for the membership's DELETE guard (keyed by organisation, guards.ts).
    refs: [target.userId, orgId],
    organizationId: orgId,
    metadata: {
      credentialsListed: credentials.listed,
      credentialsRolled: credentials.rolledNow + credentials.rollingWithinHour,
    },
    context: actor.context,
  });
  const orgName = orgNameForEmail(actor.organization.name);
  const personName = displayValue("personName", target.name);
  const admins = await addressesOfRoles(tx, orgId, [CATALOGUE.topRoleKey, "admin"]);
  await notifyEach(orgs, tx, [
    {
      template: "orgs/member-removed",
      to: target.email,
      params: { orgId, userId: target.userId, audience: "person", orgName },
    },
    ...admins.map((a) => ({
      template: "orgs/member-removed" as const,
      to: a.email,
      params: {
        orgId,
        userId: target.userId,
        audience: "admins",
        orgName,
        ...(personName === undefined ? {} : { personName }),
        rolledNow: credentials.rolledNow,
        rollingWithinHour: credentials.rollingWithinHour,
      },
    })),
  ]);
  return { memberId, credentials };
}
