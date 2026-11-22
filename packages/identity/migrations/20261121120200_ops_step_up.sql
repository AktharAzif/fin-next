-- Step-up intents (spec 02 §7.2, §13.4, [SA-08]). An intent binds one action and the digest of
-- its parameters to one session for 5 minutes; a ceremony proves it; the matching action
-- consumes it once, in its own transaction. No foreign key: the two realms share the table.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TABLE ops.step_up_intent (
  id text PRIMARY KEY CHECK (id ~ '^sti_[0-9a-hjkmnp-tv-z]{26}$'),
  realm text NOT NULL CHECK (realm IN ('developer', 'staff')),
  session_id text NOT NULL CHECK (session_id ~ '^(ses|sts)_[0-9a-hjkmnp-tv-z]{26}$'),
  principal_id text NOT NULL CHECK (principal_id ~ '^(usr|stf)_[0-9a-hjkmnp-tv-z]{26}$'),
  organization_id text NULL CHECK (organization_id ~ '^org_[0-9a-hjkmnp-tv-z]{26}$'),
  action text NOT NULL CHECK (action ~ '^[a-z][a-zA-Z]*\.[a-z][a-z_]*$'),
  params_digest bytea NOT NULL CHECK (length(params_digest) = 32),
  reason_key text NOT NULL CHECK (reason_key ~ '^[a-z][a-z0-9_.]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  proved_at timestamptz NULL,
  proof_method text NULL CHECK (proof_method IN ('passkey', 'totp', 'backup_code')),
  proof_id text NULL CHECK (proof_id ~ '^asr_[0-9a-hjkmnp-tv-z]{26}$'),
  consumed_at timestamptz NULL,
  consumed_request_id text NULL CHECK (char_length(consumed_request_id) <= 64),
  CHECK (expires_at > created_at),
  CHECK ((proved_at IS NULL) = (proof_method IS NULL)),
  CHECK (consumed_at IS NULL OR proved_at IS NOT NULL)
);
CREATE INDEX step_up_intent_open ON ops.step_up_intent (session_id) WHERE consumed_at IS NULL;
CREATE INDEX step_up_intent_created ON ops.step_up_intent (created_at);
