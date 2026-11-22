-- The audit guards on the organisation tables (spec 02 §13.8, [AU-02]). Generated from
-- src/guards.ts (guardSql); guards.test.ts checks this file says exactly that, and
-- guards.db.test.ts compares the installed triggers and proves each registration refuses a commit
-- without its event. 'guard.never_allowed' is an event no login can record, so a registration naming
-- only it refuses every such change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

SELECT audit.install_guard('identity.organization'::regclass, ARRAY['INSERT', 'UPDATE OF name, deleted_at'], 'id', ARRAY['organization.created', 'organization.updated', 'organization.deleted']);
SELECT audit.install_guard('identity.organization'::regclass, ARRAY['UPDATE OF created_by'], 'id', ARRAY['guard.never_allowed']);
SELECT audit.install_guard('identity.member'::regclass, ARRAY['INSERT', 'UPDATE OF role_key'], 'id', ARRAY['member.joined', 'member.role_changed', 'organization.created']);
SELECT audit.install_guard('identity.member'::regclass, ARRAY['DELETE'], 'organization_id', ARRAY['member.removed', 'organization.deleted']);
SELECT audit.install_guard('identity.member'::regclass, ARRAY['UPDATE OF organization_id, user_id'], 'id', ARRAY['guard.never_allowed']);
SELECT audit.install_guard('identity.invitation'::regclass, ARRAY['INSERT', 'UPDATE OF role_key, status, token_hash, invited_by'], 'id', ARRAY['member.invited', 'member.invitation_changed', 'member.invitation_resent', 'member.invitation_cancelled', 'member.invitation_declined', 'member.joined']);
SELECT audit.install_guard('identity.invitation'::regclass, ARRAY['UPDATE OF organization_id, email'], 'id', ARRAY['guard.never_allowed']);
SELECT audit.install_guard('identity.role'::regclass, ARRAY['INSERT', 'UPDATE', 'DELETE'], 'id', ARRAY['role.created', 'role.updated', 'role.deleted', 'organization.deleted']);
SELECT audit.install_guard('identity.role_permission'::regclass, ARRAY['INSERT', 'DELETE'], 'role_id', ARRAY['role.created', 'role.updated', 'role.deleted', 'organization.deleted']);
