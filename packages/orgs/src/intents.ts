// Step-up intents bound to an organisation (spec 02 §7.1, §7.2, §7.5): the same rows, the same
// protocol and the same refusals as packages/identity's own (src/step-up/intents.ts), with the
// organisation in the binding and in the digest. The identity package exports only `paramsDigest`
// and `hasFreshProof` of that module, and its `requirePerson` binds no organisation, so this area
// keeps these few statements beside its guard; the realm's after-hook proves an intent of either
// origin, since a ceremony proves an intent by its ID, session and person only (§7.4). Moving to
// one exported implementation is recorded for the identity lane.
//
// Times are the database's (`now()`), so replicas never disagree about a 5-minute limit.
import { AuthRefusal, type LineSink, type UnitTx } from "@fin/identity";
import { type DateClock, newId } from "./ids.ts";

export const INTENT_HEADER = "fin-step-up-intent";
const INTENT_ID = /^sti_[0-9a-hjkmnp-tv-z]{26}$/;

export type IntentRefusal =
  | "unproved"
  | "expired"
  | "used"
  | "other_session"
  | "other_action"
  | "digest";

export type ProofMethod = "passkey" | "totp" | "backup_code";

export interface IntentBinding {
  sessionId: string;
  principalId: string;
  organizationId: string | null;
  action: string;
  digest: Buffer;
}

interface IntentRow {
  realm: string;
  session_id: string;
  principal_id: string;
  organization_id: string | null;
  action: string;
  params_digest: Buffer;
  proved_at: Date | null;
  consumed_at: Date | null;
  live: boolean;
}

/** The intent a request names, when the header holds an intent ID's shape. */
export function intentIdFrom(headers: Headers): string | null {
  const value = headers.get(INTENT_HEADER);
  return value !== null && INTENT_ID.test(value) ? value : null;
}

export interface IntentLimits {
  consume(
    db: UnitTx,
    bucket: "step_up_intents",
    subject: string,
  ): Promise<{ allowed: boolean; retryAfter: number }>;
}

/** Makes an unproved intent for this session, person, organisation and digest (5 minutes). */
export async function createIntent(
  tx: UnitTx,
  deps: { clock: DateClock; limits: IntentLimits },
  binding: IntentBinding & { reasonKey: string },
): Promise<{ id: string; expiresAt: Date }> {
  const limit = await deps.limits.consume(tx, "step_up_intents", binding.sessionId);
  if (!limit.allowed) {
    throw new AuthRefusal("rate_limited", "limits.step_up_intents", {
      retry_after: limit.retryAfter,
    });
  }
  const id = newId("sti", deps.clock);
  const result = await tx.query<{ expires_at: Date }>(
    `INSERT INTO ops.step_up_intent
       (id, realm, session_id, principal_id, organization_id, action, params_digest, reason_key,
        created_at, expires_at)
     VALUES ($1, 'developer', $2, $3, $4, $5, $6, $7, now(), now() + interval '5 minutes')
     RETURNING expires_at`,
    [
      id,
      binding.sessionId,
      binding.principalId,
      binding.organizationId,
      binding.action,
      binding.digest,
      binding.reasonKey,
    ],
  );
  const expiresAt = result.rows[0]?.expires_at;
  if (expiresAt === undefined) throw new Error("orgs: the intent was not written");
  return { id, expiresAt };
}

/** Why the named intent cannot serve this binding, or null when it can (§7.5). */
export async function intentProblem(
  tx: UnitTx,
  intentId: string,
  binding: IntentBinding,
): Promise<IntentRefusal | null> {
  const result = await tx.query<IntentRow>(
    `SELECT realm, session_id, principal_id, organization_id, action, params_digest, proved_at,
            consumed_at, expires_at > now() AS live
       FROM ops.step_up_intent WHERE id = $1`,
    [intentId],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    row.realm !== "developer" ||
    row.session_id !== binding.sessionId ||
    row.principal_id !== binding.principalId
  ) {
    return "other_session";
  }
  if (row.action !== binding.action || row.organization_id !== binding.organizationId) {
    return "other_action";
  }
  if (!Buffer.from(row.params_digest).equals(binding.digest)) return "digest";
  if (row.consumed_at !== null) return "used";
  if (!row.live) return "expired";
  if (row.proved_at === null) return "unproved";
  return null;
}

/**
 * Consumes the intent in the action's transaction. Two concurrent re-sends cannot both pass: the
 * second waits on the row lock and then finds it consumed (§7.5, AC-SAT-32).
 */
export async function consumeIntent(
  tx: UnitTx,
  intentId: string,
  binding: IntentBinding,
): Promise<ProofMethod | null> {
  const result = await tx.query<{ proof_method: ProofMethod }>(
    `UPDATE ops.step_up_intent
        SET consumed_at = now(), consumed_request_id = $7
      WHERE id = $1 AND realm = 'developer' AND session_id = $2 AND principal_id = $3
        AND action = $4 AND params_digest = $5 AND organization_id IS NOT DISTINCT FROM $6
        AND consumed_at IS NULL AND proved_at IS NOT NULL AND expires_at > now()
      RETURNING proof_method`,
    [
      intentId,
      binding.sessionId,
      binding.principalId,
      binding.action,
      binding.digest,
      binding.organizationId,
      tx.requestId,
    ],
  );
  return result.rows[0]?.proof_method ?? null;
}

/** The `step_up.refused` line and the refusal for an intent that cannot serve (§7.5). */
export function refuseIntent(lines: LineSink, action: string, reason: IntentRefusal): AuthRefusal {
  lines.write("step_up.refused", "warn", { realm: "developer", action, reason });
  return new AuthRefusal("step_up_invalid", `step_up.${reason}`, { reason });
}
