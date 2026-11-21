// Staff enrolment codes ([SA-29], spec 02 §6.5): 16 Crockford base32 characters in four groups
// of four (80 bits) from crypto.getRandomValues, shown once to the Admin who added or reset the
// member, stored only as SHA-256, alive 30 minutes, single use, bound to one member. Redeeming one
// opens a 10-minute enrolment window on the pending member's aal1 session; 5 wrong tries void it.
//
// Spec 02 places the format and hashing tests in packages/staff (T-SAT-12, L-SAT-04); the staff
// realm cannot enrol anyone without them, so this lane builds them and L-SAT-04's routes call them.
import { createHash, timingSafeEqual } from "node:crypto";
import type { RecordAudit } from "../audit/record.ts";
import type { Clock } from "../ports/clock.ts";
import { MINUTE } from "../ports/clock.ts";
import type { UnitTx } from "../ports/db.ts";
import { newId } from "../ports/ids.ts";
import type { LineSink } from "../ports/log.ts";

export const ENROLMENT_CODE_LIFETIME_MS = 30 * MINUTE;
export const ENROLMENT_WINDOW_MS = 10 * MINUTE;
export const ENROLMENT_MAX_WRONG = 5;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A new code: 16 characters, displayed `XXXX-XXXX-XXXX-XXXX`. */
export function generateEnrolmentCode(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let bits = 0;
  let buffer = 0;
  let out = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 31];
    }
  }
  return out.match(/.{4}/g)?.join("-") ?? out;
}

/** Normalises typed input: case, hyphens and spaces, and Crockford's I/L to 1 and O to 0. */
export function normaliseEnrolmentCode(input: string): string | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(clean) ? clean : null;
}

export function hashEnrolmentCode(normalised: string): Buffer {
  return createHash("sha256").update(normalised, "utf8").digest();
}

export interface EnrolmentDeps {
  clock: Clock;
  audit: RecordAudit;
  lines: LineSink;
}

export type IssueReason = "added" | "reset" | "reissued" | "bootstrap";

/**
 * Issues a member's code, voiding any live one, with `staff.enrolment_code_issued` in the same
 * transaction. The code is returned once, for the screen (or the operator's terminal) only.
 */
export async function issueEnrolmentCode(
  tx: UnitTx,
  deps: EnrolmentDeps,
  input: {
    memberId: string;
    reason: IssueReason;
    issuedBy: string;
    actor: { kind: "staff" | "operator"; id: string | null };
  },
): Promise<{ id: string; code: string; expiresAt: Date }> {
  const now = deps.clock.now();
  await tx.query(
    "UPDATE staff.enrolment_code SET voided_at = $2 WHERE member_id = $1 AND redeemed_at IS NULL AND voided_at IS NULL",
    [input.memberId, now],
  );
  const code = generateEnrolmentCode();
  const normalised = normaliseEnrolmentCode(code) as string;
  const id = newId("enc", deps.clock);
  const expiresAt = new Date(now.getTime() + ENROLMENT_CODE_LIFETIME_MS);
  await tx.query(
    `INSERT INTO staff.enrolment_code (id, member_id, code_hash, reason, issued_by, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      input.memberId,
      hashEnrolmentCode(normalised),
      input.reason,
      input.issuedBy,
      now,
      expiresAt,
    ],
  );
  await deps.audit(tx, {
    event: "staff.enrolment_code_issued",
    actor: {
      kind: input.actor.kind,
      id: input.actor.id,
      via: input.actor.kind === "operator" ? "operator" : "admin",
    },
    target: id,
    refs: [input.memberId],
    metadata: { reason: input.reason },
  });
  return { id, code, expiresAt };
}

export type RedeemResult =
  | { ok: true; enrolmentCodeId: string; windowUntil: Date }
  | { ok: false; reason: "wrong" | "expired" | "used" | "void" };

/**
 * POST /api/enrolment/redeem's core (§6.5, §14.3): a pending member's aal1 session presents the
 * code; a right one opens the enrolment window on that session.
 */
export async function redeemEnrolmentCode(
  tx: UnitTx,
  deps: EnrolmentDeps,
  input: {
    memberId: string;
    sessionId: string;
    code: string;
    context?: { clientIp: string | null; userAgent: string | null };
  },
): Promise<RedeemResult> {
  const now = deps.clock.now();
  const refuse = (reason: "wrong" | "expired" | "used" | "void"): RedeemResult => {
    deps.lines.write("staff.enrolment_refused", "warn", { staffId: input.memberId, reason });
    return { ok: false, reason };
  };
  const live = await tx.query<{
    id: string;
    code_hash: Buffer;
    expires_at: Date;
    failed_tries: number;
  }>(
    `SELECT id, code_hash, expires_at, failed_tries FROM staff.enrolment_code
      WHERE member_id = $1 AND redeemed_at IS NULL AND voided_at IS NULL FOR UPDATE`,
    [input.memberId],
  );
  const row = live.rows[0];
  if (row === undefined) {
    const last = await tx.query<{ redeemed_at: Date | null }>(
      "SELECT redeemed_at FROM staff.enrolment_code WHERE member_id = $1 ORDER BY issued_at DESC LIMIT 1",
      [input.memberId],
    );
    return refuse(last.rows[0]?.redeemed_at != null ? "used" : "void");
  }
  if (row.expires_at.getTime() <= now.getTime()) {
    await tx.query("UPDATE staff.enrolment_code SET voided_at = $2 WHERE id = $1", [row.id, now]);
    return refuse("expired");
  }
  const normalised = normaliseEnrolmentCode(input.code);
  const given = normalised === null ? Buffer.alloc(32) : hashEnrolmentCode(normalised);
  if (normalised === null || !timingSafeEqual(given, row.code_hash)) {
    const tries = Number(row.failed_tries) + 1;
    await tx.query(
      `UPDATE staff.enrolment_code
          SET failed_tries = $2::smallint,
              voided_at = CASE WHEN $2::integer >= $3::integer THEN $4::timestamptz ELSE NULL END
        WHERE id = $1`,
      [row.id, tries, ENROLMENT_MAX_WRONG, now],
    );
    return refuse("wrong");
  }
  const windowUntil = new Date(now.getTime() + ENROLMENT_WINDOW_MS);
  await deps.audit(tx, {
    event: "staff.enrolment_code_redeemed",
    actor: { kind: "staff", id: input.memberId, via: "admin" },
    target: row.id,
    refs: [input.memberId, input.sessionId],
    metadata: {},
    ...(input.context === undefined ? {} : { context: input.context }),
  });
  await tx.query(
    "UPDATE staff.enrolment_code SET redeemed_at = $2, redeemed_session_id = $3 WHERE id = $1",
    [row.id, now, input.sessionId],
  );
  await tx.query("UPDATE staff.session SET enrolment_open_until = $2 WHERE id = $1", [
    input.sessionId,
    windowUntil,
  ]);
  return { ok: true, enrolmentCodeId: row.id, windowUntil };
}
