-- email outbox (spec 01 §6.10 row 6; spec 08 §4; ARCHITECTURE §9.4; DECISIONS DA-14, EM-04). Run as
-- fin_owner. Every service that sends mail calls email.enqueue() in its own transaction; it refuses a
-- template the caller's role may not send, so no service can queue a look-alike sign-in or "key
-- revoked" notice. Only the worker claims, sends and deletes rows. L-SAT-05 extends this with
-- priorities, per-recipient counts, digests and budgets.
--
-- The classes are spec 08 §4.2's (code, security, notice, customer, ops): spec 08 owns email's rules,
-- and its Phase 0 template, ops/delivery-check, is of class `ops`.
--
-- SQLSTATE FE001: a template the caller's role may not send (or no such template); FE002: the input's
-- shape.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE email.template_grant (
  template text NOT NULL CHECK (template ~ '^[a-z][a-z0-9-]*/[a-z][a-z0-9-]*$'),
  role     text NOT NULL CHECK (role IN ('fin_api', 'fin_worker', 'fin_payments', 'fin_console', 'fin_admin')),
  category text NOT NULL CHECK (category IN ('code', 'security', 'notice', 'customer', 'ops')),
  PRIMARY KEY (template, role)
);
-- S0-09, spec 08 §4.4: the delivery check, sent by the worker to the seed inbox.
INSERT INTO email.template_grant (template, role, category) VALUES ('ops/delivery-check', 'fin_worker', 'ops');

CREATE TABLE email.outbox (
  id              text PRIMARY KEY CHECK (id ~ '^eml_[0-9a-hjkmnp-tv-z]{26}$'),
  template        text NOT NULL,
  category        text NOT NULL CHECK (category IN ('code', 'security', 'notice', 'customer', 'ops')),
  priority        smallint NOT NULL CHECK (priority BETWEEN 1 AND 9),
  recipient_kind  text NOT NULL CHECK (recipient_kind IN ('address', 'customer', 'person')),
  recipient       text NOT NULL CHECK (char_length(recipient) BETWEEN 1 AND 320),
  params          jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 4096),
  carries_code    boolean NOT NULL,
  due_at          timestamptz NOT NULL,
  lease_until     timestamptz,
  leased_by       text CHECK (char_length(leased_by) <= 128),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text CHECK (last_error_code ~ '^[a-z0-9][a-z0-9_.]{0,63}$'),
  enqueued_by     text NOT NULL,
  created_at      timestamptz NOT NULL
);
CREATE INDEX outbox_due ON email.outbox (priority, due_at);

CREATE FUNCTION email.enqueue(p jsonb) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = email, pg_temp
AS $fn$
DECLARE
  g email.template_grant%ROWTYPE;
  k text;
  kind text;
  recipient text;
  due timestamptz;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'email.enqueue takes a JSON object' USING ERRCODE = 'FE002';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('id', 'template', 'recipient_kind', 'recipient', 'params', 'due_at') THEN
      RAISE EXCEPTION 'email.enqueue: unknown key %', k USING ERRCODE = 'FE002';
    END IF;
  END LOOP;

  -- The template must be granted to one of the caller's groups.
  SELECT t.* INTO g FROM email.template_grant t
  JOIN pg_catalog.pg_roles pr ON pr.rolname = t.role
  WHERE t.template = p ->> 'template' AND pg_catalog.pg_has_role(session_user, pr.oid, 'MEMBER')
  ORDER BY t.role
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'email.enqueue: this login may not send that template' USING ERRCODE = 'FE001';
  END IF;

  IF coalesce(p ->> 'id', '') !~ '^eml_[0-9a-hjkmnp-tv-z]{26}$' THEN
    RAISE EXCEPTION 'email.enqueue: id shape' USING ERRCODE = 'FE002';
  END IF;
  kind := p ->> 'recipient_kind';
  recipient := p ->> 'recipient';
  IF kind IS NULL OR recipient IS NULL
     OR NOT (
       (kind = 'address' AND char_length(recipient) <= 320 AND recipient ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
       OR (kind = 'customer' AND recipient ~ '^cus_[0-9a-hjkmnp-tv-z]{26}$')
       OR (kind = 'person' AND recipient ~ '^per_[0-9a-hjkmnp-tv-z]{26}$')
     ) THEN
    RAISE EXCEPTION 'email.enqueue: recipient shape' USING ERRCODE = 'FE002';
  END IF;
  IF jsonb_typeof(coalesce(p -> 'params', '{}'::jsonb)) <> 'object'
     OR octet_length(coalesce(p -> 'params', '{}'::jsonb)::text) > 4096 THEN
    RAISE EXCEPTION 'email.enqueue: params is an object of at most 4 KB' USING ERRCODE = 'FE002';
  END IF;
  BEGIN
    due := coalesce((p ->> 'due_at')::timestamptz, pg_catalog.statement_timestamp());
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'email.enqueue: due_at' USING ERRCODE = 'FE002';
  END;

  INSERT INTO email.outbox (id, template, category, priority, recipient_kind, recipient, params,
    carries_code, due_at, enqueued_by, created_at)
  VALUES (p ->> 'id', g.template, g.category,
    CASE g.category WHEN 'code' THEN 1 WHEN 'security' THEN 2 WHEN 'ops' THEN 4 ELSE 3 END,
    kind, recipient, coalesce(p -> 'params', '{}'::jsonb), g.category = 'code', due,
    session_user, pg_catalog.statement_timestamp());
  NOTIFY email_due;
  RETURN p ->> 'id';
END
$fn$;

REVOKE ALL ON FUNCTION email.enqueue(jsonb) FROM PUBLIC;
