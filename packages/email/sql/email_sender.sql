-- L-SAT-05's extension of the email outbox (ARCHITECTURE §9.4, §9.5; spec 08 §4.2, §4.3; spec 01
-- §6.10 "Extended by L-SAT-05"). It applies on top of P0-E's `<ts>_email_outbox.sql` and is meant to
-- land as `packages/db/migrations/<ts>_email_sender.sql` (the data lane owns that folder; this file
-- is the reviewed text, and the integration tests apply exactly it, over a copy of P0-E's migration
-- with its seeded `ops/delivery-check` grant). Run as `fin_owner`. The grants are in
-- `email_sender.grants.sql`, to be rendered into `packages/db/roles/grants/email.json`.
--
-- Every table here is logged ([DA-16]): a restart or failover never resets an allowance, a budget or
-- the token bucket. The outbox stays out of dumps ([DA-15]); so do these tables, which hold only
-- keyed hashes, counts and release SHAs. After a restore they are empty: the sender puts back the
-- token bucket's row itself, and the delivery check runs again for the release.

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
ALTER TABLE email.outbox
  ADD COLUMN folded_into text CHECK (folded_into ~ '^dig_[0-9a-f]{32}_[0-9]{10}$'),
  ADD COLUMN folded_at timestamptz,
  ADD COLUMN counted boolean NOT NULL DEFAULT false,
  ADD COLUMN security_unsent_at timestamptz,
  ADD COLUMN first_due_at timestamptz,
  ADD CONSTRAINT outbox_category CHECK (category IN ('code', 'security', 'notice', 'customer', 'ops')),
  ADD CONSTRAINT outbox_params_size CHECK (octet_length(params::text) <= 4096),
  ADD CONSTRAINT outbox_folded CHECK ((folded_into IS NULL) = (folded_at IS NULL));
-- Nothing has deferred a row before this migration: each became due when it was queued.
UPDATE email.outbox SET first_due_at = due_at;
ALTER TABLE email.outbox ALTER COLUMN first_due_at SET NOT NULL;

CREATE INDEX outbox_claim ON email.outbox (priority, due_at) WHERE folded_into IS NULL;
CREATE INDEX outbox_digest ON email.outbox (folded_into) WHERE folded_into IS NOT NULL;

-- 3. Per-recipient counts at claim time (spec 08 §4.3): `security` is the hourly allowance past which
--    notices fold into a digest; every other class has the sender's backstop in windows of its own,
--    so no other class, service or template can use up the allowance a person's codes depend on
--    (ARCHITECTURE §9.4): one per code template (`code:identity/sign-in-code`), and one per class and
--    template folder for notices and customer mail (`notice:orgs`, `customer:kyc`).
CREATE TABLE email.recipient_window (
  key          text NOT NULL CHECK (key ~ '^[0-9a-f]{32}$'),
  kind         text NOT NULL CHECK (kind ~ '^(security|code:[a-z][a-z-]{1,30}/[a-z][a-z0-9-]{1,62}|(notice|customer):[a-z][a-z-]{1,30})$'),
  window_start timestamptz NOT NULL,
  count        integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (key, kind, window_start)
);
CREATE INDEX recipient_window_age ON email.recipient_window (window_start);

-- 4. Daily send budgets (ARCHITECTURE §9.5, [SA-40]): `environment`; `class:code` and
--    `class:security` (security and ops), so each keeps a share the other cannot spend; `org:<id>`
--    for an organisation's ordinary mail and `org-security:<id>` for its security notices.
CREATE TABLE email.daily_budget (
  day   date NOT NULL,
  scope text NOT NULL CHECK (scope ~ '^(environment|class:(code|security)|(org|org-security):org_[0-9a-hjkmnp-tv-z]{26})$'),
  count integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (day, scope)
);

-- 5. The token bucket that keeps calls below Cloudflare's API-wide limit (1,200 per 5 minutes per
--    token), shared by every worker replica. `-infinity` reads as a full bucket.
CREATE TABLE email.send_bucket (
  name        text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9-]{1,30}$'),
  tokens      double precision NOT NULL,
  refilled_at timestamptz NOT NULL
);
INSERT INTO email.send_bucket (name, tokens, refilled_at) VALUES ('cloudflare', 0, '-infinity');

-- 6. The delivery check's record (spec 01 §8.5, S0-09): once per release and once a day. Replicas
--    agree by locking this table, which only the worker may write, so no other login can hold the
--    check up (ARCHITECTURE §4.6: not an advisory lock, which any login can take).
CREATE TABLE email.delivery_check (
  release     text PRIMARY KEY CHECK (release ~ '^[0-9a-f]{7,40}$'),
  check_id    text NOT NULL CHECK (check_id ~ '^job_[0-9a-hjkmnp-tv-z]{26}$'),
  trigger     text NOT NULL CHECK (trigger IN ('release', 'daily')),
  enqueued_at timestamptz NOT NULL
);

-- 7. email.enqueue(), replacing P0-E's: the template must be granted to a group the caller's login
--    belongs to (else FE001); the input is checked (else FE002, with a fixed message that never
--    echoes the input); the priority and the secret flag come from the grant, never from the caller;
--    the caller is stamped; the sender is woken by NOTIFY. The caller's TypeScript (`enqueue()` in
--    @fin/email) has already checked the params against the template, so a notice that could never
--    be sent fails the caller's transaction, not the worker.
CREATE OR REPLACE FUNCTION email.enqueue(p jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  g           email.template_grant%ROWTYPE;
  k           text;
  v_id        text;
  v_kind      text;
  v_recipient text;
  v_due       timestamptz;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: the input is not an object';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('id', 'template', 'recipient_kind', 'recipient', 'params', 'due_at') THEN
      RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: an unknown key';
    END IF;
  END LOOP;
  SELECT t.* INTO g FROM email.template_grant t
    JOIN pg_catalog.pg_roles r ON r.rolname = t.role
   WHERE t.template = p->>'template' AND pg_has_role(session_user, r.oid, 'MEMBER')
   ORDER BY t.role
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'FE001', MESSAGE = 'email.enqueue: template not allowed for this role';
  END IF;
  v_id := p->>'id';
  IF v_id IS NULL OR v_id !~ '^eml_[0-9a-hjkmnp-tv-z]{26}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad id';
  END IF;
  IF p ? 'recipient_kind' AND jsonb_typeof(p->'recipient_kind') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad recipient kind';
  END IF;
  v_kind := coalesce(p->>'recipient_kind', 'address');
  IF v_kind NOT IN ('address', 'customer', 'person') THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad recipient kind';
  END IF;
  v_recipient := p->>'recipient';
  IF v_recipient IS NULL OR jsonb_typeof(p->'recipient') IS DISTINCT FROM 'string'
     OR length(v_recipient) NOT BETWEEN 3 AND 320
     OR (v_kind = 'address' AND v_recipient !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
     OR (v_kind = 'customer' AND v_recipient !~ '^cus_[0-9a-hjkmnp-tv-z]{26}$')
     OR (v_kind = 'person' AND v_recipient !~ '^per_[0-9a-hjkmnp-tv-z]{26}$') THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad recipient';
  END IF;
  IF jsonb_typeof(p->'params') IS DISTINCT FROM 'object' OR octet_length((p->'params')::text) > 4096 THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad params';
  END IF;
  BEGIN
    v_due := greatest(statement_timestamp(), coalesce((p->>'due_at')::timestamptz, statement_timestamp()));
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: bad due_at';
  END;
  BEGIN
    INSERT INTO email.outbox (id, template, category, priority, recipient_kind, recipient, params,
                              carries_code, due_at, first_due_at, attempts, enqueued_by, created_at)
    VALUES (v_id, g.template, g.category, g.priority, v_kind, v_recipient, p->'params',
            g.carries_secret, v_due, v_due, 0, session_user, statement_timestamp());
  EXCEPTION WHEN check_violation OR not_null_violation OR string_data_right_truncation THEN
    -- These errors' DETAIL prints the whole failing row (the address, a code): never pass it on.
    RAISE EXCEPTION USING ERRCODE = 'FE002', MESSAGE = 'email.enqueue: the row is refused';
  END;
  PERFORM pg_notify('email_outbox', g.priority::text);
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION email.enqueue(jsonb) FROM PUBLIC;
