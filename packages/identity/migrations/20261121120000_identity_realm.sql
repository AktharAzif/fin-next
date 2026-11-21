-- The developer realm's library tables (spec 02 §13.2). Expand only. The columns are the ones
-- Better Auth 1.7.25 and its two-factor and passkey plugins need, with Fin's session fields;
-- SP-10's pin test compares them with the installed library (T-SAT-02).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE identity."user" (
  id text PRIMARY KEY CHECK (id ~ '^usr_[0-9a-hjkmnp-tv-z]{26}$'),
  name text NOT NULL DEFAULT '' CHECK (char_length(name) <= 60),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  -- Always true: no user row exists before the mailbox is proved (§5.1, S2-05).
  email_verified boolean NOT NULL CHECK (email_verified),
  image text NULL CHECK (image IS NULL),
  two_factor_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.session (
  id text PRIMARY KEY CHECK (id ~ '^ses_[0-9a-hjkmnp-tv-z]{26}$'),
  user_id text NOT NULL REFERENCES identity."user" (id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip_address text NULL CHECK (char_length(ip_address) <= 64),
  user_agent text NULL CHECK (char_length(user_agent) <= 400),
  assurance text NOT NULL CHECK (assurance IN ('aal1', 'aal2')),
  absolute_expires_at timestamptz NOT NULL,
  created_via text NOT NULL
    CHECK (created_via IN ('email_otp', 'passkey', 'two_factor', 'password', 'google', 'replacement')),
  mailbox_proved_at timestamptz NULL,
  -- The foreign key to identity.trusted_browser is added with that table (_identity_fin).
  trusted_browser_id text NULL,
  step_up_failures smallint NOT NULL DEFAULT 0 CHECK (step_up_failures >= 0),
  -- The foreign key to identity.organization arrives after L-SAT-03's _orgs_tables.
  current_organization_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- No refresh can pass the absolute limit, whoever writes the row (§13.2).
  CONSTRAINT session_within_absolute CHECK (expires_at <= absolute_expires_at)
);
CREATE INDEX session_user_id ON identity.session (user_id);
CREATE INDEX session_expires_at ON identity.session (expires_at);

CREATE TABLE identity.account (
  id text PRIMARY KEY CHECK (id ~ '^acc_[0-9a-hjkmnp-tv-z]{26}$'),
  user_id text NOT NULL REFERENCES identity."user" (id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL CHECK (provider_id IN ('credential', 'google')),
  access_token text NULL,
  refresh_token text NULL,
  id_token text NULL,
  access_token_expires_at timestamptz NULL,
  refresh_token_expires_at timestamptz NULL,
  scope text NULL,
  password text NULL CHECK (password IS NULL OR provider_id = 'credential'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, account_id)
);
CREATE INDEX account_user_id ON identity.account (user_id);

CREATE TABLE identity.verification (
  id text PRIMARY KEY CHECK (id ~ '^ver_[0-9a-hjkmnp-tv-z]{26}$'),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier ON identity.verification (identifier);
CREATE INDEX verification_expires_at ON identity.verification (expires_at);

CREATE TABLE identity.passkey (
  id text PRIMARY KEY CHECK (id ~ '^pky_[0-9a-hjkmnp-tv-z]{26}$'),
  name text NULL CHECK (char_length(name) <= 60),
  public_key text NOT NULL,
  user_id text NOT NULL REFERENCES identity."user" (id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  counter integer NOT NULL DEFAULT 0 CHECK (counter >= 0),
  device_type text NOT NULL,
  backed_up boolean NOT NULL,
  transports text NULL,
  aaguid text NULL,
  created_at timestamptz NULL DEFAULT now()
);
CREATE INDEX passkey_user_id ON identity.passkey (user_id);

CREATE TABLE identity.two_factor (
  id text PRIMARY KEY CHECK (id ~ '^tfa_[0-9a-hjkmnp-tv-z]{26}$'),
  secret text NOT NULL,
  backup_codes text NOT NULL,
  user_id text NOT NULL UNIQUE REFERENCES identity."user" (id) ON DELETE CASCADE,
  -- The plugin keeps an unverified row while set-up is unfinished, and its own lockout.
  verified boolean NOT NULL DEFAULT false,
  failed_verification_count integer NOT NULL DEFAULT 0 CHECK (failed_verification_count >= 0),
  locked_until timestamptz NULL
);
