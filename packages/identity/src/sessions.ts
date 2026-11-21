// Ending sessions from Account security (spec 02 §11.4): one other session, or every session but
// this one. Both are Fin's own routes behind an intent (§7.6: `account.session_revoke`,
// `account.sessions_revoke_others`); these are their cores, run in the route's unit of work after
// requirePerson has checked and consumed the intent.
import type { AuditActor } from "./audit/record.ts";
import { forgetKnownBrowsersExcept, revokeTrustedBrowsers, thisBrowsersTrust } from "./browsers.ts";
import type { UnitTx } from "./ports/db.ts";
import type { RealmRuntime } from "./runtime.ts";
import { TABLES } from "./store.ts";

export interface SessionActor {
  personId: string;
  email: string;
  currentSessionId: string;
  actor: AuditActor;
  context: { clientIp: string | null; userAgent: string | null };
  /** The current browser's known-browser token, which "everywhere else" keeps. */
  knownBrowserToken: string | null;
  /**
   * The current browser's trusted-browser token (`__Host-fin.trusted_browser`), whose row
   * "everywhere else" keeps, as it keeps the row the current session was made from (§11.4).
   */
  trustedBrowserToken: string | null;
}

/** Signs out one other session of the person; returns false when it is not theirs or is this one. */
export async function revokeSession(
  rt: RealmRuntime,
  tx: UnitTx,
  who: SessionActor,
  sessionId: string,
): Promise<boolean> {
  const realm = rt.settings.realm;
  if (sessionId === who.currentSessionId) return false;
  const deleted = await tx.query(
    `DELETE FROM ${TABLES[realm].session} WHERE id = $1 AND user_id = $2 RETURNING id`,
    [sessionId, who.personId],
  );
  if (deleted.rowCount === 0) return false;
  await rt.audit(tx, {
    event: realm === "developer" ? "session.revoked" : "staff.session_revoked",
    actor: who.actor,
    target: sessionId,
    refs: [who.personId],
    ...(realm === "developer" ? { subjectUserId: who.personId } : {}),
    metadata: {},
    context: who.context,
  });
  return true;
}

/**
 * "Sign out everywhere else": every other session ends, and every known and trusted browser but
 * this one is forgotten or revoked, with the events and the notice (§11.4, §5.5, §6.6). This
 * session and this browser's trust stay, so the person goes on working where they pressed it.
 */
export async function revokeOtherSessions(
  rt: RealmRuntime,
  tx: UnitTx,
  who: SessionActor,
): Promise<number> {
  const realm = rt.settings.realm;
  const now = rt.clock.now();
  const deleted = await tx.query(
    `DELETE FROM ${TABLES[realm].session} WHERE user_id = $1 AND id <> $2`,
    [who.personId, who.currentSessionId],
  );
  const count = deleted.rowCount;
  if (realm === "developer") {
    await forgetKnownBrowsersExcept(tx, rt.hasher, who.personId, who.knownBrowserToken);
    const keep = await thisBrowsersTrust(
      tx,
      rt.hasher,
      who.personId,
      who.currentSessionId,
      who.trustedBrowserToken,
      now,
    );
    const revoked = await revokeTrustedBrowsers(tx, who.personId, "signed_out_everywhere", now, {
      except: keep,
    });
    for (const id of revoked) {
      await rt.audit(tx, {
        event: "browser.trust_revoked",
        actor: who.actor,
        target: id,
        refs: [who.personId],
        subjectUserId: who.personId,
        metadata: { reason: "signed_out_everywhere" },
        context: who.context,
      });
    }
  }
  await rt.audit(tx, {
    event: realm === "developer" ? "session.revoked_others" : "staff.signed_out_everywhere",
    actor: who.actor,
    target: who.personId,
    refs: [who.currentSessionId],
    ...(realm === "developer" ? { subjectUserId: who.personId } : {}),
    metadata: { count },
    context: who.context,
  });
  await rt.email(tx, {
    template:
      realm === "developer"
        ? "identity/sign-in-methods-changed"
        : "staff/staff-sign-in-methods-changed",
    to: who.email,
    params:
      realm === "developer"
        ? { userId: who.personId, kind: "signed_out_everywhere", time: now.toISOString() }
        : { staffId: who.personId, kind: "signed_out_everywhere", time: now.toISOString() },
  });
  return count;
}
