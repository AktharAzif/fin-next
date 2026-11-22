// Enrolment codes ([SA-29], spec 02 §6.5, T-SAT-12): 16 Crockford base32 characters in four groups
// of four (80 bits) from crypto.getRandomValues, shown once to the Admin who added or reset the
// member (or, for the first Admin, on the operator's terminal), stored only as the SHA-256 of the
// normalised code, alive 30 minutes, single use, bound to one member; one live code per member.
//
// The code is drawn by @fin/identity's generateEnrolmentCode, the one generator, which redraws any
// code with no group of four mixing a letter and a digit: @fin/email's name fields hide a code
// only in that shape, so one passed into a name by mistake is never mailed (T08-23, SA-29).
//
// The pending member redeems a code through @fin/identity's redeemEnrolmentCode, which normalises
// and hashes exactly as this file does; enrolment-codes.db.test.ts issues with this file and
// redeems with that one, so the two cannot drift apart. The issuing lives here rather than in
// @fin/identity's issueEnrolmentCode because a Fin Admin actor's audit row carries the step-up
// that authorised it and the request's address and device ([BC-03]), which that function cannot.
import { createHash } from "node:crypto";
import { generateEnrolmentCode } from "@fin/identity";
import type { AuditActorInput, RecordStaffAudit } from "./audit/record.ts";
import { newId } from "./ids.ts";
import type { Clock, RequestFacts, UnitTx } from "./ports.ts";

export const ENROLMENT_CODE_LIFETIME_MS = 30 * 60_000;
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const NORMALISED = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/** A new code, shown `XXXX-XXXX-XXXX-XXXX`, from @fin/identity's one generator. */
export { generateEnrolmentCode };

/** Typed input as stored: upper case, without spaces or hyphens, I and L read as 1 and O as 0. */
export function normaliseEnrolmentCode(input: string): string | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return NORMALISED.test(clean) ? clean : null;
}

/** The stored form: SHA-256 of the normalised code. The operator's half hashes the same way. */
export function hashEnrolmentCode(code: string): Buffer {
  const normalised = normaliseEnrolmentCode(code);
  if (normalised === null) throw new TypeError("not an enrolment code");
  return createHash("sha256").update(normalised, "utf8").digest();
}

export type IssueReason = "added" | "reset" | "reissued";

export interface IssuedCode {
  id: string;
  /** Shown once, in the answer only: never stored, logged, emailed or replayed. */
  code: string;
  expiresAt: Date;
}

/**
 * Issues a member's code in the action's transaction: voids any live one, stores the new hash,
 * and writes `staff.enrolment_code_issued` with the actor (and the step-up that authorised it).
 */
export async function issueEnrolmentCode(
  tx: UnitTx,
  deps: { clock: Clock; audit: RecordStaffAudit },
  input: {
    memberId: string;
    reason: IssueReason;
    actor: AuditActorInput;
    request: RequestFacts;
  },
): Promise<IssuedCode> {
  const now = deps.clock.now();
  await tx.query(
    `UPDATE staff.enrolment_code SET voided_at = $2
      WHERE member_id = $1 AND redeemed_at IS NULL AND voided_at IS NULL`,
    [input.memberId, now],
  );
  const code = generateEnrolmentCode();
  const id = newId("enc", deps.clock);
  const expiresAt = new Date(now.getTime() + ENROLMENT_CODE_LIFETIME_MS);
  await deps.audit(tx, {
    event: "staff.enrolment_code_issued",
    actor: input.actor,
    target: id,
    refs: [input.memberId],
    metadata: { reason: input.reason },
    request: input.request,
  });
  await tx.query(
    `INSERT INTO staff.enrolment_code (id, member_id, code_hash, reason, issued_by, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.memberId, hashEnrolmentCode(code), input.reason, input.actor.id, now, expiresAt],
  );
  return { id, code, expiresAt };
}
