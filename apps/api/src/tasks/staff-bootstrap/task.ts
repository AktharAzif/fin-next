// `migrate --task staff-bootstrap` (spec 02 §10.6, §10.4; CR-11, S0-17; L-SAT-04): the first Admin.
// The operator's half, `pnpm fin task <env> staff-bootstrap` (L-SAT-09), asks for the address at the
// secure prompt, makes the enrolment code on the operator's machine and shows it there once; this
// run receives only the address and the SHA-256 of the normalised code (FIN_TASK_PARAMS), never
// the code. It calls `staff.bootstrap_admin()` (packages/staff/migrations/*_staff_bootstrap.sql) in
// the run's one transaction as fin_owner, which creates exactly one pending Admin when there is no
// active one and refuses otherwise, or, with `reset`, puts the only active Admin back to pending
// after they lost every factor; and records `staff.member_added` (or `staff.factors_reset`),
// `staff.enrolment_code_issued` and `staff.bootstrapped` with actor `operator`, `via: operator`.
// The answer and the `task.done` line are IDs only. A refusal is a TaskError carrying the task's
// own code, which `migrate` prints as `task.failed`'s `code` for the operator.
import { z } from "zod";
import { defineTask, TaskError } from "../types.ts";

/** What the database refuses with, as the task's own failure codes (never a value). */
export const BOOTSTRAP_REFUSALS: Readonly<Record<string, string>> = {
  FB001: "active_admin_exists",
  FB002: "pending_admin_exists",
  FB003: "already_staff",
  FB004: "reset_needs_active_admin",
  FB005: "another_admin_can_reset",
};

export const staffBootstrapParams = z.strictObject({
  /** The Admin's address, which the Access application's Allow list already holds (§10.1). */
  address: z
    .string()
    .trim()
    .max(254)
    .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/),
  /** The SHA-256 (hex) of the normalised enrolment code; the code itself never leaves the operator. */
  codeHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** `true` only for the last Admin who lost every factor (§10.4). */
  reset: z.boolean().default(false),
  /** Why, as a preset code (never typed text): `first_admin`, `lost_factors`, ... */
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
});

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export const staffBootstrap = defineTask({
  name: "staff-bootstrap",
  params: staffBootstrapParams,
  async run(tx, p, context) {
    const ids = {
      member_id: tx.ids.newId("stf"),
      code_id: tx.ids.newId("enc"),
      member_event_id: tx.ids.newId("aud"),
      code_event_id: tx.ids.newId("aud"),
      bootstrap_event_id: tx.ids.newId("aud"),
      journal_id: tx.ids.newId("jrn"),
    };
    let answer: { staff_id: string; enrolment_code_id: string; reactivated: boolean };
    try {
      const result = await tx.query<{ answer: typeof answer }>(
        "SELECT staff.bootstrap_admin($1, $2, $3, $4, $5, $6, $7::jsonb) AS answer",
        [
          p.address.toLowerCase(),
          Buffer.from(p.codeHash, "hex"),
          p.reset,
          p.reasonCode,
          context.runId,
          context.release,
          JSON.stringify(ids),
        ],
      );
      answer = result.rows[0]?.answer as typeof answer;
    } catch (error) {
      const refusal = BOOTSTRAP_REFUSALS[sqlStateOf(error) ?? ""];
      if (refusal !== undefined) {
        throw new TaskError(refusal, `staff-bootstrap refused: ${refusal}`);
      }
      throw error;
    }
    return {
      rowsChanged: 2,
      ids: {
        staffId: answer.staff_id,
        enrolmentCodeId: answer.enrolment_code_id,
        reset: p.reset ? 1 : 0,
        reactivated: answer.reactivated ? 1 : 0,
      },
    };
  },
});
