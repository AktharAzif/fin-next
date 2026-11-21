-- Fin's own developer-realm tables (spec 02 §13.2): proofs, the TOTP step, known and trusted
-- browsers, emailed-code and sign-up requests, and the privileged permission set the gate reads.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Proofs: a factor shown in a session (§6.1, §7.3). The window is a proof younger than 5 minutes.
CREATE TABLE identity.assurance (
  id text PRIMARY KEY CHECK (id ~ '^asr_[0-9a-hjkmnp-tv-z]{26}$'),
  user_id text NOT NULL REFERENCES identity."user" (id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES identity.session (id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('passkey', 'totp', 'backup_code')),
  intent_id text NULL CHECK (intent_id ~ '^sti_[0-9a-hjkmnp-tv-z]{26}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assurance_session ON identity.assurance (session_id, created_at DESC);

-- The last accepted TOTP step, across sign-in and step-up ([SA-35], §3.6).
CREATE TABLE identity.totp_step (
  user_id text PRIMARY KEY REFERENCES identity."user" (id) ON DELETE CASCADE,
  last_step bigint NOT NULL CHECK (last_step >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Browsers an account has used (§5.5); they decide only the new-sign-in email and the code
-- supersede rule (§5.2).
CREATE TABLE identity.known_browser (
  id text PRIMARY KEY CHECK (id ~ '^brw_[0-9a-hjkmnp-tv-z]{26}$'),
  user_id text NOT NULL REFERENCES identity."user" (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX known_browser_user ON identity.known_browser (user_id);

-- Trusted browsers ([SA-31], §6.6): a server-side row, never the library's trust cookie.
CREATE TABLE identity.trusted_browser (
  id text PRIMARY KEY CHECK (id ~ '^tbr_[0-9a-hjkmnp-tv-z]{26}$'),
  user_id text NOT NULL REFERENCES identity."user" (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  revoked_reason text NULL CHECK (revoked_reason IN ('factor_changed', 'password_reset',
    'signed_out_everywhere', 'role_elevated', 'production_access', 'by_person', 'removed')),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX trusted_browser_user ON identity.trusted_browser (user_id) WHERE revoked_at IS NULL;

ALTER TABLE identity.session
  ADD CONSTRAINT session_trusted_browser_fkey FOREIGN KEY (trusted_browser_id)
  REFERENCES identity.trusted_browser (id) ON DELETE SET NULL;

-- One live code per address and purpose, bound to the browser that asked (§5.2, [SA-35]).
-- `codeless`: recorded in place of a code, by the sign-up of an address that already has an
-- account (§5.1), so the browser that asked holds a request as it would for an unknown address;
-- no code is right for it, and it never supersedes a known browser's live code.
CREATE TABLE identity.email_code_request (
  id text PRIMARY KEY CHECK (id ~ '^emr_[0-9a-hjkmnp-tv-z]{26}$'),
  email_hash bytea NOT NULL CHECK (length(email_hash) = 32),
  purpose text NOT NULL CHECK (purpose IN ('sign_in', 'sign_up', 'password_reset')),
  browser_hash bytea NOT NULL CHECK (length(browser_hash) = 32),
  browser_known boolean NOT NULL,
  codeless boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  browser_tries smallint NOT NULL DEFAULT 0 CHECK (browser_tries >= 0),
  other_tries smallint NOT NULL DEFAULT 0 CHECK (other_tries >= 0),
  superseded_at timestamptz NULL,
  used_at timestamptz NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX email_code_request_live ON identity.email_code_request (email_hash, purpose, created_at DESC);

-- The per-address lock that serialises an address's code requests, codeless requests and code
-- tries (codes.ts, lockAddress()): each takes a row lock here, held until its unit ends. A row
-- lock needs UPDATE (or DELETE) on the table, which only fin_console holds, and no function another
-- login may run touches it, so no other login can take or hold it (an advisory lock is one any
-- login could take), and nothing here is readable by another role. `email_hash` is the address's
-- keyed hash under the newest key. No sweep deletes a row, since a delete is a lock too: the table
-- keeps one 32-byte row per address that has asked.
CREATE TABLE identity.email_code_lock (
  email_hash bytea PRIMARY KEY CHECK (length(email_hash) = 32),
  locked_at timestamptz NOT NULL
);

-- A sign-up waiting for its mailbox to be proved (§5.1, S2-05): no user row exists before.
CREATE TABLE identity.sign_up_request (
  id text PRIMARY KEY CHECK (id ~ '^sur_[0-9a-hjkmnp-tv-z]{26}$'),
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  password_hash text NULL,
  browser_hash bytea NOT NULL CHECK (length(browser_hash) = 32),
  invitation_id text NULL CHECK (invitation_id ~ '^inv_[0-9a-hjkmnp-tv-z]{26}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX sign_up_request_email ON identity.sign_up_request (email, created_at DESC);

-- The privileged dashboard permissions (§8.2's P set, [SA-05]) for identity.person_gate().
-- A test compares this set with the catalogue's (S2-33).
CREATE TABLE identity.privileged_permission (
  permission text PRIMARY KEY CHECK (permission ~ '^[a-z][a-zA-Z]*\.[a-z][a-z_]*$')
);
INSERT INTO identity.privileged_permission (permission) VALUES
  ('money.beneficiaries'),
  ('money.transfer'),
  ('webhooks.manage'),
  ('webhooks.roll_secret'),
  ('apiKey.live'),
  ('member.invite'),
  ('member.role'),
  ('role.manage'),
  ('organization.update'),
  ('organization.delete'),
  ('golive.submit');
