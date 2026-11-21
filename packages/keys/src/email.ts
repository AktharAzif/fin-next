// The API keys area's security notices (spec 05 §4.10; spec 02 §12.3, §17.1; [SA-41]), queued with
// `email.enqueue()` in the key change's own unit of work: a notice that cannot be queued poisons the
// unit, so the change that needed it rolls back. Only the worker sends. Each row's parameters are
// checked against the template's own strict schema before any SQL, so a notice that could never be
// sent refuses the change rather than sitting in the outbox. The templates are packages/email's
// `api-keys/` folder, read by their paths (they import only zod and packages/email's leaf modules).
import { newId as coreNewId, type IdPrefix } from "@fin/core";
import type { z } from "zod";
import { keyChanged } from "../../email/src/templates/api-keys/key-changed.ts";
import { keyExposed } from "../../email/src/templates/api-keys/key-exposed.ts";
import type { DateClock, KeysLines, KeysTx } from "./tx.ts";
import { sqlStateOf } from "./tx.ts";

export const KEY_TEMPLATES = {
  "api-keys/key-changed": keyChanged,
  "api-keys/key-exposed": keyExposed,
} as const;

export type KeyTemplate = keyof typeof KEY_TEMPLATES;

export interface KeyEmail<T extends KeyTemplate = KeyTemplate> {
  template: T;
  to: string;
  params: z.input<(typeof KEY_TEMPLATES)[T]["params"]>;
}

export type EnqueueKeyEmail = (tx: KeysTx, email: KeyEmail) => Promise<string>;

export class KeyEmailError extends Error {
  override readonly name = "KeyEmailError";
  constructor(template: string, key: string) {
    // The template and the parameter's name only, never its value.
    super(`email parameters refused for ${template} at ${key}`);
  }
}

export function createEnqueueKeyEmail(deps: {
  clock: DateClock;
  lines: KeysLines;
}): EnqueueKeyEmail {
  return async (tx, email) => {
    const template = KEY_TEMPLATES[email.template];
    const parsed = (template.params as z.ZodType).safeParse(email.params);
    if (!parsed.success) {
      tx.poison("email_params");
      deps.lines.write("email.security_unsent", "error", {
        template: email.template,
        reason: "params_refused",
      });
      throw new KeyEmailError(email.template, String(parsed.error.issues[0]?.path[0] ?? ""));
    }
    const id = coreNewId("eml" as IdPrefix, { now: () => deps.clock.now().getTime() });
    try {
      await tx.query("SELECT email.enqueue($1::jsonb)", [
        JSON.stringify({
          id,
          template: email.template,
          recipient_kind: "address",
          recipient: email.to.toLowerCase(),
          params: parsed.data,
        }),
      ]);
    } catch (error) {
      tx.poison("email_enqueue");
      deps.lines.write("email.security_unsent", "error", {
        template: email.template,
        reason: sqlStateOf(error) === "FE001" ? "not_allowed" : "enqueue_failed",
      });
      throw error;
    }
    return id;
  };
}

/** The rows `email.template_grant` holds for this area's templates (spec 08 §4.4's allowlist). */
export function keyTemplateGrants(): { template: string; role: string; category: string }[] {
  return [
    { template: "api-keys/key-changed", role: "fin_console", category: "security" },
    { template: "api-keys/key-exposed", role: "fin_console", category: "security" },
    { template: "api-keys/key-exposed", role: "fin_api", category: "security" },
  ];
}
