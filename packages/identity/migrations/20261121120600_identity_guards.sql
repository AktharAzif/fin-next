-- The audit guards on the sign-in tables of both realms (spec 02 §13.8, [AU-02], S2-04).
-- Generated from src/guards.ts (guardSql); guards.db.test.ts checks the two agree and proves
-- each registration refuses a commit without its event. 'guard.never_allowed' is an event no
-- login can record, so a registration naming only it refuses every such change.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

SELECT audit.install_guard('identity.user'::regclass, ARRAY['INSERT'], 'id', ARRAY['user.created']);
SELECT audit.install_guard('identity.user'::regclass, ARRAY['UPDATE OF two_factor_enabled'], 'id', ARRAY['two_factor.enabled', 'two_factor.disabled', 'account.recovery_finished']);
SELECT audit.install_guard('identity.user'::regclass, ARRAY['UPDATE OF email, email_verified'], 'id', ARRAY['guard.never_allowed']);
SELECT audit.install_guard('identity.session'::regclass, ARRAY['INSERT'], 'id', ARRAY['session.created', 'sign_in.second_factor_required', 'step_up.passed', 'step_up.failed', 'two_factor.enabled', 'two_factor.disabled']);
SELECT audit.install_guard('identity.session'::regclass, ARRAY['UPDATE OF assurance'], 'id', ARRAY['session.created', 'step_up.passed', 'passkey.added', 'two_factor.enabled']);
SELECT audit.install_guard('identity.session'::regclass, ARRAY['UPDATE OF user_id, absolute_expires_at, mailbox_proved_at, created_via'], 'id', ARRAY['guard.never_allowed']);
SELECT audit.install_guard('identity.account'::regclass, ARRAY['INSERT', 'DELETE', 'UPDATE OF password, provider_id, account_id'], 'user_id', ARRAY['user.created', 'password.set', 'password.changed', 'password.reset', 'account.linked', 'account.unlinked']);
SELECT audit.install_guard('identity.account'::regclass, ARRAY['UPDATE OF user_id'], 'id', ARRAY['guard.never_allowed']);
SELECT audit.install_guard('identity.passkey'::regclass, ARRAY['INSERT', 'DELETE'], 'user_id', ARRAY['passkey.added', 'passkey.removed', 'account.recovery_finished']);
SELECT audit.install_guard('identity.passkey'::regclass, ARRAY['UPDATE OF public_key, credential_id, user_id'], 'id', ARRAY['guard.never_allowed']);
SELECT audit.install_guard('identity.two_factor'::regclass, ARRAY['INSERT', 'DELETE', 'UPDATE OF secret, backup_codes'], 'user_id', ARRAY['two_factor.setup_started', 'two_factor.enabled', 'two_factor.disabled', 'backup_codes.regenerated', 'backup_code.used', 'account.recovery_finished']);
SELECT audit.install_guard('identity.two_factor'::regclass, ARRAY['UPDATE OF verified'], 'user_id', ARRAY['two_factor.enabled', 'account.recovery_finished']);
SELECT audit.install_guard('identity.two_factor'::regclass, ARRAY['UPDATE OF user_id'], 'id', ARRAY['guard.never_allowed']);
SELECT audit.install_guard('identity.trusted_browser'::regclass, ARRAY['INSERT'], 'id', ARRAY['browser.trusted']);
SELECT audit.install_guard('identity.trusted_browser'::regclass, ARRAY['UPDATE OF revoked_at'], 'id', ARRAY['browser.trust_revoked']);
SELECT audit.install_guard('identity.trusted_browser'::regclass, ARRAY['UPDATE OF expires_at, token_hash, user_id'], 'id', ARRAY['guard.never_allowed']);
SELECT audit.install_guard('identity.assurance'::regclass, ARRAY['INSERT'], 'session_id', ARRAY['step_up.passed', 'session.created', 'passkey.added', 'two_factor.enabled']);
SELECT audit.install_guard('ops.step_up_intent'::regclass, ARRAY['UPDATE OF proved_at, consumed_at'], 'id', ARRAY['*']);
SELECT audit.install_guard('staff.member'::regclass, ARRAY['INSERT', 'UPDATE OF role_key, status, factor_enrolled_at, removed_at'], 'id', ARRAY['staff.member_added', 'staff.role_changed', 'staff.member_removed', 'staff.factors_reset', 'staff.factor_enrolled', 'staff.bootstrapped']);
SELECT audit.install_guard('staff.member'::regclass, ARRAY['UPDATE OF email, email_verified'], 'id', ARRAY['guard.never_allowed']);
SELECT audit.install_guard('staff.member'::regclass, ARRAY['UPDATE OF two_factor_enabled'], 'id', ARRAY['staff.factor_added', 'staff.factor_enrolled', 'staff.factor_removed', 'staff.factors_reset', 'staff.member_removed']);
SELECT audit.install_guard('staff.session'::regclass, ARRAY['INSERT'], 'id', ARRAY['staff.signed_in', 'staff.second_factor_required', 'staff.step_up_passed', 'staff.step_up_failed', 'staff.sign_in_failed', 'staff.factor_added', 'staff.factor_enrolled', 'staff.factor_removed']);
SELECT audit.install_guard('staff.session'::regclass, ARRAY['UPDATE OF assurance, enrolment_open_until'], 'id', ARRAY['staff.signed_in', 'staff.step_up_passed', 'staff.factor_enrolled', 'staff.enrolment_code_redeemed']);
SELECT audit.install_guard('staff.session'::regclass, ARRAY['UPDATE OF user_id, absolute_expires_at, access_sub, created_via'], 'id', ARRAY['guard.never_allowed']);
SELECT audit.install_guard('staff.passkey'::regclass, ARRAY['INSERT', 'DELETE'], 'user_id', ARRAY['staff.factor_added', 'staff.factor_enrolled', 'staff.factor_removed', 'staff.factors_reset', 'staff.member_removed']);
SELECT audit.install_guard('staff.passkey'::regclass, ARRAY['UPDATE OF public_key, credential_id, user_id'], 'id', ARRAY['guard.never_allowed']);
SELECT audit.install_guard('staff.two_factor'::regclass, ARRAY['INSERT', 'DELETE', 'UPDATE OF secret, verified'], 'user_id', ARRAY['staff.factor_setup_started', 'staff.factor_added', 'staff.factor_enrolled', 'staff.factor_removed', 'staff.factors_reset', 'staff.member_removed']);
SELECT audit.install_guard('staff.two_factor'::regclass, ARRAY['UPDATE OF user_id'], 'id', ARRAY['guard.never_allowed']);
SELECT audit.install_guard('staff.account'::regclass, ARRAY['INSERT', 'DELETE', 'UPDATE'], 'id', ARRAY['guard.never_allowed']);
SELECT audit.install_guard('staff.assurance'::regclass, ARRAY['INSERT'], 'session_id', ARRAY['staff.step_up_passed', 'staff.signed_in', 'staff.factor_enrolled', 'staff.factor_added']);
SELECT audit.install_guard('staff.enrolment_code'::regclass, ARRAY['INSERT', 'UPDATE OF redeemed_at'], 'id', ARRAY['staff.enrolment_code_issued', 'staff.enrolment_code_redeemed']);
