// A staff member's own sign-in (spec 02 §14.3's account routes; AdminAccount's data): their factors
// and sessions, and signing out one other session or every other one, each with an intent
// (`staff.session_revoke`, `staff.sessions_revoke_others`, @fin/identity's actions). The cores are
// @fin/identity's revokeSession and revokeOtherSessions, which write the staff events and notices.
import { deviceSummary, revokeOtherSessions, revokeSession } from "@fin/identity";
import type { StaffDeps } from "./deps.ts";
import { StaffRefusal } from "./errors.ts";
import { isIdOf } from "./ids.ts";
import type { UnitTx } from "./ports.ts";
import type { StaffActor } from "./require-staff.ts";

export interface StaffAccount {
  staffId: string;
  email: string;
  factors: {
    passkeys: { id: string; name: string | null; createdAt: string | null }[];
    authenticator: boolean;
  };
  sessions: {
    id: string;
    current: boolean;
    device: string;
    assurance: "aal1" | "aal2";
    createdAt: string;
    expiresAt: string;
  }[];
}

/** `GET /api/account`. */
export async function staffAccount(tx: UnitTx, who: StaffActor): Promise<StaffAccount> {
  const passkeys = await tx.query<{ id: string; name: string | null; created_at: Date | null }>(
    "SELECT id, name, created_at FROM staff.passkey WHERE user_id = $1 ORDER BY created_at, id",
    [who.staffId],
  );
  const sessions = await tx.query<{
    id: string;
    user_agent: string | null;
    assurance: "aal1" | "aal2";
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT id, user_agent, assurance, created_at, LEAST(expires_at, absolute_expires_at) AS expires_at
       FROM staff.session
      WHERE user_id = $1 AND expires_at > now() AND absolute_expires_at > now()
      ORDER BY created_at DESC, id`,
    [who.staffId],
  );
  return {
    staffId: who.staffId,
    email: who.email,
    factors: {
      passkeys: passkeys.rows.map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.created_at?.toISOString() ?? null,
      })),
      authenticator: who.factors.authenticator,
    },
    sessions: sessions.rows.map((s) => ({
      id: s.id,
      current: s.id === who.sessionId,
      device: deviceSummary(s.user_agent),
      assurance: s.assurance,
      createdAt: s.created_at.toISOString(),
      expiresAt: s.expires_at.toISOString(),
    })),
  };
}

function sessionActor(who: StaffActor, stepUp: NonNullable<StaffActor["actor"]["stepUp"]>) {
  return {
    personId: who.staffId,
    email: who.email,
    currentSessionId: who.sessionId,
    actor: { kind: "staff" as const, id: who.staffId, via: "admin" as const, stepUp },
    context: { clientIp: who.request.clientIp, userAgent: who.request.userAgent },
    knownBrowserToken: null,
  };
}

/** `POST /api/account/sessions/:sessionId/revoke`: one other session of the member's. */
export async function revokeStaffSession(
  deps: StaffDeps,
  tx: UnitTx,
  who: StaffActor,
  sessionId: string,
): Promise<{ revoked: true }> {
  if (!isIdOf(sessionId, "sts") || sessionId === who.sessionId) {
    throw new StaffRefusal("not_found", "session.not_found");
  }
  const owned = await tx.query("SELECT 1 FROM staff.session WHERE id = $1 AND user_id = $2", [
    sessionId,
    who.staffId,
  ]);
  if (owned.rowCount === 0) throw new StaffRefusal("not_found", "session.not_found");
  const stepUp = await who.stepUp(tx, {
    action: "staff.session_revoke",
    target: sessionId,
    body: {},
  });
  const done = await revokeSession(deps.realm.runtime, tx, sessionActor(who, stepUp), sessionId);
  if (!done) throw new StaffRefusal("not_found", "session.not_found");
  return { revoked: true };
}

/** `POST /api/account/sessions/revoke-others`: every session of the member's but this one. */
export async function revokeOtherStaffSessions(
  deps: StaffDeps,
  tx: UnitTx,
  who: StaffActor,
): Promise<{ revoked: number }> {
  const stepUp = await who.stepUp(tx, {
    action: "staff.sessions_revoke_others",
    target: who.staffId,
    body: {},
  });
  const revoked = await revokeOtherSessions(deps.realm.runtime, tx, sessionActor(who, stepUp));
  return { revoked };
}
