-- Organisations, members, invitations and custom roles (spec 02 §13.2, [SA-10]): Fin's own tables in
-- schema `identity`, owned by the console service. Expand only (ARCHITECTURE §6.4). An organisation is
-- never deleted: deleting one sets `deleted_at` and removes its memberships, custom roles and pending
-- invitations in one audited transaction (S2-19). Every address is stored lower-cased.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE identity.organization (
  id text PRIMARY KEY CHECK (id ~ '^org_[0-9a-hjkmnp-tv-z]{26}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 50),
  -- Sunday's go-live (spec 03) defines the values and writes them through `api` (IF-09); Saturday
  -- writes only the default.
  live_status text NOT NULL DEFAULT 'sandbox' CHECK (live_status ~ '^[a-z][a-z_]{0,31}$'),
  created_by text NOT NULL REFERENCES identity."user" (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL
);

CREATE TABLE identity.member (
  id text PRIMARY KEY CHECK (id ~ '^mem_[0-9a-hjkmnp-tv-z]{26}$'),
  organization_id text NOT NULL REFERENCES identity.organization (id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES identity."user" (id) ON DELETE RESTRICT,
  -- A built-in key or a custom role's ID; a key Fin does not know allows nothing ("No access").
  role_key text NOT NULL CHECK (role_key ~ '^([a-z][a-z_]{0,31}|rol_[0-9a-hjkmnp-tv-z]{26})$'),
  invited_by text NULL REFERENCES identity."user" (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_once_per_organization UNIQUE (organization_id, user_id)
);
CREATE INDEX member_user_id ON identity.member (user_id);

CREATE TABLE identity.invitation (
  id text PRIMARY KEY CHECK (id ~ '^inv_[0-9a-hjkmnp-tv-z]{26}$'),
  organization_id text NOT NULL REFERENCES identity.organization (id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  role_key text NOT NULL CHECK (role_key ~ '^([a-z][a-z_]{0,31}|rol_[0-9a-hjkmnp-tv-z]{26})$'),
  -- SHA-256 of the 32-byte token; the token itself is never stored.
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  invited_by text NOT NULL REFERENCES identity."user" (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  answered_at timestamptz NULL,
  answered_by text NULL REFERENCES identity."user" (id) ON DELETE RESTRICT,
  cancel_reason text NULL CHECK (cancel_reason IN ('cancelled', 'replaced', 'inviter_removed',
    'inviter_demoted', 'role_deleted', 'organisation_deleted')),
  CONSTRAINT invitation_expiry CHECK (expires_at > created_at),
  CONSTRAINT invitation_cancel_reason CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL))
);
CREATE UNIQUE INDEX invitation_pending_once ON identity.invitation (organization_id, email)
  WHERE status = 'pending';
CREATE INDEX invitation_pending_email ON identity.invitation (email) WHERE status = 'pending';

CREATE TABLE identity.role (
  id text PRIMARY KEY CHECK (id ~ '^rol_[0-9a-hjkmnp-tv-z]{26}$'),
  organization_id text NOT NULL REFERENCES identity.organization (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 120),
  created_by text NOT NULL REFERENCES identity."user" (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1)
);
CREATE UNIQUE INDEX role_name_once ON identity.role (organization_id, lower(name));

CREATE TABLE identity.role_permission (
  role_id text NOT NULL REFERENCES identity.role (id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission ~ '^[a-z][a-zA-Z]*\.[a-z][a-z_]*$'),
  PRIMARY KEY (role_id, permission)
);

-- The session's current organisation (navigation only, never a permission, S2-10).
ALTER TABLE identity.session
  ADD CONSTRAINT session_current_organization
  FOREIGN KEY (current_organization_id) REFERENCES identity.organization (id) ON DELETE SET NULL;
