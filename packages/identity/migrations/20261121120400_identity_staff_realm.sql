-- The staff realm's sign-in tables (spec 02 §13.3): the library's tables with the user model
-- named `member` (S2-23), Fin's session fields, proofs, the TOTP step and enrolment codes
-- ([SA-29]). L-SAT-04 adds staff roles, the change lock, the bootstrap and the views in its own
-- `_staff_*` migrations; this file holds only what the staff realm's sign-in needs to run.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TABLE staff.member (
  id text PRIMARY KEY CHECK (id ~ '^stf_[0-9a-hjkmnp-tv-z]{26}$'),
  name text NOT NULL DEFAULT '' CHECK (char_length(name) <= 60),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  email_verified boolean NOT NULL DEFAULT true CHECK (email_verified),
  image text NULL CHECK (image IS NULL),
  two_factor_enabled boolean NOT NULL DEFAULT false,
  role_key text NOT NULL
    CHECK (role_key IN ('viewer', 'compliance', 'operator', 'admin') OR role_key ~ '^srl_[0-9a-hjkmnp-tv-z]{26}$'),
  status text NOT NULL CHECK (status IN ('pending', 'active', 'removed')),
  factor_enrolled_at timestamptz NULL,
  added_by text NOT NULL CHECK (added_by = 'operator' OR added_by ~ '^stf_[0-9a-hjkmnp-tv-z]{26}$'),
  last_signed_in_at timestamptz NULL,
  removed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'removed') = (removed_at IS NOT NULL)),
  CHECK (status <> 'active' OR factor_enrolled_at IS NOT NULL)
);

CREATE TABLE staff.session (
  id text PRIMARY KEY CHECK (id ~ '^sts_[0-9a-hjkmnp-tv-z]{26}$'),
  user_id text NOT NULL REFERENCES staff.member (id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip_address text NULL CHECK (char_length(ip_address) <= 64),
  user_agent text NULL CHECK (char_length(user_agent) <= 400),
  assurance text NOT NULL CHECK (assurance IN ('aal1', 'aal2')),
  absolute_expires_at timestamptz NOT NULL,
  created_via text NOT NULL
    CHECK (created_via IN ('email_otp', 'passkey', 'two_factor', 'google', 'replacement')),
  -- The Access identity (its `sub`) the session was made under (§10.5).
  access_sub text NOT NULL CHECK (char_length(access_sub) BETWEEN 1 AND 128),
  enrolment_open_until timestamptz NULL,
  step_up_failures smallint NOT NULL DEFAULT 0 CHECK (step_up_failures >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_session_within_absolute CHECK (expires_at <= absolute_expires_at)
);
CREATE INDEX staff_session_user_id ON staff.session (user_id);
CREATE INDEX staff_session_expires_at ON staff.session (expires_at);

-- Google rows only, once enabled for staff (H-02); empty until then.
CREATE TABLE staff.account (
  id text PRIMARY KEY CHECK (id ~ '^acc_[0-9a-hjkmnp-tv-z]{26}$'),
  user_id text NOT NULL REFERENCES staff.member (id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL CHECK (provider_id = 'google'),
  access_token text NULL,
  refresh_token text NULL,
  id_token text NULL,
  access_token_expires_at timestamptz NULL,
  refresh_token_expires_at timestamptz NULL,
  scope text NULL,
  password text NULL CHECK (password IS NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, account_id)
);

CREATE TABLE staff.verification (
  id text PRIMARY KEY CHECK (id ~ '^ver_[0-9a-hjkmnp-tv-z]{26}$'),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_verification_identifier ON staff.verification (identifier);

CREATE TABLE staff.passkey (
  id text PRIMARY KEY CHECK (id ~ '^pky_[0-9a-hjkmnp-tv-z]{26}$'),
  name text NULL CHECK (char_length(name) <= 60),
  public_key text NOT NULL,
  user_id text NOT NULL REFERENCES staff.member (id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  counter integer NOT NULL DEFAULT 0 CHECK (counter >= 0),
  device_type text NOT NULL,
  backed_up boolean NOT NULL,
  transports text NULL,
  aaguid text NULL,
  created_at timestamptz NULL DEFAULT now()
);
CREATE INDEX staff_passkey_user_id ON staff.passkey (user_id);

CREATE TABLE staff.two_factor (
  id text PRIMARY KEY CHECK (id ~ '^tfa_[0-9a-hjkmnp-tv-z]{26}$'),
  secret text NOT NULL,
  -- Always an encrypted empty list: staff have no backup codes (S2-03).
  backup_codes text NOT NULL,
  user_id text NOT NULL UNIQUE REFERENCES staff.member (id) ON DELETE CASCADE,
  verified boolean NOT NULL DEFAULT false,
  failed_verification_count integer NOT NULL DEFAULT 0 CHECK (failed_verification_count >= 0),
  locked_until timestamptz NULL
);

CREATE TABLE staff.assurance (
  id text PRIMARY KEY CHECK (id ~ '^asr_[0-9a-hjkmnp-tv-z]{26}$'),
  user_id text NOT NULL REFERENCES staff.member (id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES staff.session (id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('passkey', 'totp')),
  intent_id text NULL CHECK (intent_id ~ '^sti_[0-9a-hjkmnp-tv-z]{26}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_assurance_session ON staff.assurance (session_id, created_at DESC);

CREATE TABLE staff.totp_step (
  user_id text PRIMARY KEY REFERENCES staff.member (id) ON DELETE CASCADE,
  last_step bigint NOT NULL CHECK (last_step >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enrolment codes ([SA-29], §6.5): 80 bits, shown once, stored as SHA-256, alive 30 minutes,
-- single use, bound to one member; one live code per member.
CREATE TABLE staff.enrolment_code (
  id text PRIMARY KEY CHECK (id ~ '^enc_[0-9a-hjkmnp-tv-z]{26}$'),
  member_id text NOT NULL REFERENCES staff.member (id) ON DELETE CASCADE,
  code_hash bytea NOT NULL UNIQUE CHECK (length(code_hash) = 32),
  reason text NOT NULL CHECK (reason IN ('added', 'reset', 'reissued', 'bootstrap')),
  issued_by text NOT NULL CHECK (issued_by = 'operator' OR issued_by ~ '^stf_[0-9a-hjkmnp-tv-z]{26}$'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz NULL,
  redeemed_session_id text NULL CHECK (redeemed_session_id ~ '^sts_[0-9a-hjkmnp-tv-z]{26}$'),
  voided_at timestamptz NULL,
  failed_tries smallint NOT NULL DEFAULT 0 CHECK (failed_tries >= 0),
  CHECK (expires_at > issued_at),
  CHECK ((redeemed_at IS NULL) = (redeemed_session_id IS NULL))
);
CREATE UNIQUE INDEX enrolment_code_live ON staff.enrolment_code (member_id)
  WHERE redeemed_at IS NULL AND voided_at IS NULL;
