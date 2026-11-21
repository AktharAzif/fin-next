// Staff security notices (spec 02 §17.1, §17.3; [SA-41]): queued with `email.enqueue()` in the
// action's own transaction, so a notice that cannot be queued rolls the action back and an action
// that mints a credential is refused when its notice cannot be queued. Only the worker sends. The
// parameters are checked against the template's own schema in @fin/email (L-SAT-05's copy), which
// admits IDs and catalogue labels and never an enrolment code (T-SAT-41).
import { findTemplate } from "@fin/email";
import { newId } from "./ids.ts";
import { type Clock, type LineSink, sqlState, type UnitTx } from "./ports.ts";

export type StaffNoticeTemplate =
  | "staff/staff-access-changed"
  | "staff/staff-factors-reset"
  | "staff/staff-role-permissions-changed"
  | "staff/staff-switch-changed";

export interface StaffNotice {
  template: StaffNoticeTemplate;
  /** The recipient's address, lower-cased by the caller's table. */
  to: string;
  params: Record<string, unknown>;
}

export type EnqueueStaffNotice = (tx: UnitTx, notice: StaffNotice) => Promise<string>;

export class StaffNoticeError extends Error {
  constructor(template: string) {
    super(`the parameters of ${template} were refused`);
    this.name = "StaffNoticeError";
  }
}

export function createEnqueueStaffNotice(deps: {
  clock: Clock;
  lines: LineSink;
}): EnqueueStaffNotice {
  return async (tx, notice) => {
    const template = findTemplate(notice.template);
    const parsed = template?.params.safeParse(notice.params);
    if (template === undefined || parsed === undefined || !parsed.success) {
      tx.poison("email_params");
      throw new StaffNoticeError(notice.template);
    }
    const id = newId("eml", deps.clock);
    try {
      await tx.query("SELECT email.enqueue($1::jsonb)", [
        JSON.stringify({
          id,
          template: notice.template,
          recipient_kind: "address",
          recipient: notice.to.toLowerCase(),
          params: parsed.data,
        }),
      ]);
      return id;
    } catch (error) {
      tx.poison("email_enqueue");
      deps.lines.write("email.security_unsent", "error", {
        template: notice.template,
        reason: sqlState(error) === "FE001" ? "not_allowed" : "enqueue_failed",
      });
      throw error;
    }
  };
}

/** Every active Admin's address, read in the action's transaction (the notices' "every Admin"). */
export async function activeAdminAddresses(tx: UnitTx): Promise<{ id: string; email: string }[]> {
  const result = await tx.query<{ id: string; email: string }>(
    "SELECT id, email FROM staff.member WHERE role_key = 'admin' AND status = 'active' ORDER BY id",
  );
  return result.rows;
}
