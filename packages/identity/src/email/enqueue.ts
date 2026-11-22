// email.enqueue() in the caller's unit of work (spec 01 §6.10, spec 02 §17.1, [SA-41]). A notice
// that cannot be queued poisons the unit, so the action that needed it rolls back: an action
// that mints a credential is refused when its notice cannot be queued. Only the worker sends.
import type { Clock } from "../ports/clock.ts";
import { sqlState, type UnitTx } from "../ports/db.ts";
import { newId } from "../ports/ids.ts";
import type { LineSink } from "../ports/log.ts";
import { REALM_TEMPLATES, type RealmTemplateName } from "./templates.ts";

export interface EnqueueInput {
  template: RealmTemplateName;
  /** The recipient's address, lower-cased. */
  to: string;
  params: Record<string, unknown>;
}

export type EmailEnqueue = (tx: UnitTx, input: EnqueueInput) => Promise<string>;

export class EmailParamsError extends Error {
  constructor(template: string, key: string) {
    super(`email parameters refused for ${template} at ${key}`);
    this.name = "EmailParamsError";
  }
}

export function createEmailEnqueue(deps: { clock: Clock; lines: LineSink }): EmailEnqueue {
  return async (tx, input) => {
    const spec = REALM_TEMPLATES[input.template];
    const parsed = spec.params.safeParse(input.params);
    if (!parsed.success) {
      tx.poison("email_params");
      throw new EmailParamsError(input.template, String(parsed.error.issues[0]?.path[0] ?? ""));
    }
    const id = newId("eml", deps.clock);
    try {
      await tx.query("SELECT email.enqueue($1::jsonb)", [
        JSON.stringify({
          id,
          template: input.template,
          recipient_kind: "address",
          recipient: input.to.toLowerCase(),
          params: parsed.data,
        }),
      ]);
      return id;
    } catch (error) {
      tx.poison("email_enqueue");
      deps.lines.write("email.security_unsent", "error", {
        template: input.template,
        reason: sqlState(error) === "FE001" ? "not_allowed" : "enqueue_failed",
      });
      throw error;
    }
  };
}
