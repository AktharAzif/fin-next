// Step-up intents and windows (spec 02 §7, [SA-08], [BC-01], [SA-34]). Times are the database's
// (`now()`), as §7.2 and §7.3 say, so replicas never disagree about a 5-minute limit.
//
// The protocol: a guarded action with no `Fin-Step-Up-Intent` header creates an intent bound to
// the session, the person, the action and the digest of its bound parameters, and answers
// `403 step_up_required`. A ceremony proves it (the realm's after-hook). The re-sent request
// names it; the action checks it and consumes it once, in the action's own transaction.

import { AuthRefusal } from "../errors.ts";
import type { LimitStore } from "../limits.ts";
import type { Clock } from "../ports/clock.ts";
import type { Queryable } from "../ports/db.ts";
import { newId } from "../ports/ids.ts";
import type { LineSink } from "../ports/log.ts";
import type { IntentRefusal, ProofMethod } from "./types.ts";

export const INTENT_HEADER = "fin-step-up-intent";
const INTENT_ID = /^sti_[0-9a-hjkmnp-tv-z]{26}$/;

export type Realm = "developer" | "staff";

export interface IntentBinding {
  realm: Realm;
  sessionId: string;
  principalId: string;
  organizationId: string | null;
  action: string;
  digest: Buffer;
}

export interface IntentRow {
  id: string;
  realm: Realm;
  sessionId: string;
  principalId: string;
  organizationId: string | null;
  action: string;
  digest: Buffer;
  reasonKey: string;
  expiresAt: Date;
  provedAt: Date | null;
  proofMethod: ProofMethod | null;
  consumedAt: Date | null;
  live: boolean;
}

interface RawIntent {
  id: string;
  realm: Realm;
  session_id: string;
  principal_id: string;
  organization_id: string | null;
  action: string;
  params_digest: Buffer;
  reason_key: string;
  expires_at: Date;
  proved_at: Date | null;
  proof_method: ProofMethod | null;
  consumed_at: Date | null;
  live: boolean;
}

function toIntent(row: RawIntent): IntentRow {
  return {
    id: row.id,
    realm: row.realm,
    sessionId: row.session_id,
    principalId: row.principal_id,
    organizationId: row.organization_id,
    action: row.action,
    digest: row.params_digest,
    reasonKey: row.reason_key,
    expiresAt: row.expires_at,
    provedAt: row.proved_at,
    proofMethod: row.proof_method,
    consumedAt: row.consumed_at,
    live: row.live,
  };
}

export function intentIdFrom(headers: Headers): string | null {
  const value = headers.get(INTENT_HEADER);
  return value !== null && INTENT_ID.test(value) ? value : null;
}

export async function createIntent(
  db: Queryable,
  deps: { clock: Clock; limits: LimitStore },
  binding: IntentBinding & { reasonKey: string },
): Promise<{ id: string; expiresAt: Date }> {
  const limit = await deps.limits.consume(db, "step_up_intents", binding.sessionId);
  if (!limit.allowed) {
    throw new AuthRefusal("rate_limited", "limits.step_up_intents", {
      retry_after: limit.retryAfter,
    });
  }
  const id = newId("sti", deps.clock);
  const result = await db.query<{ expires_at: Date }>(
    `INSERT INTO ops.step_up_intent
       (id, realm, session_id, principal_id, organization_id, action, params_digest, reason_key, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now() + interval '5 minutes')
     RETURNING expires_at`,
    [
      id,
      binding.realm,
      binding.sessionId,
      binding.principalId,
      binding.organizationId,
      binding.action,
      binding.digest,
      binding.reasonKey,
    ],
  );
  return { id, expiresAt: result.rows[0]?.expires_at as Date };
}

export async function readIntent(db: Queryable, id: string): Promise<IntentRow | null> {
  const result = await db.query<RawIntent>(
    `SELECT id, realm, session_id, principal_id, organization_id, action, params_digest, reason_key,
            expires_at, proved_at, proof_method, consumed_at, expires_at > now() AS live
       FROM ops.step_up_intent WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toIntent(row);
}

/** Why an intent cannot serve this binding, or null when it can (§7.5). */
export function intentProblem(
  intent: IntentRow | null,
  binding: IntentBinding,
): IntentRefusal | null {
  if (
    intent === null ||
    intent.realm !== binding.realm ||
    intent.sessionId !== binding.sessionId ||
    intent.principalId !== binding.principalId
  ) {
    return "other_session";
  }
  if (intent.action !== binding.action || intent.organizationId !== binding.organizationId) {
    return "other_action";
  }
  if (!intent.digest.equals(binding.digest)) return "digest";
  if (intent.consumedAt !== null) return "used";
  if (!intent.live) return "expired";
  if (intent.provedAt === null) return "unproved";
  return null;
}

/**
 * Consumes the intent in the action's transaction. Two concurrent re-sends cannot both pass:
 * the second waits on the row lock and then finds it consumed (§7.5).
 */
export async function consumeIntent(
  db: Queryable,
  intentId: string,
  binding: IntentBinding,
  requestId: string | null,
): Promise<ProofMethod | null> {
  const result = await db.query<{ proof_method: ProofMethod }>(
    `UPDATE ops.step_up_intent
        SET consumed_at = now(), consumed_request_id = $7
      WHERE id = $1 AND realm = $2 AND session_id = $3 AND principal_id = $4 AND action = $5
        AND params_digest = $6 AND organization_id IS NOT DISTINCT FROM $8
        AND consumed_at IS NULL AND proved_at IS NOT NULL AND expires_at > now()
      RETURNING proof_method`,
    [
      intentId,
      binding.realm,
      binding.sessionId,
      binding.principalId,
      binding.action,
      binding.digest,
      requestId,
      binding.organizationId,
    ],
  );
  return result.rows[0]?.proof_method ?? null;
}

/** Marks an intent of this session and person proved by a ceremony (§7.4). */
export async function proveIntent(
  db: Queryable,
  intentId: string,
  proof: {
    realm: Realm;
    sessionId: string;
    principalId: string;
    method: ProofMethod;
    proofId: string;
  },
): Promise<string | null> {
  const result = await db.query<{ action: string }>(
    `UPDATE ops.step_up_intent
        SET proved_at = now(), proof_method = $5, proof_id = $6
      WHERE id = $1 AND realm = $2 AND session_id = $3 AND principal_id = $4
        AND proved_at IS NULL AND consumed_at IS NULL AND expires_at > now()
      RETURNING action`,
    [intentId, proof.realm, proof.sessionId, proof.principalId, proof.method, proof.proofId],
  );
  return result.rows[0]?.action ?? null;
}

const PROOF_TABLE = { developer: "identity.assurance", staff: "staff.assurance" } as const;
const SESSION_TABLE = { developer: "identity.session", staff: "staff.session" } as const;

/** Writes a proof row: a factor shown in this session (§6.1). */
export async function recordProof(
  db: Queryable,
  clock: Clock,
  realm: Realm,
  proof: { userId: string; sessionId: string; method: ProofMethod; intentId: string | null },
): Promise<string> {
  const id = newId("asr", clock);
  await db.query(
    `INSERT INTO ${PROOF_TABLE[realm]} (id, user_id, session_id, method, intent_id, created_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [id, proof.userId, proof.sessionId, proof.method, proof.intentId],
  );
  return id;
}

/** A window: a factor shown in this session within the last 5 minutes (§7.3, IF-05). */
export async function hasFreshProof(
  db: Queryable,
  realm: Realm,
  sessionId: string,
): Promise<boolean> {
  const result = await db.query<{ fresh: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${PROOF_TABLE[realm]}
       WHERE session_id = $1 AND created_at > now() - interval '5 minutes') AS fresh`,
    [sessionId],
  );
  return result.rows[0]?.fresh === true;
}

/** Moves the open intents and the proofs of a replaced session to its replacement (§11.3). */
export async function moveToReplacement(
  db: Queryable,
  realm: Realm,
  oldSessionId: string,
  newSessionId: string,
): Promise<void> {
  await db.query(`UPDATE ${PROOF_TABLE[realm]} SET session_id = $2 WHERE session_id = $1`, [
    oldSessionId,
    newSessionId,
  ]);
  await db.query(
    "UPDATE ops.step_up_intent SET session_id = $2 WHERE session_id = $1 AND consumed_at IS NULL",
    [oldSessionId, newSessionId],
  );
}

export async function resetStepUpFailures(
  db: Queryable,
  realm: Realm,
  sessionId: string,
): Promise<void> {
  await db.query(
    `UPDATE ${SESSION_TABLE[realm]} SET step_up_failures = 0 WHERE id = $1 AND step_up_failures > 0`,
    [sessionId],
  );
}

/** Counts a wrong code at a step-up; returns the new count (§7.7). */
export async function countStepUpFailure(
  db: Queryable,
  realm: Realm,
  sessionId: string,
): Promise<number> {
  const result = await db.query<{ step_up_failures: number }>(
    `UPDATE ${SESSION_TABLE[realm]} SET step_up_failures = LEAST(step_up_failures + 1, 5)
      WHERE id = $1 RETURNING step_up_failures`,
    [sessionId],
  );
  return Number(result.rows[0]?.step_up_failures ?? 5);
}

/** Writes the `step_up.refused` line for an intent refusal. */
export function refuseIntent(
  lines: LineSink,
  realm: Realm,
  action: string,
  reason: IntentRefusal,
): AuthRefusal {
  lines.write("step_up.refused", "warn", { realm, action, reason });
  return new AuthRefusal("step_up_invalid", `step_up.${reason}`, { reason });
}
