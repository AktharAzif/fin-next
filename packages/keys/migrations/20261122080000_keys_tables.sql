-- API keys (spec 05 §4.2, §4.6, §4.9; spec 02 §12, §13.5): schema `keys`, owned by the keys area.
-- Only an HMAC-SHA256 of the key's body with a pepper is stored (`hash`, with `pepper_versions` the
-- chain applied over it, oldest first); the secret is shown once and never kept. The console makes,
-- edits, rolls and revokes keys; the edge reads the one view and writes "last used" through one
-- function; the worker re-hashes onto a newer pepper. Expand only (ARCHITECTURE §6.4).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Schema `keys` is the bootstrap's (owned by fin_owner, nothing for PUBLIC, DECISIONS DA-01).

CREATE TABLE keys.api_key (
  -- The 10-character key ID inside the key: upper-case Crockford base32, safe to log and show.
  id              text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{10}$'),
  organization_id text NOT NULL REFERENCES identity.organization (id) ON DELETE RESTRICT,
  mode            text NOT NULL CHECK (mode IN ('test', 'live')),
  kind            text NOT NULL CHECK (kind IN ('sk', 'rk')),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  -- A full-access key opens every route of its mode and stores no scope; a restricted key one or more.
  scopes          text[] NOT NULL DEFAULT '{}' CHECK (
                    scopes <@ ARRAY['customers:read', 'customers:write', 'events:read', 'money:read',
                      'money:write', 'beneficiaries:write', 'sandbox:simulate', 'sandbox:deposit']::text[]
                    AND array_position(scopes, NULL) IS NULL),
  ip_allowlist    cidr[] NOT NULL DEFAULT '{}' CHECK (
                    cardinality(ip_allowlist) <= 20 AND array_position(ip_allowlist, NULL) IS NULL),
  hash            bytea NOT NULL CHECK (octet_length(hash) = 32),
  pepper_versions smallint[] NOT NULL CHECK (
                    cardinality(pepper_versions) BETWEEN 1 AND 8
                    AND array_position(pepper_versions, NULL) IS NULL
                    AND 0 < ALL (pepper_versions)),
  created_by      text NOT NULL CHECK (created_by ~ '^usr_[0-9a-hjkmnp-tv-z]{26}$'),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  expires_at      timestamptz NULL,
  revoked_at      timestamptz NULL,
  revoked_reason  text NULL CHECK (revoked_reason IN ('member', 'maker_removed', 'sent_in_clear',
                    'leaked_public', 'organisation_deleted')),
  replaced_by     text NULL REFERENCES keys.api_key (id) ON DELETE RESTRICT,
  rolling_until   timestamptz NULL,
  last_used_at    timestamptz NULL,
  -- Who was shown the secret ([SA-33]): the maker at create, whoever rolled it at a roll.
  seen_by         text[] NOT NULL DEFAULT '{}' CHECK (
                    cardinality(seen_by) <= 50 AND array_position(seen_by, NULL) IS NULL),
  CONSTRAINT api_key_full_access_has_no_scopes CHECK ((kind = 'sk') = (cardinality(scopes) = 0)),
  CONSTRAINT api_key_sandbox_scopes_on_test CHECK (
    mode = 'test' OR NOT (scopes && ARRAY['sandbox:simulate', 'sandbox:deposit']::text[])),
  CONSTRAINT api_key_revoked_with_reason CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT api_key_rolling_names_replacement CHECK (rolling_until IS NULL OR replaced_by IS NOT NULL),
  CONSTRAINT api_key_not_its_own_replacement CHECK (replaced_by IS DISTINCT FROM id),
  -- [MO-20]: a live key that can move money carries an address allowlist.
  CONSTRAINT api_key_live_money_allowlist CHECK (
    mode = 'test' OR cardinality(ip_allowlist) > 0
    OR NOT (scopes && ARRAY['money:write', 'beneficiaries:write']::text[]))
);
-- The API keys page lists an organisation's keys of one mode, newest first.
CREATE INDEX api_key_organization ON keys.api_key (organization_id, mode, created_at DESC, id DESC);
-- The worker's re-hash finds keys still on an older pepper.
CREATE INDEX api_key_pepper ON keys.api_key ((pepper_versions[cardinality(pepper_versions)]));

-- The edge's view (spec 05 §4.9): the key record and the organisation's live status, no name and
-- nothing a member typed. A deleted organisation's keys have no row, so they read as unknown.
CREATE VIEW keys.key_lookup AS
SELECT k.id, k.organization_id, k.mode, k.kind, k.scopes, k.ip_allowlist, k.hash, k.pepper_versions,
       k.expires_at, k.revoked_at, k.rolling_until,
       CASE o.live_status WHEN 'approved' THEN 'enabled' WHEN 'paused' THEN 'paused'
         ELSE 'not_enabled' END AS org_live_status
  FROM keys.api_key k
  JOIN identity.organization o ON o.id = k.organization_id AND o.deleted_at IS NULL;

-- "Last used" ([BC-05]): rounded down to the minute, written after the answer at most once a minute
-- per key. The only write the edge may make to a key.
CREATE FUNCTION keys.touch_last_used(p_key_id text) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = keys, pg_temp
AS $fn$
  WITH touched AS (
    UPDATE keys.api_key
       SET last_used_at = date_trunc('minute', pg_catalog.now())
     WHERE id = p_key_id
       AND (last_used_at IS NULL OR last_used_at < date_trunc('minute', pg_catalog.now()))
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM touched);
$fn$;
REVOKE ALL ON FUNCTION keys.touch_last_used(text) FROM PUBLIC;

-- The audit guard (spec 02 §13.8, [AU-02]): no key is made, and no key's access, life, revocation
-- or replacement changes, without its `api_key.*` event in the same transaction. The worker's
-- re-hash (hash, pepper_versions) and the edge's "last used" are not guarded: they change neither
-- what a key may do nor for how long.
SELECT audit.install_guard('keys.api_key'::regclass, ARRAY['INSERT', 'UPDATE OF name, scopes, ip_allowlist, expires_at, revoked_at, revoked_reason, replaced_by, rolling_until, seen_by'], 'id', ARRAY['api_key.created', 'api_key.updated', 'api_key.rolled', 'api_key.revoked']);
SELECT audit.install_guard('keys.api_key'::regclass, ARRAY['UPDATE OF id, organization_id, mode, kind, created_by, created_at'], 'id', ARRAY['guard.never_allowed']);
