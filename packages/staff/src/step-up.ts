// Step-up intents for Fin Admin's own routes (spec 02 §7.1 to §7.5, [SA-08], S2-31): a staff change
// takes an intent bound to its session, its member, the action, the target and the digest of the
// bound fields. The route checks everything else first (the session, the permission, the outrank
// and giving rules inside the staff-change lock, the input), so nobody proves a factor for something
// they cannot do; only then:
//   - no `Fin-Step-Up-Intent` header: an intent is made (5 minutes, the database's clock; at most 30
//     per session per 10 minutes, S2-32) and the answer is `403 step_up_required` with its ID;
//   - a header naming an intent that is not this one, proved and unspent: `403 step_up_invalid`;
//   - otherwise the intent is spent in the action's own transaction, so two re-sends cannot both
//     pass (§7.5), and the action's audit event carries it.
// The ceremony that proves an intent is @fin/identity's realm (its after-hook). These primitives
// mirror identity's step-up/intents.ts, which its package does not export (recorded in the PR).
import { AuthRefusal, paramsDigest, type Realm } from "@fin/identity";
import type { AuditActorInput } from "./audit/record.ts";
import { newId } from "./ids.ts";
import type { UnitTx } from "./ports.ts";

export const INTENT_HEADER = "fin-step-up-intent";
const INTENT_ID = /^sti_[0-9a-hjkmnp-tv-z]{26}$/;

export type IntentRefusal =
  | "unproved"
  | "expired"
  | "used"
  | "other_session"
  | "other_action"
  | "digest";

export type StepUpRef = NonNullable<AuditActorInput["stepUp"]>;

export interface StaffBinding {
  sessionId: string;
  staffId: string;
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

export function intentIdFrom(headers: Headers): string | null {
  const value = headers.get(INTENT_HEADER);
  return value !== null && INTENT_ID.test(value) ? value : null;
}

/** Why the named intent cannot serve this binding, or null when it can (§7.5). */
export function intentProblem(
  row: IntentRow | undefined,
  binding: StaffBinding,
): IntentRefusal | null {
  if (
    row === undefined ||
    row.realm !== "staff" ||
    row.session_id !== binding.sessionId ||
    row.principal_id !== binding.staffId
  ) {
    return "other_session";
  }
  if (row.action !== binding.action || row.organization_id !== null) return "other_action";
  if (!Buffer.from(row.params_digest).equals(binding.digest)) return "digest";
  if (row.consumed_at !== null) return "used";
  if (!row.live) return "expired";
  if (row.proved_at === null) return "unproved";
  return null;
}

export interface StepUpRequest {
  /** The action key, one of the realm's staff actions (STAFF_ACTIONS or identity's). */
  action: string;
  /** The ID the digest covers besides the action: the member, the switch, the session. */
  target: string | null;
  /** The request's fields; only those the action binds are digested. Never a secret. */
  body: Readonly<Record<string, unknown>>;
}

export interface StepUpSubject {
  sessionId: string;
  staffId: string;
  /** The member's factors: an intent is only ever asked of someone who can prove it. */
  methods: readonly ("passkey" | "authenticator")[];
}

/**
 * The intent check of one stepped-up staff action, in the action's transaction. Returns the
 * step-up the action's audit event carries; throws the §7.5 answers otherwise.
 */
export async function requireIntent(
  realm: Realm,
  tx: UnitTx,
  headers: Headers,
  requestId: string,
  subject: StepUpSubject,
  request: StepUpRequest,
): Promise<StepUpRef> {
  const action = realm.runtime.actions.get(request.action);
  if (action === undefined || action.realm !== "staff" || action.kind !== "intent") {
    throw new Error(`requireIntent: ${request.action} is not a staff intent action`);
  }
  if (subject.methods.length === 0) {
    throw new AuthRefusal("second_factor_required", "step_up.no_factor", { hold: false });
  }
  const binding: StaffBinding = {
    sessionId: subject.sessionId,
    staffId: subject.staffId,
    action: action.key,
    digest: paramsDigest({
      realm: "staff",
      action: action.key,
      org: null,
      target: request.target,
      body: request.body,
      bind: action.bind,
    }),
  };
  const headerId = intentIdFrom(headers);
  if (headerId === null) {
    const limit = await realm.runtime.limits.consume(tx, "step_up_intents", subject.sessionId);
    if (!limit.allowed) {
      throw new AuthRefusal("rate_limited", "limits.step_up_intents", {
        retry_after: limit.retryAfter,
      });
    }
    const id = newId("sti", realm.runtime.clock);
    const created = await tx.query<{ expires_at: Date }>(
      `INSERT INTO ops.step_up_intent
         (id, realm, session_id, principal_id, organization_id, action, params_digest, reason_key, created_at, expires_at)
       VALUES ($1, 'staff', $2, $3, NULL, $4, $5, $6, now(), now() + interval '5 minutes')
       RETURNING expires_at`,
      [id, subject.sessionId, subject.staffId, action.key, binding.digest, action.reasonKey],
    );
    throw new AuthRefusal("step_up_required", "step_up.required", {
      intent_id: id,
      step_up_kind: "intent",
      methods: [...subject.methods],
      reason_key: action.reasonKey,
      expires_at: (created.rows[0] as { expires_at: Date }).expires_at.toISOString(),
    });
  }
  const read = await tx.query<IntentRow>(
    `SELECT realm, session_id, principal_id, organization_id, action, params_digest, proved_at,
            consumed_at, expires_at > now() AS live
       FROM ops.step_up_intent WHERE id = $1`,
    [headerId],
  );
  const problem = intentProblem(read.rows[0], binding);
  if (problem !== null) {
    realm.runtime.lines.write("step_up.refused", "warn", {
      realm: "staff",
      action: action.key,
      reason: problem,
    });
    throw new AuthRefusal("step_up_invalid", `step_up.${problem}`, { reason: problem });
  }
  const spent = await tx.query<{ proof_method: StepUpRef["method"] }>(
    `UPDATE ops.step_up_intent SET consumed_at = now(), consumed_request_id = $6
      WHERE id = $1 AND realm = 'staff' AND session_id = $2 AND principal_id = $3 AND action = $4
        AND params_digest = $5 AND organization_id IS NULL
        AND consumed_at IS NULL AND proved_at IS NOT NULL AND expires_at > now()
      RETURNING proof_method`,
    [headerId, binding.sessionId, binding.staffId, binding.action, binding.digest, requestId],
  );
  const method = spent.rows[0]?.proof_method;
  if (method === undefined) {
    // Lost the race to a concurrent re-send with the same intent: nothing of this one stays.
    throw new AuthRefusal(
      "step_up_invalid",
      "step_up.used",
      { reason: "used" },
      { rollback: true },
    );
  }
  return { kind: "intent", method, ref: headerId };
}
