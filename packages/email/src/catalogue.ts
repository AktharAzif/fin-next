// The template catalogue and `email.enqueue()`'s per-role allowlist (spec 08 §4.4, [DA-14]).
//
// The allowlist is generated from the folders: a role may queue a template only when the template's
// folder (or the template itself) is listed for it below, so no service can queue a look-alike
// sign-in code or "key revoked" notice. `grantRows()` is what `email.template_grant` holds: `migrate`
// loads exactly these rows after every run (grantInsertSql, from apps/api's afterMigrations), and a
// test proves the database refuses the rest (T08-22).
import { CLASS_RULES, type EmailClass, type Template, type TemplateArea } from "./classes.ts";
import { accountLocked } from "./templates/identity/account-locked.ts";
import { accountRecoveryFinished } from "./templates/identity/account-recovery-finished.ts";
import { accountRecoveryStarted } from "./templates/identity/account-recovery-started.ts";
import { alreadyRegistered } from "./templates/identity/already-registered.ts";
import { confirmEmail } from "./templates/identity/confirm-email.ts";
import { newSignIn } from "./templates/identity/new-sign-in.ts";
import { passwordPaused } from "./templates/identity/password-paused.ts";
import { resetPassword } from "./templates/identity/reset-password.ts";
import { sessionEnded } from "./templates/identity/session-ended.ts";
import { signInCode } from "./templates/identity/sign-in-code.ts";
import { signInMethodsChanged } from "./templates/identity/sign-in-methods-changed.ts";
import { deliveryCheck } from "./templates/ops/delivery-check.ts";
import { securityDigest } from "./templates/ops/security-digest.ts";
import { invitation } from "./templates/orgs/invitation.ts";
import { memberJoined } from "./templates/orgs/member-joined.ts";
import { memberRemoved } from "./templates/orgs/member-removed.ts";
import { memberRoleChanged } from "./templates/orgs/member-role-changed.ts";
import { organizationDeleted } from "./templates/orgs/organization-deleted.ts";
import { rolePermissionsChanged } from "./templates/orgs/role-permissions-changed.ts";
import { staffAccessChanged } from "./templates/staff/staff-access-changed.ts";
import { staffFactorEnrolled } from "./templates/staff/staff-factor-enrolled.ts";
import { staffFactorsReset } from "./templates/staff/staff-factors-reset.ts";
import { staffNewSignIn } from "./templates/staff/staff-new-sign-in.ts";
import { staffRolePermissionsChanged } from "./templates/staff/staff-role-permissions-changed.ts";
import { staffSignInCode } from "./templates/staff/staff-sign-in-code.ts";
import { staffSignInMethodsChanged } from "./templates/staff/staff-sign-in-methods-changed.ts";
import { staffSwitchChanged } from "./templates/staff/staff-switch-changed.ts";

/** Every template that exists today. Other areas add theirs with their lanes (spec 08 §4.4). */
export const TEMPLATES: readonly Template[] = Object.freeze([
  signInCode,
  confirmEmail,
  resetPassword,
  alreadyRegistered,
  newSignIn,
  signInMethodsChanged,
  accountLocked,
  sessionEnded,
  passwordPaused,
  accountRecoveryStarted,
  accountRecoveryFinished,
  invitation,
  memberJoined,
  memberRemoved,
  memberRoleChanged,
  rolePermissionsChanged,
  organizationDeleted,
  staffSignInCode,
  staffNewSignIn,
  staffSignInMethodsChanged,
  staffFactorEnrolled,
  staffAccessChanged,
  staffFactorsReset,
  staffRolePermissionsChanged,
  staffSwitchChanged,
  deliveryCheck,
  securityDigest,
] as Template[]);

const BY_ID: ReadonlyMap<string, Template> = new Map(TEMPLATES.map((t) => [t.id, t]));

export function findTemplate(id: string): Template | undefined {
  return BY_ID.get(id);
}

/** The service groups that may call `email.enqueue()` (spec 01 §6.10). */
export const SENDER_ROLES = [
  "fin_console",
  "fin_admin",
  "fin_api",
  "fin_payments",
  "fin_worker",
] as const;
export type SenderRole = (typeof SENDER_ROLES)[number];

interface RoleRule {
  readonly folders: readonly TemplateArea[];
  readonly templates: readonly string[];
}

/** Spec 08 §4.4's allowlist, by folder and by named template. */
export const ROLE_RULES: Readonly<Record<SenderRole, RoleRule>> = Object.freeze({
  fin_console: { folders: ["identity", "orgs", "api-keys"], templates: [] },
  fin_admin: { folders: ["staff"], templates: [] },
  fin_api: {
    folders: ["kyc", "golive", "webhooks"],
    templates: ["api-keys/key-exposed", "staff-kyc/reveal-budget"],
  },
  fin_payments: { folders: ["money"], templates: [] },
  fin_worker: { folders: ["ops"], templates: ["webhooks/endpoint-paused"] },
});

/** The roles that may queue a template. */
export function rolesFor(template: Template): SenderRole[] {
  return SENDER_ROLES.filter((role) => {
    const rule = ROLE_RULES[role];
    return rule.folders.includes(template.area) || rule.templates.includes(template.id);
  });
}

export interface GrantRow {
  readonly template: string;
  readonly role: SenderRole;
  readonly category: EmailClass;
  readonly priority: number;
  readonly carriesSecret: boolean;
}

/** The rows of `email.template_grant`, in a stable order. */
export function grantRows(): GrantRow[] {
  return TEMPLATES.flatMap((t) =>
    rolesFor(t).map((role) => ({
      template: t.id,
      role,
      category: t.class,
      priority: CLASS_RULES[t.class].priority,
      carriesSecret: t.secretBearing,
    })),
  ).sort((a, b) => a.template.localeCompare(b.template) || a.role.localeCompare(b.role));
}

/** The digest's fixed line for a template (spec 08 §4.3). */
export function describe(templateId: string): string | undefined {
  return BY_ID.get(templateId)?.digestLine;
}

/**
 * The SQL that loads `grantRows()`, with each group role mapped (tests prefix them). It upserts, so it
 * loads over rows an earlier migration seeded (P0-E's `ops/delivery-check`) and sets each row's class,
 * priority and secret flag to the catalogue's.
 */
export function grantInsertSql(roleName: (role: SenderRole) => string = (r) => r): string {
  const values = grantRows().map(
    (g) =>
      `  ('${g.template}', '${roleName(g.role)}', '${g.category}', ${g.priority}, ${g.carriesSecret})`,
  );
  return [
    "INSERT INTO email.template_grant (template, role, category, priority, carries_secret) VALUES",
    values.join(",\n"),
    "ON CONFLICT (template, role) DO UPDATE SET category = EXCLUDED.category,",
    "  priority = EXCLUDED.priority, carries_secret = EXCLUDED.carries_secret;",
  ].join("\n");
}
