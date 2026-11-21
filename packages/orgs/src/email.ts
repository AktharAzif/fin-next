// The organisation area's security notices and invitation (spec 02 §17.1, §17.2; [SA-41]), queued with
// `email.enqueue()` in the action's own unit of work: a notice that cannot be queued poisons the
// unit, so the action that needed it rolls back. Only the worker sends. The templates themselves
// (copy, classes, subdomains) are packages/email's `orgs/` folder; this module checks each row's
// parameters against the template's own strict schema before any SQL.
import { findTemplate, HIDDEN_VALUE, param } from "@fin/email";
import type { LineSink, UnitTx } from "@fin/identity";
import { type DateClock, newId } from "./ids.ts";

export const ORG_TEMPLATES = [
  "orgs/invitation",
  "orgs/member-joined",
  "orgs/member-removed",
  "orgs/member-role-changed",
  "orgs/role-permissions-changed",
  "orgs/organization-deleted",
] as const;
export type OrgTemplate = (typeof ORG_TEMPLATES)[number];

export interface OrgEmail {
  template: OrgTemplate;
  /** The recipient's address. */
  to: string;
  params: Record<string, unknown>;
}

export type EnqueueOrgEmail = (tx: UnitTx, email: OrgEmail) => Promise<string>;

export class OrgEmailError extends Error {
  constructor(template: string, key: string) {
    // The template and the parameter's name only, never its value.
    super(`email parameters refused for ${template} at ${key}`);
    this.name = "OrgEmailError";
  }
}

function sqlStateOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

export function createEnqueueOrgEmail(deps: {
  clock: DateClock;
  lines: LineSink;
}): EnqueueOrgEmail {
  return async (tx, email) => {
    const template = findTemplate(email.template);
    if (template === undefined) {
      tx.poison("email_template");
      throw new OrgEmailError(email.template, "template");
    }
    const parsed = template.params.safeParse(email.params);
    if (!parsed.success) {
      tx.poison("email_params");
      deps.lines.write("email.security_unsent", "error", {
        template: email.template,
        reason: "params_refused",
      });
      throw new OrgEmailError(email.template, String(parsed.error.issues[0]?.path[0] ?? ""));
    }
    const id = newId("eml", deps.clock);
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

type DisplayKind = "orgName" | "personName" | "roleLabel";

/**
 * A typed value as a template's labelled box may carry it, or `undefined` when the template's
 * display rule refuses it (a run that reads as a token, say). A name that passed the name rules can
 * still read as a secret shape to the email's stricter check; the notice then goes without that box
 * rather than not at all, so a security notice is never lost to a name ([SA-41]).
 */
export function displayValue(
  kind: DisplayKind,
  value: string | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  // A name field hides, rather than refuses, a value its rule does not accept (HIDDEN_VALUE).
  const parsed = param[kind].safeParse(value.trim());
  return parsed.success && parsed.data !== HIDDEN_VALUE ? parsed.data : undefined;
}

/** The organisation's name for a notice; a neutral label when the email's rule refuses the name. */
export function orgNameForEmail(name: string): string {
  return displayValue("orgName", name) ?? "Your team on Fin";
}

/** A role's label for a notice; a neutral label when the email's rule refuses it. */
export function roleLabelForEmail(label: string): string {
  return displayValue("roleLabel", label) ?? "A custom role";
}
