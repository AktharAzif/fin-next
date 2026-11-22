// Staff management (spec 02 §10.2, §8.5, §10.8, [SA-12] to [SA-15], [SA-29], [SA-32]): add, change a
// role, remove, reset second factors, issue a new enrolment code. Each runs in the route's unit of
// work, in this order (S2-31): the staff-change lock, which its guard took before it read the
// actor's session (requireStaff's `changeLock`; lock.ts gives the whole order); the actor and the
// target read again; the outrank, giving and last-Admin rules; only then the intent, spent in the
// same transaction as the change, its audit event, its revocation-journal entry and its notices.
// A refusal writes nothing.
import { actingProblem, givingProblem, lastTopRoleProblem } from "@fin/access";
import { AuthRefusal, redeemEnrolmentCode, voidSignInCodes } from "@fin/identity";
import {
  lowers,
  resolveStaffRole,
  STAFF_CATALOGUE,
  type StaffRoleLookup,
  staffRoleLabel,
} from "./catalogue.ts";
import type { StaffDeps } from "./deps.ts";
import { activeAdminAddresses } from "./email.ts";
import { type IssuedCode, issueEnrolmentCode } from "./enrolment-codes.ts";
import { StaffRefusal } from "./errors.ts";
import { newId } from "./ids.ts";
import {
  type ActorNow,
  actorInsideLock,
  type MemberRow,
  memberForChange,
  otherActiveAdmins,
  requireChangeLock,
} from "./lock.ts";
import type { UnitTx } from "./ports.ts";
import type { StaffActor } from "./require-staff.ts";

/** An address as the staff table stores it. */
export function normaliseAddress(email: string): string {
  return email.normalize("NFC").trim().toLowerCase();
}

function givingRefusal(problem: string): StaffRefusal {
  if (problem === "outranked") return new StaffRefusal("outranked", "staff.outranked");
  return new StaffRefusal("giving_refused", `staff.giving.${problem}`, { problem });
}

/**
 * The change's target, locked for it; the actor themselves as read inside the lock, unlocked (the
 * rules then refuse a change aimed at oneself, and lock.ts says why the actor's row is never
 * locked).
 */
async function targetForChange(
  tx: UnitTx,
  actor: ActorNow,
  staffId: string,
  now: Date,
): Promise<MemberRow> {
  if (staffId === actor.row.id) return actor.row;
  const target = await memberForChange(tx, staffId, now);
  if (target === null || target.status === "removed") {
    throw new StaffRefusal("not_found", "staff.not_found");
  }
  return target;
}

async function noticeEveryone(
  deps: StaffDeps,
  tx: UnitTx,
  person: { email: string } | null,
  notice: (audience: "person" | "admins") => {
    template: "staff/staff-access-changed" | "staff/staff-factors-reset";
    params: Record<string, unknown>;
  },
): Promise<void> {
  if (person !== null) {
    const own = notice("person");
    await deps.notify(tx, { template: own.template, to: person.email, params: own.params });
  }
  for (const admin of await activeAdminAddresses(tx)) {
    if (person !== null && admin.email === person.email) continue;
    const theirs = notice("admins");
    await deps.notify(tx, { template: theirs.template, to: admin.email, params: theirs.params });
  }
}

/**
 * Ends every way in the member had or had begun: their sessions, their passkeys and authenticator,
 * and the emailed sign-in codes already sent to them, so that no sign-in begun before the change
 * finishes after it (their ceremonies wait for the change on their ceremony lock, lock.ts).
 */
async function endSessionsAndFactors(
  tx: UnitTx,
  target: MemberRow,
): Promise<{ sessionsEnded: number; factorsRemoved: number }> {
  const staffId = target.id;
  await voidSignInCodes(tx, "staff", target.email);
  const sessions = await tx.query("DELETE FROM staff.session WHERE user_id = $1", [staffId]);
  const passkeys = await tx.query("DELETE FROM staff.passkey WHERE user_id = $1", [staffId]);
  const authenticators = await tx.query(
    "DELETE FROM staff.two_factor WHERE user_id = $1 AND verified",
    [staffId],
  );
  // An authenticator whose set-up never finished is not a factor, but it goes too.
  await tx.query("DELETE FROM staff.two_factor WHERE user_id = $1", [staffId]);
  return {
    sessionsEnded: sessions.rowCount,
    factorsRemoved: passkeys.rowCount + authenticators.rowCount,
  };
}

export interface AddedStaff {
  staffId: string;
  email: string;
  roleKey: string;
  roleLabel: string;
  status: "pending";
  reactivated: boolean;
  enrolmentCode: IssuedCode;
}

/** `POST /api/staff`: a new pending member with a role and one live enrolment code. */
export async function addStaff(
  deps: StaffDeps,
  tx: UnitTx,
  who: StaffActor,
  input: { email: string; roleKey: string },
): Promise<AddedStaff> {
  const email = normaliseAddress(input.email);
  requireChangeLock(who);
  const actor = await actorInsideLock(tx, who.staffId, "staff.add");
  const newRole = await resolveStaffRole(tx, input.roleKey);
  const giving = givingProblem(STAFF_CATALOGUE, {
    actorRoleKey: actor.row.roleKey,
    actorPerms: actor.permissions,
    targetIsSelf: email === actor.row.email,
    newRole,
  });
  if (giving !== null && giving !== "self") throw givingRefusal(giving);
  // One's own address is refused before the address's row is locked: that row is the actor's own,
  // which a change never locks (lock.ts).
  if (giving === "self") throw new StaffRefusal("already_staff", "staff.already_staff");
  const existing = await tx.query<{ id: string; status: MemberRow["status"] }>(
    "SELECT id, status FROM staff.member WHERE email = $1 FOR UPDATE",
    [email],
  );
  const row = existing.rows[0];
  if (row !== undefined && row.status !== "removed") {
    throw new StaffRefusal("already_staff", "staff.already_staff");
  }
  const stepUp = await who.stepUp(tx, {
    action: "staff.add",
    target: null,
    body: { email, roleKey: input.roleKey },
  });
  const now = deps.clock.now();
  const reactivated = row !== undefined;
  const staffId = row?.id ?? newId("stf", deps.clock);
  const actorWithStepUp = { ...who.actor, stepUp };
  await deps.audit(tx, {
    event: "staff.member_added",
    actor: actorWithStepUp,
    target: staffId,
    metadata: { roleKey: input.roleKey, reactivated },
    request: who.request,
  });
  if (reactivated) {
    await tx.query(
      `UPDATE staff.member
          SET status = 'pending', role_key = $2, removed_at = NULL, factor_enrolled_at = NULL,
              added_by = $3, updated_at = $4
        WHERE id = $1`,
      [staffId, input.roleKey, who.staffId, now],
    );
  } else {
    await tx.query(
      `INSERT INTO staff.member (id, email, role_key, status, added_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, $5)`,
      [staffId, email, input.roleKey, who.staffId, now],
    );
  }
  const code = await issueEnrolmentCode(tx, deps, {
    memberId: staffId,
    reason: "added",
    actor: actorWithStepUp,
    request: who.request,
  });
  const roleLabel = staffRoleLabel(newRole);
  await noticeEveryone(deps, tx, { email }, (audience) => ({
    template: "staff/staff-access-changed",
    params: { staffId, kind: "added", audience, roleLabel },
  }));
  deps.lines.write("staff.changed", "warn", { kind: "added", staffId, actorId: who.staffId });
  return {
    staffId,
    email,
    roleKey: input.roleKey,
    roleLabel,
    status: "pending",
    reactivated,
    enrolmentCode: code,
  };
}

/**
 * `PATCH /api/staff/:staffId`: another role; the member's sessions end at once (S2-20), and the
 * sign-in codes already emailed to them are void.
 */
export async function changeStaffRole(
  deps: StaffDeps,
  tx: UnitTx,
  who: StaffActor,
  staffId: string,
  input: { roleKey: string },
): Promise<{ staffId: string; roleKey: string; roleLabel: string; sessionsEnded: number }> {
  requireChangeLock(who);
  const actor = await actorInsideLock(tx, who.staffId, "staff.role");
  const target = await targetForChange(tx, actor, staffId, deps.clock.now());
  const current = await resolveStaffRole(tx, target.roleKey);
  const next = await resolveStaffRole(tx, input.roleKey);
  const giving = givingProblem(STAFF_CATALOGUE, {
    actorRoleKey: actor.row.roleKey,
    actorPerms: actor.permissions,
    targetIsSelf: target.id === actor.row.id,
    targetCurrentRole: current,
    newRole: next,
  });
  if (giving !== null) throw givingRefusal(giving);
  await refuseLastActiveAdmin(tx, target, current, { newRole: next });
  const stepUp = await who.stepUp(tx, {
    action: "staff.role",
    target: target.id,
    body: { roleKey: input.roleKey },
  });
  const now = deps.clock.now();
  const lowered = lowers(current, next);
  await deps.audit(tx, {
    event: "staff.role_changed",
    actor: { ...who.actor, stepUp },
    target: target.id,
    metadata: { fromRole: target.roleKey, toRole: input.roleKey, reason: "changed", lowered },
    request: who.request,
  });
  await tx.query("UPDATE staff.member SET role_key = $2, updated_at = $3 WHERE id = $1", [
    target.id,
    input.roleKey,
    now,
  ]);
  // The emailed sign-in codes already sent go with the sessions, so that no sign-in begun under
  // the old role finishes after the change (its ceremony waited for it on the member's lock).
  await voidSignInCodes(tx, "staff", target.email);
  const ended = await tx.query("DELETE FROM staff.session WHERE user_id = $1", [target.id]);
  const roleLabel = staffRoleLabel(next);
  await noticeEveryone(deps, tx, { email: target.email }, (audience) => ({
    template: "staff/staff-access-changed",
    params: { staffId: target.id, kind: "role_changed", audience, roleLabel },
  }));
  deps.lines.write("staff.changed", "warn", {
    kind: "role_changed",
    staffId: target.id,
    actorId: who.staffId,
  });
  return { staffId: target.id, roleKey: input.roleKey, roleLabel, sessionsEnded: ended.rowCount };
}

/** The last active Admin stays (§10.8): `409 last_top_role` when the change would leave none. */
export async function refuseLastActiveAdmin(
  tx: UnitTx,
  target: MemberRow,
  current: StaffRoleLookup,
  change: "remove" | "reset" | { newRole: StaffRoleLookup },
): Promise<void> {
  // Only an active Admin counts (a pending one is not yet anyone's way in), §10.8.
  if (target.status !== "active") return;
  const problem = lastTopRoleProblem(STAFF_CATALOGUE, {
    targetRole: current,
    change,
    otherTopHolders: await otherActiveAdmins(tx, target.id),
  });
  if (problem !== null) throw new StaffRefusal("last_top_role", "staff.last_top_role");
}

async function actingOn(
  deps: StaffDeps,
  tx: UnitTx,
  who: StaffActor,
  staffId: string,
  permission: "staff.remove" | "staff.reset_factors" | "staff.add",
  lastAdmin: "remove" | "reset" | null,
): Promise<{ target: MemberRow; current: StaffRoleLookup }> {
  requireChangeLock(who);
  const actor = await actorInsideLock(tx, who.staffId, permission);
  const target = await targetForChange(tx, actor, staffId, deps.clock.now());
  const current = await resolveStaffRole(tx, target.roleKey);
  const acting = actingProblem(STAFF_CATALOGUE, {
    actorPerms: actor.permissions,
    targetIsSelf: target.id === actor.row.id,
    targetRole: current,
  });
  if (acting !== null) throw givingRefusal(acting);
  if (lastAdmin !== null) await refuseLastActiveAdmin(tx, target, current, lastAdmin);
  return { target, current };
}

/**
 * `POST /api/staff/:staffId/remove`: in one transaction the member is `removed`, every session,
 * passkey, authenticator and live enrolment code of theirs goes, with `staff.member_removed`, its
 * revocation-journal entry and the notices. Their address leaves the Access list next (§10.1).
 */
export async function removeStaff(
  deps: StaffDeps,
  tx: UnitTx,
  who: StaffActor,
  staffId: string,
): Promise<{ staffId: string; status: "removed"; sessionsEnded: number; factorsRemoved: number }> {
  const { target } = await actingOn(deps, tx, who, staffId, "staff.remove", "remove");
  const stepUp = await who.stepUp(tx, { action: "staff.remove", target: target.id, body: {} });
  const now = deps.clock.now();
  const counts = await endSessionsAndFactors(tx, target);
  await tx.query(
    `UPDATE staff.enrolment_code SET voided_at = $2
      WHERE member_id = $1 AND redeemed_at IS NULL AND voided_at IS NULL`,
    [target.id, now],
  );
  await deps.audit(tx, {
    event: "staff.member_removed",
    actor: { ...who.actor, stepUp },
    target: target.id,
    metadata: counts,
    request: who.request,
  });
  await tx.query(
    `UPDATE staff.member
        SET status = 'removed', removed_at = $2, two_factor_enabled = false, updated_at = $2
      WHERE id = $1`,
    [target.id, now],
  );
  await noticeEveryone(deps, tx, { email: target.email }, (audience) => ({
    template: "staff/staff-access-changed",
    params: { staffId: target.id, kind: "removed", audience },
  }));
  deps.lines.write("staff.changed", "warn", {
    kind: "removed",
    staffId: target.id,
    actorId: who.staffId,
  });
  return { staffId: target.id, status: "removed", ...counts };
}

/**
 * `POST /api/staff/:staffId/reset-factors` ([SA-14]): every session, passkey and authenticator of
 * the member goes, they are `pending` again, and a new enrolment code is in the answer, once.
 */
export async function resetStaffFactors(
  deps: StaffDeps,
  tx: UnitTx,
  who: StaffActor,
  staffId: string,
): Promise<{ staffId: string; status: "pending"; enrolmentCode: IssuedCode }> {
  const { target } = await actingOn(deps, tx, who, staffId, "staff.reset_factors", "reset");
  const stepUp = await who.stepUp(tx, {
    action: "staff.reset_factors",
    target: target.id,
    body: {},
  });
  const now = deps.clock.now();
  const actor = { ...who.actor, stepUp };
  const counts = await endSessionsAndFactors(tx, target);
  await deps.audit(tx, {
    event: "staff.factors_reset",
    actor,
    target: target.id,
    metadata: counts,
    request: who.request,
  });
  await tx.query(
    `UPDATE staff.member
        SET status = 'pending', factor_enrolled_at = NULL, two_factor_enabled = false, updated_at = $2
      WHERE id = $1`,
    [target.id, now],
  );
  const code = await issueEnrolmentCode(tx, deps, {
    memberId: target.id,
    reason: "reset",
    actor,
    request: who.request,
  });
  await noticeEveryone(deps, tx, { email: target.email }, (audience) => ({
    template: "staff/staff-factors-reset",
    params: { staffId: target.id, audience },
  }));
  deps.lines.write("staff.changed", "warn", {
    kind: "reset",
    staffId: target.id,
    actorId: who.staffId,
  });
  return { staffId: target.id, status: "pending", enrolmentCode: code };
}

/** `POST /api/staff/:staffId/enrolment-code`: a pending member's new code; the live one is void. */
export async function newEnrolmentCode(
  deps: StaffDeps,
  tx: UnitTx,
  who: StaffActor,
  staffId: string,
): Promise<{ staffId: string; enrolmentCode: IssuedCode }> {
  const { target } = await actingOn(deps, tx, who, staffId, "staff.add", null);
  if (target.status !== "pending") {
    throw new StaffRefusal("conflict", "staff.not_pending", { reason: "not_pending" });
  }
  const stepUp = await who.stepUp(tx, {
    action: "staff.enrolment_code",
    target: target.id,
    body: {},
  });
  const code = await issueEnrolmentCode(tx, deps, {
    memberId: target.id,
    reason: "reissued",
    actor: { ...who.actor, stepUp },
    request: who.request,
  });
  return { staffId: target.id, enrolmentCode: code };
}

export interface StaffListRow {
  id: string;
  email: string;
  roleKey: string;
  roleLabel: string;
  status: "pending" | "active";
  lastSignedInAt: string | null;
  addedAt: string;
  factors: { passkeys: number; authenticator: boolean };
  you: boolean;
}

/** `GET /api/staff`: the members who can use Fin Admin or are about to (§10.2), paged. */
export async function listStaff(
  tx: UnitTx,
  who: StaffActor,
  paging: { page: number; size: number },
): Promise<{ items: StaffListRow[]; total: number; page: number; size: number }> {
  const offset = (paging.page - 1) * paging.size;
  const rows = await tx.query<{
    id: string;
    email: string;
    role_key: string;
    status: "pending" | "active";
    last_signed_in_at: Date | null;
    created_at: Date;
    passkeys: number;
    authenticator: boolean;
    total: number;
  }>(
    `SELECT m.id, m.email, m.role_key, m.status, m.last_signed_in_at, m.created_at,
            (SELECT count(*)::integer FROM staff.passkey p WHERE p.user_id = m.id) AS passkeys,
            EXISTS (SELECT 1 FROM staff.two_factor t WHERE t.user_id = m.id AND t.verified) AS authenticator,
            count(*) OVER ()::integer AS total
       FROM staff.member m
      WHERE m.status <> 'removed'
      ORDER BY m.created_at, m.id
      LIMIT $1 OFFSET $2`,
    [paging.size, offset],
  );
  const items: StaffListRow[] = [];
  for (const row of rows.rows) {
    const role = await resolveStaffRole(tx, row.role_key);
    items.push({
      id: row.id,
      email: row.email,
      roleKey: row.role_key,
      roleLabel: staffRoleLabel(role),
      status: row.status,
      lastSignedInAt: row.last_signed_in_at?.toISOString() ?? null,
      addedAt: row.created_at.toISOString(),
      factors: { passkeys: Number(row.passkeys), authenticator: row.authenticator },
      you: row.id === who.staffId,
    });
  }
  let total = Number(rows.rows[0]?.total ?? 0);
  if (rows.rows.length === 0 && offset > 0) {
    const counted = await tx.query<{ n: number }>(
      "SELECT count(*)::integer AS n FROM staff.member WHERE status <> 'removed'",
    );
    total = Number(counted.rows[0]?.n ?? 0);
  }
  return { items, total, page: paging.page, size: paging.size };
}

/**
 * `POST /api/enrolment/redeem` (§6.5): the pending member's own aal1 session presents the code
 * the Admin handed over; a right one opens a 10-minute enrolment window on that session. Wrong
 * tries are counted in the same unit, which commits even when the code is refused.
 */
export async function redeemCode(
  deps: StaffDeps,
  tx: UnitTx,
  who: StaffActor,
  code: string,
): Promise<{ ok: true; windowUntil: Date } | { ok: false; reason: string }> {
  if (who.gate !== "pending") throw new AuthRefusal("forbidden", "staff.not_pending");
  const result = await redeemEnrolmentCode(
    tx,
    { clock: deps.realm.runtime.clock, audit: deps.realm.runtime.audit, lines: deps.lines },
    {
      memberId: who.staffId,
      sessionId: who.sessionId,
      code,
      context: { clientIp: who.request.clientIp, userAgent: who.request.userAgent },
    },
  );
  return result.ok ? { ok: true, windowUntil: result.windowUntil } : result;
}
