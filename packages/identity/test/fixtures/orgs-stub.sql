-- A stand-in for L-SAT-03's _orgs_tables (spec 02 §13.2's organisation columns, the subset the
-- gate reads), for this package's integration tests only. L-SAT-03 owns the real tables, their
-- guards and their events; identity.person_gate() binds to them when it runs.
CREATE TABLE identity.organization (
  id text PRIMARY KEY CHECK (id ~ '^org_[0-9a-hjkmnp-tv-z]{26}$'),
  name text NOT NULL,
  live_status text NOT NULL DEFAULT 'sandbox',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL
);

CREATE TABLE identity.member (
  id text PRIMARY KEY CHECK (id ~ '^mem_[0-9a-hjkmnp-tv-z]{26}$'),
  organization_id text NOT NULL REFERENCES identity.organization (id),
  user_id text NOT NULL REFERENCES identity."user" (id) ON DELETE RESTRICT,
  role_key text NOT NULL,
  invited_by text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE identity.role (
  id text PRIMARY KEY CHECK (id ~ '^rol_[0-9a-hjkmnp-tv-z]{26}$'),
  organization_id text NOT NULL REFERENCES identity.organization (id),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE identity.role_permission (
  role_id text NOT NULL REFERENCES identity.role (id) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (role_id, permission)
);
