-- L-SAT-05's extension of the email outbox (ARCHITECTURE §9.4, §9.5; spec 08 §4.2, §4.3; spec 01
-- §6.10 "Extended by L-SAT-05"). It applies on top of P0-E's `20261121101300_email_outbox.sql`, and
-- `migrate` finds it by the database files' rule (packages/db/src/assets.ts), as fin_owner. This
-- package's own integration tests apply exactly it over a copy of P0-E's migration with its seeded
-- `ops/delivery-check` grant (src/testing). The grants are `grants/email-sender.json`; the rows of
-- `email.template_grant` come from the template catalogue, which `migrate` syncs after the files
-- (apps/api/src/migrate/main.ts, afterMigrations).
--
-- Every table here is logged ([DA-16]): a restart or failover never resets an allowance, a budget or
-- the token bucket. The outbox stays out of dumps ([DA-15]); so do these tables, which hold only
-- keyed hashes, counts and release SHAs. After a restore they are empty: the sender puts back the
-- token bucket's row itself, and the delivery check puts back its turn's row and runs again for the
-- release.
--
-- Only the worker's sender and delivery check use these tables, so they live with the outbox in
-- `email_private`, which only the worker and email.enqueue()'s owner may use (see P0-E's migration):
-- Postgres takes a statement's table lock before it checks its privileges, so a login that could
-- name these tables could hold the sender and the check up; one with no USAGE on the schema cannot
-- name them. Each table has nothing for PUBLIC.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. Five classes (spec 08 §4.2), each grant carrying its priority and whether its rows bear a secret.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'email.template_grant'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%category%'
  LOOP
    EXECUTE format('ALTER TABLE email.template_grant DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;

ALTER TABLE email.template_grant
  ADD CONSTRAINT template_grant_category CHECK (category IN ('code', 'security', 'notice', 'customer', 'ops')),
  ADD CONSTRAINT template_grant_template CHECK (template ~ '^[a-z][a-z-]{1,30}/[a-z][a-z0-9-]{1,62}$'),
  ADD COLUMN priority smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 9),
  ADD COLUMN carries_secret boolean NOT NULL DEFAULT false;

-- The grants P0-E's migration seeded (`ops/delivery-check`) take their class's priority and secret
-- flag; the column defaults above are only for the moment of the ALTER.
UPDATE email.template_grant
   SET priority = CASE category WHEN 'code' THEN 1 WHEN 'security' THEN 2 WHEN 'ops' THEN 4 ELSE 3 END,
       carries_secret = (category = 'code');

-- 2. The outbox's sender state: the digest a row is folded into, whether its recipient allowance was
--    counted, when a security row's `email.security_unsent` was written, and when the row first
--    became due (set once at enqueue; a deferral never moves it, so `email-outbox-age` sees a row the
--    token bucket or a budget keeps holding back).
ALTER TABLE email_private.outbox
  ADD COLUMN folded_into text CHECK (folded_into ~ '^dig_[0-9a-f]{32}_[0-9]{10}$'),
  ADD COLUMN folded_at timestamptz,
  ADD COLUMN counted boolean NOT NULL DEFAULT false,
  ADD COLUMN security_unsent_at timestamptz,
  ADD COLUMN first_due_at timestamptz,
  ADD CONSTRAINT outbox_category CHECK (category IN ('code', 'security', 'notice', 'customer', 'ops')),
  ADD CONSTRAINT outbox_params_size CHECK (octet_length(params::text) <= 4096),
  ADD CONSTRAINT outbox_folded CHECK ((folded_into IS NULL) = (folded_at IS NULL));
-- Nothing has deferred a row before this migration: each became due when it was queued.
UPDATE email_private.outbox SET first_due_at = due_at;
ALTER TABLE email_private.outbox ALTER COLUMN first_due_at SET NOT NULL;

CREATE INDEX outbox_claim ON email_private.outbox (priority, due_at) WHERE folded_into IS NULL;
CREATE INDEX outbox_digest ON email_private.outbox (folded_into) WHERE folded_into IS NOT NULL;

-- 3. Per-recipient counts at claim time (spec 08 §4.3): `security` is the hourly allowance past which
--    notices fold into a digest; every other class has the sender's backstop in windows of its own,
--    so no other class, service or template can use up the allowance a person's codes depend on
--    (ARCHITECTURE §9.4): one per code template (`code:identity/sign-in-code`), and one per class and
--    template folder for notices and customer mail (`notice:orgs`, `customer:kyc`).
CREATE TABLE email_private.recipient_window (
  key          text NOT NULL CHECK (key ~ '^[0-9a-f]{32}$'),
  kind         text NOT NULL CHECK (kind ~ '^(security|code:[a-z][a-z-]{1,30}/[a-z][a-z0-9-]{1,62}|(notice|customer):[a-z][a-z-]{1,30})$'),
  window_start timestamptz NOT NULL,
  count        integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (key, kind, window_start)
);
CREATE INDEX recipient_window_age ON email_private.recipient_window (window_start);
REVOKE ALL ON TABLE email_private.recipient_window FROM PUBLIC;

-- 4. Daily send budgets (ARCHITECTURE §9.5, [SA-40]): `environment`; `class:code` and
--    `class:security` (security and ops), so each keeps a share the other cannot spend;
--    `class:org-security` (security notices that name an organisation), so mail that names none
--    keeps a share no organisation can spend; `org:<id>` for an organisation's ordinary mail and
--    `org-security:<id>` for its security notices.
CREATE TABLE email_private.daily_budget (
  day   date NOT NULL,
  scope text NOT NULL CHECK (scope ~ '^(environment|class:(code|security|org-security)|(org|org-security):org_[0-9a-hjkmnp-tv-z]{26})$'),
  count integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (day, scope)
);
REVOKE ALL ON TABLE email_private.daily_budget FROM PUBLIC;

-- 5. The token bucket that keeps calls below Cloudflare's API-wide limit (1,200 per 5 minutes per
--    token), shared by every worker replica. `-infinity` reads as a full bucket.
CREATE TABLE email_private.send_bucket (
  name        text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9-]{1,30}$'),
  tokens      double precision NOT NULL,
  refilled_at timestamptz NOT NULL
);
INSERT INTO email_private.send_bucket (name, tokens, refilled_at) VALUES ('cloudflare', 0, '-infinity');
REVOKE ALL ON TABLE email_private.send_bucket FROM PUBLIC;

-- 6. The delivery check's record (spec 01 §8.5, S0-09): once per release and once a day.
CREATE TABLE email_private.delivery_check (
  release     text PRIMARY KEY CHECK (release ~ '^[0-9a-f]{7,40}$'),
  check_id    text NOT NULL CHECK (check_id ~ '^job_[0-9a-hjkmnp-tv-z]{26}$'),
  trigger     text NOT NULL CHECK (trigger IN ('release', 'daily')),
  enqueued_at timestamptz NOT NULL
);
REVOKE ALL ON TABLE email_private.delivery_check FROM PUBLIC;
--    Replicas take turns through the row lock on this table's one row (ARCHITECTURE §4.6), not an
--    advisory lock, which any login can take. A row lock alone does not keep other logins from
--    holding the check up: taking the turn puts the row back (INSERT, ROW EXCLUSIVE) and locks it
--    (FOR UPDATE, ROW SHARE), and a login that can name the table can queue a stronger lock in front
--    of both with no privilege on it (a PREPARE in an open transaction holds a lock, and a CREATE
--    RULE or CREATE TRIGGER queues ACCESS EXCLUSIVE or SHARE ROW EXCLUSIVE behind it before its
--    privilege check fails). What keeps them out is the schema: no login but the worker can name a
--    table in `email_private`. After a restore the worker puts the row back.
CREATE TABLE email_private.delivery_check_turn (
  name text PRIMARY KEY CHECK (name = 'delivery-check')
);
INSERT INTO email_private.delivery_check_turn (name) VALUES ('delivery-check');
REVOKE ALL ON TABLE email_private.delivery_check_turn FROM PUBLIC;

-- 7. email.enqueue(), replacing P0-E's: the template must be granted to a group the caller's login
--    belongs to (else FE001); the input is checked (else FE002, with a fixed message that never
--    echoes the input); the priority and the secret flag come from the grant, never from the caller;
--    the caller is stamped; the sender is woken by NOTIFY. The caller's TypeScript (`enqueue()` in
--    @fin/email) has already checked the params against the template, so a notice that could never
--    be sent fails the caller's transaction, not the worker.
--
--    CREATE OR REPLACE keeps P0-E's owner, fin_email_enqueue (which cannot log in and holds only
--    INSERT on the outbox and SELECT on the template grants), and its grants: fin_owner replaces the
--    function as that role's member. The search path is pinned to pg_catalog and pg_temp, and every
--    table, type and function inside is named with its schema.
CREATE OR REPLACE FUNCTION email.enqueue(p jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  g           email.template_grant%ROWTYPE;
  k           pg_catalog.text;
  v_id        pg_catalog.text;
  v_kind      pg_catalog.text;
  v_recipient pg_catalog.text;
  v_due       pg_catalog.timestamptz;
BEGIN
  IF p IS NULL OR pg_catalog.jsonb_typeof(p) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: the input is not an object';
  END IF;
  FOR k IN SELECT pg_catalog.jsonb_object_keys(p) LOOP
    IF k NOT IN ('id', 'template', 'recipient_kind', 'recipient', 'params', 'due_at') THEN
      RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: an unknown key';
    END IF;
  END LOOP;
  SELECT t.* INTO g FROM email.template_grant t
    JOIN pg_catalog.pg_roles r ON r.rolname = t.role
   WHERE t.template = p->>'template' AND pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER')
   ORDER BY t.role
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'FE001', MESSAGE = 'email.enqueue: template not allowed for this role';
  END IF;
  v_id := p->>'id';
  IF v_id IS NULL OR v_id !~ '^eml_[0-9a-hjkmnp-tv-z]{26}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad id';
  END IF;
  IF p ? 'recipient_kind' AND pg_catalog.jsonb_typeof(p->'recipient_kind') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad recipient kind';
  END IF;
  v_kind := coalesce(p->>'recipient_kind', 'address');
  IF v_kind NOT IN ('address', 'customer', 'person') THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad recipient kind';
  END IF;
  v_recipient := p->>'recipient';
  IF v_recipient IS NULL OR pg_catalog.jsonb_typeof(p->'recipient') IS DISTINCT FROM 'string'
     OR pg_catalog.length(v_recipient) NOT BETWEEN 3 AND 320
     OR (v_kind = 'address' AND v_recipient !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
     OR (v_kind = 'customer' AND v_recipient !~ '^cus_[0-9a-hjkmnp-tv-z]{26}$')
     OR (v_kind = 'person' AND v_recipient !~ '^per_[0-9a-hjkmnp-tv-z]{26}$') THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad recipient';
  END IF;
  IF pg_catalog.jsonb_typeof(p->'params') IS DISTINCT FROM 'object'
     OR pg_catalog.octet_length((p->'params')::pg_catalog.text) > 4096 THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad params';
  END IF;
  BEGIN
    v_due := greatest(pg_catalog.statement_timestamp(),
                      coalesce((p->>'due_at')::pg_catalog.timestamptz, pg_catalog.statement_timestamp()));
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad due_at';
  END;
  BEGIN
    INSERT INTO email_private.outbox (id, template, category, priority, recipient_kind, recipient,
                                      params, carries_code, due_at, first_due_at, attempts,
                                      enqueued_by, created_at)
    VALUES (v_id, g.template, g.category, g.priority, v_kind, v_recipient, p->'params',
            g.carries_secret, v_due, v_due, 0, session_user, pg_catalog.statement_timestamp());
  EXCEPTION WHEN check_violation OR not_null_violation OR string_data_right_truncation THEN
    -- These errors' DETAIL prints the whole failing row (the address, a code): never pass it on.
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: the row is refused';
  END;
  PERFORM pg_catalog.pg_notify('email_outbox', g.priority::pg_catalog.text);
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION email.enqueue(jsonb) FROM PUBLIC;
