-- L-SAT-05's extension of the email outbox (ARCHITECTURE §9.4, §9.5; spec 08 §4.2, §4.3; spec 01
-- §6.10 "Extended by L-SAT-05"). It applies on top of P0-E's `<ts>_email_outbox.sql` and is meant to
-- land as `packages/db/migrations/<ts>_email_sender.sql` (the data lane owns that folder; this file
-- is the reviewed text, and the integration tests apply exactly it). Run as `fin_owner`. The grants
-- are in `email_sender.grants.sql`, to be rendered into `packages/db/roles/grants/email.json`.
--
-- Every table here is logged ([DA-16]): a restart or failover never resets an allowance, a budget or
-- the token bucket. The outbox stays out of dumps ([DA-15]); so do these tables, which hold only
-- keyed hashes, counts and release SHAs.

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

-- 2. The outbox's sender state: the digest a row is folded into, whether its recipient allowance was
--    counted, and when a security row's `email.security_unsent` was written.
ALTER TABLE email.outbox
  ADD COLUMN folded_into text CHECK (folded_into ~ '^dig_[0-9a-f]{32}_[0-9]{10}$'),
  ADD COLUMN folded_at timestamptz,
  ADD COLUMN counted boolean NOT NULL DEFAULT false,
  ADD COLUMN security_unsent_at timestamptz,
  ADD CONSTRAINT outbox_category CHECK (category IN ('code', 'security', 'notice', 'customer', 'ops')),
  ADD CONSTRAINT outbox_params_size CHECK (octet_length(params::text) <= 4096),
  ADD CONSTRAINT outbox_folded CHECK ((folded_into IS NULL) = (folded_at IS NULL));

CREATE INDEX outbox_claim ON email.outbox (priority, due_at) WHERE folded_into IS NULL;
CREATE INDEX outbox_digest ON email.outbox (folded_into) WHERE folded_into IS NOT NULL;

-- 3. Per-recipient counts at claim time (spec 08 §4.3): `security` is the hourly allowance past which
--    notices fold into a digest; `other` is the sender's backstop for every other class.
CREATE TABLE email.recipient_window (
  key          text NOT NULL CHECK (key ~ '^[0-9a-f]{32}$'),
  kind         text NOT NULL CHECK (kind IN ('security', 'other')),
  window_start timestamptz NOT NULL,
  count        integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (key, kind, window_start)
);
CREATE INDEX recipient_window_age ON email.recipient_window (window_start);

-- 4. Daily send budgets (ARCHITECTURE §9.5, [SA-40]): `environment`, and `org:<id>` per organisation.
CREATE TABLE email.daily_budget (
  day   date NOT NULL,
  scope text NOT NULL CHECK (scope ~ '^(environment|org:org_[0-9a-hjkmnp-tv-z]{26})$'),
  count integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (day, scope)
);

-- 5. The token bucket that keeps calls below Cloudflare's API-wide limit (1,200 per 5 minutes per
--    token), shared by every worker replica.
CREATE TABLE email.send_bucket (
  name        text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9-]{1,30}$'),
  tokens      double precision NOT NULL,
  refilled_at timestamptz NOT NULL
);
INSERT INTO email.send_bucket (name, tokens, refilled_at) VALUES ('cloudflare', 0, '-infinity');

-- 6. The delivery check's record (spec 01 §8.5, S0-09): once per release and once a day.
CREATE TABLE email.delivery_check (
  release     text PRIMARY KEY CHECK (release ~ '^[0-9a-f]{7,40}$'),
  check_id    text NOT NULL CHECK (check_id ~ '^job_[0-9a-hjkmnp-tv-z]{26}$'),
  trigger     text NOT NULL CHECK (trigger IN ('release', 'daily')),
  enqueued_at timestamptz NOT NULL
);

-- 7. email.enqueue(), replacing the shell: the template must be granted to a group the caller's login
--    belongs to (else FE001); the input is checked (else FE002); the priority and the secret flag come
--    from the grant, never from the caller; the caller is stamped; the sender is woken by NOTIFY.
CREATE OR REPLACE FUNCTION email.enqueue(p jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  g           email.template_grant%ROWTYPE;
  v_id        text;
  v_kind      text;
  v_recipient text;
  v_due       timestamptz;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: the input is not an object';
  END IF;
  SELECT t.* INTO g FROM email.template_grant t
   WHERE t.template = p->>'template' AND pg_has_role(session_user, t.role, 'MEMBER')
   ORDER BY t.role
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'FE001', MESSAGE = 'email.enqueue: template not allowed for this role';
  END IF;
  v_id := p->>'id';
  IF v_id IS NULL OR v_id !~ '^eml_[0-9a-hjkmnp-tv-z]{26}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad id';
  END IF;
  v_kind := coalesce(p->>'recipient_kind', 'address');
  v_recipient := p->>'recipient';
  IF v_recipient IS NULL OR length(v_recipient) NOT BETWEEN 3 AND 320
     OR (v_kind = 'address' AND v_recipient !~ '^[^[:space:]@]+@[^[:space:]@]+$')
     OR (v_kind IN ('customer', 'person') AND v_recipient !~ '^(cus|per)_[0-9a-hjkmnp-tv-z]{26}$') THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad recipient';
  END IF;
  IF jsonb_typeof(p->'params') IS DISTINCT FROM 'object' OR octet_length((p->'params')::text) > 4096 THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad params';
  END IF;
  v_due := greatest(statement_timestamp(), coalesce((p->>'due_at')::timestamptz, statement_timestamp()));
  INSERT INTO email.outbox (id, template, category, priority, recipient_kind, recipient, params,
                            carries_code, due_at, attempts, enqueued_by, created_at)
  VALUES (v_id, g.template, g.category, g.priority, v_kind, v_recipient, p->'params',
          g.carries_secret, v_due, 0, session_user, statement_timestamp());
  PERFORM pg_notify('email_outbox', g.priority::text);
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION email.enqueue(jsonb) FROM PUBLIC;
