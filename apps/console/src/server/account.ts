// Account security (spec 02 §14.2, §11.4, §6.6): the person's factors, sessions and trusted browsers,
// their name, and the session and browser revocations. The revocation cores are packages/identity's
// (`revokeSession`, `revokeOtherSessions`); each runs after the route's intent is consumed, in its
// unit of work, with its events and notice.
import {
  checkName,
  deviceSummary,
  finCookieName,
  readCookie,
  revokeOtherSessions,
  revokeSession,
  type UnitTx,
} from "@fin/identity";
import { type Guarded, membershipsOfPerson, notFound, OrgRefusal, type Orgs } from "@fin/orgs";

export interface Paged<T> {
  items: T[];
  total: number;
  totalCapped: boolean;
}

function paged<T>(rows: T[], total: number): Paged<T> {
  return { items: rows, total: Math.min(total, 10_000), totalCapped: total > 10_000 };
}

async function passkeys(tx: UnitTx, userId: string, page: { page: number; size: number }) {
  const result = await tx.query<{
    id: string;
    name: string | null;
    device_type: string;
    backed_up: boolean;
    created_at: Date | null;
    total: string;
  }>(
    `SELECT id, name, device_type, backed_up, created_at, count(*) OVER () AS total
       FROM identity.passkey WHERE user_id = $1 ORDER BY created_at DESC NULLS LAST, id
      LIMIT $2 OFFSET $3`,
    [userId, page.size, (page.page - 1) * page.size],
  );
  return paged(
    result.rows.map((r) => ({
      id: r.id,
      name: r.name ?? "Passkey",
      deviceType: r.device_type,
      backedUp: r.backed_up,
      createdAt: r.created_at?.toISOString() ?? null,
    })),
    Number(result.rows[0]?.total ?? 0),
  );
}

/** `GET /api/account/security` (§14.2). Google is not built (stretch 5). */
export async function accountSecurity(tx: UnitTx, who: Guarded) {
  const browsers = await tx.query<{
    id: string;
    label: string;
    created_at: Date;
    last_used_at: Date | null;
    expires_at: Date;
  }>(
    `SELECT id, label, created_at, last_used_at, expires_at FROM identity.trusted_browser
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    [who.person.id],
  );
  const twoFactor = await tx.query<{ verified: boolean }>(
    "SELECT verified FROM identity.two_factor WHERE user_id = $1",
    [who.person.id],
  );
  // Whether the account has a password (stretch 2, §5.7): read, never the hash.
  const password = await tx.query<{ set: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM identity.account
                     WHERE user_id = $1 AND provider_id = 'credential' AND password IS NOT NULL) AS set`,
    [who.person.id],
  );
  return {
    name: who.person.name,
    email: who.person.email,
    passkeys: await passkeys(tx, who.person.id, { page: 1, size: 25 }),
    authenticator: twoFactor.rows[0]?.verified === true ? "on" : "off",
    passwordSet: password.rows[0]?.set === true,
    googleLinked: false,
    trustedBrowsers: browsers.rows.map((b) => ({
      id: b.id,
      label: b.label,
      createdAt: b.created_at.toISOString(),
      lastUsedAt: b.last_used_at?.toISOString() ?? null,
      expiresAt: b.expires_at.toISOString(),
    })),
    // Shown on Account security while the account has no second factor.
    warning: who.person.factors.count === 0,
  };
}

export function accountPasskeys(tx: UnitTx, who: Guarded, page: { page: number; size: number }) {
  return passkeys(tx, who.person.id, page);
}

/** `GET /api/account/sessions` (§14.2): the person's live sessions, this one marked. */
export async function accountSessions(
  tx: UnitTx,
  who: Guarded,
  page: { page: number; size: number },
) {
  const result = await tx.query<{
    id: string;
    created_at: Date;
    updated_at: Date;
    expires_at: Date;
    assurance: string;
    ip_address: string | null;
    user_agent: string | null;
    total: string;
  }>(
    `SELECT id, created_at, updated_at, expires_at, assurance, ip_address, user_agent,
            count(*) OVER () AS total
       FROM identity.session
      WHERE user_id = $1 AND expires_at > now() AND absolute_expires_at > now()
      ORDER BY updated_at DESC, id LIMIT $2 OFFSET $3`,
    [who.person.id, page.size, (page.page - 1) * page.size],
  );
  return paged(
    result.rows.map((r) => ({
      id: r.id,
      current: r.id === who.person.sessionId,
      device: deviceSummary(r.user_agent),
      address: r.ip_address,
      assurance: r.assurance,
      createdAt: r.created_at.toISOString(),
      lastActiveAt: r.updated_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
    })),
    Number(result.rows[0]?.total ?? 0),
  );
}

/**
 * `PATCH /api/account/name` (§14.2): a window step-up; `user.name_changed` (no name stored, S2-17)
 * and `member.name_changed` per membership.
 */
export async function changeName(
  orgs: Orgs,
  tx: UnitTx,
  who: Guarded,
  body: { name: string },
): Promise<{ name: string }> {
  const checked = checkName("personName", body.name);
  if (!checked.ok) {
    throw new OrgRefusal("invalid", "account.name", {
      fields: [{ path: "name", code: checked.reason }],
    });
  }
  await who.confirm({ body: {}, target: who.person.id, organizationId: null });
  await tx.query('UPDATE identity."user" SET name = $2, updated_at = $3 WHERE id = $1', [
    who.person.id,
    checked.value,
    orgs.clock.now(),
  ]);
  await orgs.realm.runtime.audit(tx, {
    event: "user.name_changed",
    actor: who.actor,
    target: who.person.id,
    subjectUserId: who.person.id,
    metadata: {},
    context: who.context,
  });
  for (const membership of await membershipsOfPerson(tx, who.person.id)) {
    await orgs.audit(tx, {
      event: "member.name_changed",
      actor: who.actor,
      target: membership.memberId,
      refs: [who.person.id],
      organizationId: membership.orgId,
      metadata: {},
      context: who.context,
    });
  }
  return { name: checked.value };
}

function sessionActor(who: Guarded, request: Request) {
  return {
    personId: who.person.id,
    email: who.person.email,
    currentSessionId: who.person.sessionId,
    actor: who.actor,
    context: who.context,
    knownBrowserToken: readCookie(
      request.headers.get("cookie"),
      finCookieName("developer", "known_browser"),
    ),
    // This browser's trust, which "everywhere else" keeps (§11.4).
    trustedBrowserToken: readCookie(
      request.headers.get("cookie"),
      finCookieName("developer", "trusted_browser"),
    ),
  };
}

/** `POST /api/account/sessions/:sessionId/revoke` (§11.4): one other session of the person. */
export async function revokeOneSession(
  orgs: Orgs,
  tx: UnitTx,
  who: Guarded,
  request: Request,
  sessionId: string,
): Promise<{ sessionId: string }> {
  const own = await tx.query(
    "SELECT 1 FROM identity.session WHERE id = $1 AND user_id = $2 AND id <> $3",
    [sessionId, who.person.id, who.person.sessionId],
  );
  // Another person's session, this one and an unknown one are the same answer.
  if (own.rowCount === 0) throw notFound("account.session");
  await who.confirm({ body: {}, target: sessionId, organizationId: null });
  const done = await revokeSession(orgs.realm.runtime, tx, sessionActor(who, request), sessionId);
  if (!done) throw notFound("account.session");
  return { sessionId };
}

/** `POST /api/account/sessions/revoke-others` (§11.4): every other session of the person. */
export async function revokeOthers(
  orgs: Orgs,
  tx: UnitTx,
  who: Guarded,
  request: Request,
): Promise<{ revoked: number }> {
  await who.confirm({ body: {}, target: who.person.id, organizationId: null });
  const revoked = await revokeOtherSessions(orgs.realm.runtime, tx, sessionActor(who, request));
  return { revoked };
}

/** `DELETE /api/account/trusted-browsers/:browserId` (§6.6): one of the person's rows. */
export async function revokeTrustedBrowser(
  orgs: Orgs,
  tx: UnitTx,
  who: Guarded,
  browserId: string,
): Promise<{ browserId: string }> {
  const own = await tx.query(
    `SELECT 1 FROM identity.trusted_browser
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL FOR UPDATE`,
    [browserId, who.person.id],
  );
  if (own.rowCount === 0) throw notFound("account.trusted_browser");
  await who.confirm({ body: {}, target: browserId, organizationId: null });
  await tx.query(
    `UPDATE identity.trusted_browser SET revoked_at = now(), revoked_reason = 'by_person'
      WHERE id = $1`,
    [browserId],
  );
  await orgs.realm.runtime.audit(tx, {
    event: "browser.trust_revoked",
    actor: who.actor,
    target: browserId,
    refs: [who.person.id],
    subjectUserId: who.person.id,
    metadata: { reason: "by_person" },
    context: who.context,
  });
  return { browserId };
}
