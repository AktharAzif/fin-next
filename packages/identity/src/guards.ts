// The audit-guard registrations of the sign-in tables (spec 02 §13.8, [AU-02], S2-04): a commit
// that changes a guarded row without an audit row in the same transaction naming the row's key
// is refused (FA010). The migration `_identity_guards` installs exactly these through
// `audit.install_guard`; guards.db.test.ts compares them with pg_trigger and proves each one.
//
// Spec 02 §20.1 places the registrations in packages/db/src/guards/identity.ts; this lane owns
// packages/identity/** only, so they live here until packages/db lands.
//
// Additions to §13.8's table, recorded in the pull request: a session INSERT also accepts
// `two_factor.enabled` and `two_factor.disabled` (the plugin replaces the session when an
// authenticator is finished or turned off), the staff equivalents accept the factor events for
// the same reason, and `UPDATE OF verified` on the two-factor tables is guarded (it is what makes
// an authenticator count as a factor).

export interface GuardRegistration {
  readonly table: string;
  readonly ops: readonly string[];
  readonly keyColumn: string;
  readonly events: readonly string[];
}

/** An event no login can record: a registration that names only it refuses every change. */
export const NEVER = "guard.never_allowed";

export const IDENTITY_GUARDS: readonly GuardRegistration[] = [
  { table: "identity.user", ops: ["INSERT"], keyColumn: "id", events: ["user.created"] },
  {
    table: "identity.user",
    ops: ["UPDATE OF two_factor_enabled"],
    keyColumn: "id",
    events: ["two_factor.enabled", "two_factor.disabled", "account.recovery_finished"],
  },
  {
    table: "identity.user",
    ops: ["UPDATE OF email, email_verified"],
    keyColumn: "id",
    events: [NEVER],
  },
  {
    table: "identity.session",
    ops: ["INSERT"],
    keyColumn: "id",
    events: [
      "session.created",
      "sign_in.second_factor_required",
      "step_up.passed",
      "step_up.failed",
      "two_factor.enabled",
      "two_factor.disabled",
    ],
  },
  {
    table: "identity.session",
    ops: ["UPDATE OF assurance"],
    keyColumn: "id",
    events: ["session.created", "step_up.passed", "passkey.added", "two_factor.enabled"],
  },
  {
    table: "identity.session",
    ops: ["UPDATE OF user_id, absolute_expires_at, mailbox_proved_at, created_via"],
    keyColumn: "id",
    events: [NEVER],
  },
  {
    table: "identity.account",
    ops: ["INSERT", "DELETE", "UPDATE OF password, provider_id, account_id"],
    keyColumn: "user_id",
    events: [
      "user.created",
      "password.set",
      "password.changed",
      "password.reset",
      "account.linked",
      "account.unlinked",
    ],
  },
  { table: "identity.account", ops: ["UPDATE OF user_id"], keyColumn: "id", events: [NEVER] },
  {
    table: "identity.passkey",
    ops: ["INSERT", "DELETE"],
    keyColumn: "user_id",
    events: ["passkey.added", "passkey.removed", "account.recovery_finished"],
  },
  {
    table: "identity.passkey",
    ops: ["UPDATE OF public_key, credential_id, user_id"],
    keyColumn: "id",
    events: [NEVER],
  },
  {
    table: "identity.two_factor",
    ops: ["INSERT", "DELETE", "UPDATE OF secret, backup_codes"],
    keyColumn: "user_id",
    events: [
      "two_factor.setup_started",
      "two_factor.enabled",
      "two_factor.disabled",
      "backup_codes.regenerated",
      "backup_code.used",
      "account.recovery_finished",
    ],
  },
  {
    table: "identity.two_factor",
    ops: ["UPDATE OF verified"],
    keyColumn: "user_id",
    events: ["two_factor.enabled", "account.recovery_finished"],
  },
  { table: "identity.two_factor", ops: ["UPDATE OF user_id"], keyColumn: "id", events: [NEVER] },
  {
    table: "identity.trusted_browser",
    ops: ["INSERT"],
    keyColumn: "id",
    events: ["browser.trusted"],
  },
  {
    table: "identity.trusted_browser",
    ops: ["UPDATE OF revoked_at"],
    keyColumn: "id",
    events: ["browser.trust_revoked"],
  },
  {
    table: "identity.trusted_browser",
    ops: ["UPDATE OF expires_at, token_hash, user_id"],
    keyColumn: "id",
    events: [NEVER],
  },
  {
    table: "identity.assurance",
    ops: ["INSERT"],
    keyColumn: "session_id",
    events: ["step_up.passed", "session.created", "passkey.added", "two_factor.enabled"],
  },
  {
    table: "ops.step_up_intent",
    ops: ["UPDATE OF proved_at, consumed_at"],
    keyColumn: "id",
    events: ["*"],
  },
];

export const STAFF_REALM_GUARDS: readonly GuardRegistration[] = [
  {
    table: "staff.member",
    ops: ["INSERT", "UPDATE OF role_key, status, factor_enrolled_at, removed_at"],
    keyColumn: "id",
    events: [
      "staff.member_added",
      "staff.role_changed",
      "staff.member_removed",
      "staff.factors_reset",
      "staff.factor_enrolled",
      "staff.bootstrapped",
    ],
  },
  {
    table: "staff.member",
    ops: ["UPDATE OF email, email_verified"],
    keyColumn: "id",
    events: [NEVER],
  },
  {
    table: "staff.member",
    ops: ["UPDATE OF two_factor_enabled"],
    keyColumn: "id",
    events: [
      "staff.factor_added",
      "staff.factor_enrolled",
      "staff.factor_removed",
      "staff.factors_reset",
      "staff.member_removed",
    ],
  },
  {
    table: "staff.session",
    ops: ["INSERT"],
    keyColumn: "id",
    events: [
      "staff.signed_in",
      "staff.second_factor_required",
      "staff.step_up_passed",
      "staff.step_up_failed",
      "staff.sign_in_failed",
      "staff.factor_added",
      "staff.factor_enrolled",
      "staff.factor_removed",
    ],
  },
  {
    table: "staff.session",
    ops: ["UPDATE OF assurance, enrolment_open_until"],
    keyColumn: "id",
    events: [
      "staff.signed_in",
      "staff.step_up_passed",
      "staff.factor_enrolled",
      "staff.enrolment_code_redeemed",
    ],
  },
  {
    table: "staff.session",
    ops: ["UPDATE OF user_id, absolute_expires_at, access_sub, created_via"],
    keyColumn: "id",
    events: [NEVER],
  },
  {
    table: "staff.passkey",
    ops: ["INSERT", "DELETE"],
    keyColumn: "user_id",
    events: [
      "staff.factor_added",
      "staff.factor_enrolled",
      "staff.factor_removed",
      "staff.factors_reset",
      "staff.member_removed",
    ],
  },
  {
    table: "staff.passkey",
    ops: ["UPDATE OF public_key, credential_id, user_id"],
    keyColumn: "id",
    events: [NEVER],
  },
  {
    table: "staff.two_factor",
    ops: ["INSERT", "DELETE", "UPDATE OF secret, verified"],
    keyColumn: "user_id",
    events: [
      "staff.factor_setup_started",
      "staff.factor_added",
      "staff.factor_enrolled",
      "staff.factor_removed",
      "staff.factors_reset",
      "staff.member_removed",
    ],
  },
  { table: "staff.two_factor", ops: ["UPDATE OF user_id"], keyColumn: "id", events: [NEVER] },
  { table: "staff.account", ops: ["INSERT", "DELETE", "UPDATE"], keyColumn: "id", events: [NEVER] },
  {
    table: "staff.assurance",
    ops: ["INSERT"],
    keyColumn: "session_id",
    events: [
      "staff.step_up_passed",
      "staff.signed_in",
      "staff.factor_enrolled",
      "staff.factor_added",
    ],
  },
  {
    table: "staff.enrolment_code",
    ops: ["INSERT", "UPDATE OF redeemed_at"],
    keyColumn: "id",
    events: ["staff.enrolment_code_issued", "staff.enrolment_code_redeemed"],
  },
];

export const REALM_GUARDS: readonly GuardRegistration[] = [
  ...IDENTITY_GUARDS,
  ...STAFF_REALM_GUARDS,
];

/** The SQL that installs the registrations (the migration's body, and its test). */
export function guardSql(guards: readonly GuardRegistration[]): string {
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return guards
    .map(
      (g) =>
        `SELECT audit.install_guard(${quote(g.table)}::regclass, ARRAY[${g.ops.map(quote).join(", ")}], ${quote(g.keyColumn)}, ARRAY[${g.events.map(quote).join(", ")}]);`,
    )
    .join("\n");
}
