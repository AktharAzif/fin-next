-- The staff area's own tables (spec 02 §13.3, §13.6, §10.7, §10.8), on top of @fin/identity's
-- `_identity_staff_realm` (the staff realm's sign-in tables, with staff.member as the library's
-- user model): custom staff roles and their permissions (the routes that write them are stretch 3;
-- the tables exist from Saturday's first migration, §10.7), the one staff-change lock row, the
-- Access drift check's view and the role-permission view `api` reads. Expand only.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE staff.role (
  id text PRIMARY KEY CHECK (id ~ '^srl_[0-9a-hjkmnp-tv-z]{26}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 120),
  created_by text NOT NULL CHECK (created_by ~ '^stf_[0-9a-hjkmnp-tv-z]{26}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1)
);
-- Names are unique case-insensitively (§8.4).
CREATE UNIQUE INDEX staff_role_name ON staff.role (lower(name));

CREATE TABLE staff.role_permission (
  role_id text NOT NULL REFERENCES staff.role (id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission ~ '^[a-z][a-zA-Z]*\.[a-z][a-z_]*$'),
  PRIMARY KEY (role_id, permission)
);

-- The staff-change lock (§10.8): every staff change starts with
-- `SELECT 1 FROM staff.change_lock WHERE id = 1 FOR UPDATE`, so the last active Admin cannot be
-- removed, demoted or reset by two concurrent changes. One row, never more.
CREATE TABLE staff.change_lock (
  id smallint PRIMARY KEY CHECK (id = 1)
);
INSERT INTO staff.change_lock (id) VALUES (1);

-- The addresses the Access application's Allow list must hold (§10.9): the active and pending
-- members, lower-cased by the table's own check. For the worker's drift check only.
CREATE VIEW staff.access_list_view AS
  SELECT email FROM staff.member WHERE status IN ('active', 'pending');

-- What `api` re-checks a Fin Admin door call against (§13.6, [SA-36]).
CREATE VIEW staff.role_permission_view AS
  SELECT role_id, permission FROM staff.role_permission;

-- The audit guards on staff roles (§13.8, [AU-02]); src/guards.ts holds the same registrations and
-- guards.db.test.ts proves each refuses a commit without its event. A permission row deleted by a
-- role's cascade is covered by that delete's own event, which names the role.
SELECT audit.install_guard('staff.role'::regclass, ARRAY['INSERT', 'UPDATE', 'DELETE'], 'id', ARRAY['staff.role_created', 'staff.role_updated', 'staff.role_deleted']);
SELECT audit.install_guard('staff.role_permission'::regclass, ARRAY['INSERT', 'DELETE'], 'role_id', ARRAY['staff.role_created', 'staff.role_updated', 'staff.role_deleted']);
