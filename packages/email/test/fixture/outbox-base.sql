-- A STAND-IN for P0-E's `packages/db/migrations/<ts>_email_outbox.sql`, written from spec 01 §6.10
-- for this package's integration tests only. It is never applied anywhere but the test database;
-- when the data lane's migration lands on main, the tests apply that instead (open item in the PR).
CREATE SCHEMA email;

CREATE TABLE email.template_grant (
  template text NOT NULL,
  role     text NOT NULL,
  category text NOT NULL CHECK (category IN ('code', 'security', 'notice')),
  PRIMARY KEY (template, role)
);

CREATE TABLE email.outbox (
  id              text PRIMARY KEY CHECK (id ~ '^eml_[0-9a-hjkmnp-tv-z]{26}$'),
  template        text NOT NULL,
  category        text NOT NULL,
  priority        smallint NOT NULL,
  recipient_kind  text NOT NULL CHECK (recipient_kind IN ('address', 'customer', 'person')),
  recipient       text NOT NULL,
  params          jsonb NOT NULL,
  carries_code    boolean NOT NULL,
  due_at          timestamptz NOT NULL,
  lease_until     timestamptz,
  leased_by       text,
  attempts        integer NOT NULL DEFAULT 0,
  last_error_code text,
  enqueued_by     text NOT NULL,
  created_at      timestamptz NOT NULL
);

CREATE FUNCTION email.enqueue(p jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  g email.template_grant%ROWTYPE;
BEGIN
  SELECT * INTO g FROM email.template_grant t
   WHERE t.template = p->>'template' AND pg_has_role(session_user, t.role, 'MEMBER')
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'FE001', MESSAGE = 'email.enqueue: template not allowed';
  END IF;
  INSERT INTO email.outbox (id, template, category, priority, recipient_kind, recipient, params,
                            carries_code, due_at, enqueued_by, created_at)
  VALUES (p->>'id', g.template, g.category, CASE g.category WHEN 'code' THEN 1 WHEN 'security' THEN 2 ELSE 3 END,
          coalesce(p->>'recipient_kind', 'address'), p->>'recipient', p->'params', g.category = 'code',
          statement_timestamp(), session_user, statement_timestamp());
  RETURN p->>'id';
END
$$;
REVOKE ALL ON FUNCTION email.enqueue(jsonb) FROM PUBLIC;
