-- A minimal stand-in for Phase 0's platform objects (spec 01 §6.10, spec 08 §3.3 and §3.5), for
-- this package's integration tests only, until packages/db (P0-E) lands with the real bootstrap
-- and migrations. It keeps the same interfaces: audit.record(p jsonb), audit.install_guard(),
-- audit.require_event() (FA010 at commit), email.enqueue(p jsonb) with its per-role allowlist (its
-- outbox in email_private, which no service role may use: rows arrive only through enqueue),
-- ops.kill_switch and the UNLOGGED ops.rate_window. Role names come from the rows the test
-- harness inserts (event_type.roles, template_grant.role), so the tests run under prefixed roles.
SET client_min_messages = warning;

CREATE SCHEMA identity;
CREATE SCHEMA staff;
CREATE SCHEMA ops;
CREATE SCHEMA audit;
CREATE SCHEMA email;
CREATE SCHEMA email_private;
REVOKE ALL ON SCHEMA identity, staff, ops, audit, email, email_private FROM PUBLIC;

CREATE TABLE audit.event_type (
  name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*){1,2}$'),
  area text NOT NULL,
  category text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('organisation', 'person', 'staff')),
  roles text[] NOT NULL CHECK (cardinality(roles) >= 1),
  retired boolean NOT NULL DEFAULT false,
  synced_release text NOT NULL DEFAULT 'test'
);

CREATE TABLE audit.event (
  id text PRIMARY KEY CHECK (id ~ '^aud_[0-9a-hjkmnp-tv-z]{26}$'),
  seq bigint,
  event text NOT NULL REFERENCES audit.event_type (name),
  category text NOT NULL,
  scope text NOT NULL,
  organization_id text,
  subject_user_id text,
  actor_kind text NOT NULL,
  actor_id text,
  actor_via text NOT NULL,
  step_up_kind text,
  step_up_method text,
  step_up_ref text,
  target_id text NOT NULL,
  ref_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(ref_ids) <= 32),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  release text NOT NULL,
  db_login text NOT NULL,
  xid xid8 NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX event_unchained ON audit.event (xid, id) WHERE seq IS NULL;

CREATE TABLE audit.event_context (
  event_id text PRIMARY KEY REFERENCES audit.event (id),
  client_ip inet,
  user_agent text CHECK (length(user_agent) <= 400),
  created_at timestamptz NOT NULL
);

CREATE FUNCTION audit.record(p jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = audit, pg_temp AS $$
DECLARE
  allowed constant text[] := ARRAY['id', 'event', 'actor_kind', 'actor_id', 'actor_via', 'actor_key_id',
    'actor_link_session_id', 'step_up_kind', 'step_up_method', 'step_up_ref', 'target_id', 'ref_ids',
    'organization_id', 'subject_user_id', 'mode', 'metadata', 'request_id', 'release', 'context'];
  et audit.event_type%ROWTYPE;
  k text;
  v jsonb;
  meta jsonb;
  refs text[] := '{}';
  ctx jsonb;
BEGIN
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF NOT (k = ANY (allowed)) THEN
      RAISE EXCEPTION 'audit.record: unknown key %', k USING ERRCODE = 'FA006';
    END IF;
  END LOOP;
  SELECT * INTO et FROM audit.event_type WHERE name = p ->> 'event';
  IF NOT FOUND OR et.retired THEN
    RAISE EXCEPTION 'audit.record: unknown or retired event' USING ERRCODE = 'FA001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM unnest(et.roles) AS r(name)
    JOIN pg_catalog.pg_roles pr ON pr.rolname = r.name
    WHERE pg_catalog.pg_has_role(session_user, pr.oid, 'MEMBER')
  ) THEN
    RAISE EXCEPTION 'audit.record: this login may not record %', et.name USING ERRCODE = 'FA002';
  END IF;
  IF et.scope = 'organisation' AND coalesce(p ->> 'organization_id', '') = '' THEN
    RAISE EXCEPTION 'audit.record: organisation scope needs organization_id' USING ERRCODE = 'FA003';
  END IF;
  IF et.scope = 'person' AND coalesce(p ->> 'subject_user_id', '') = '' THEN
    RAISE EXCEPTION 'audit.record: person scope needs subject_user_id' USING ERRCODE = 'FA003';
  END IF;
  meta := coalesce(p -> 'metadata', '{}'::jsonb);
  IF jsonb_typeof(meta) <> 'object' OR octet_length(meta::text) > 4096 THEN
    RAISE EXCEPTION 'audit.record: metadata must be an object' USING ERRCODE = 'FA004';
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(meta) LOOP
    IF k !~ '^[a-z][A-Za-z0-9_]{0,63}$' OR jsonb_typeof(v) = 'object' THEN
      RAISE EXCEPTION 'audit.record: metadata shape' USING ERRCODE = 'FA004';
    END IF;
  END LOOP;
  IF p ? 'ref_ids' AND jsonb_typeof(p -> 'ref_ids') = 'array' THEN
    IF jsonb_array_length(p -> 'ref_ids') > 32 THEN
      RAISE EXCEPTION 'audit.record: ref_ids' USING ERRCODE = 'FA005';
    END IF;
    refs := ARRAY(SELECT jsonb_array_elements_text(p -> 'ref_ids'));
  END IF;
  IF coalesce(p ->> 'id', '') !~ '^aud_[0-9a-hjkmnp-tv-z]{26}$' THEN
    RAISE EXCEPTION 'audit.record: id shape' USING ERRCODE = 'FA005';
  END IF;
  IF coalesce(p ->> 'target_id', '') = '' OR coalesce(p ->> 'release', '') = '' THEN
    RAISE EXCEPTION 'audit.record: target and release are required' USING ERRCODE = 'FA006';
  END IF;
  INSERT INTO audit.event (id, event, category, scope, organization_id, subject_user_id, actor_kind,
    actor_id, actor_via, step_up_kind, step_up_method, step_up_ref, target_id, ref_ids, metadata,
    request_id, release, db_login, xid, recorded_at)
  VALUES (p ->> 'id', et.name, et.category, et.scope, p ->> 'organization_id', p ->> 'subject_user_id',
    p ->> 'actor_kind', p ->> 'actor_id', p ->> 'actor_via', p ->> 'step_up_kind', p ->> 'step_up_method',
    p ->> 'step_up_ref', p ->> 'target_id', refs, meta, p ->> 'request_id', p ->> 'release',
    session_user, pg_catalog.pg_current_xact_id(), pg_catalog.statement_timestamp());
  ctx := p -> 'context';
  IF ctx IS NOT NULL AND jsonb_typeof(ctx) = 'object' AND (p ->> 'actor_via') IN ('console', 'admin') THEN
    INSERT INTO audit.event_context (event_id, client_ip, user_agent, created_at)
    VALUES (p ->> 'id', (ctx ->> 'client_ip')::inet, ctx ->> 'user_agent', pg_catalog.statement_timestamp());
  END IF;
  RETURN p ->> 'id';
END
$$;

CREATE FUNCTION audit.require_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = audit, pg_temp AS $$
DECLARE
  key_value text;
  accepted text[];
BEGIN
  key_value := (CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END) ->> TG_ARGV[0];
  accepted := string_to_array(TG_ARGV[1], ',');
  IF key_value IS NOT NULL AND EXISTS (
    SELECT 1 FROM audit.event e
    WHERE e.xid = pg_catalog.pg_current_xact_id()
      AND e.seq IS NULL
      AND (e.target_id = key_value OR key_value = ANY (e.ref_ids) OR e.step_up_ref = key_value)
      AND ('*' = ANY (accepted) OR e.event = ANY (accepted))
  ) THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'audit guard: %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'FA010';
END
$$;

CREATE FUNCTION audit.install_guard(p_table regclass, p_ops text[], p_key_column name, p_events text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = audit, pg_temp AS $$
DECLARE
  op text;
  trigger_name text;
BEGIN
  FOREACH op IN ARRAY p_ops LOOP
    IF op !~ '^(INSERT|DELETE|UPDATE|UPDATE OF [a-z_][a-z0-9_]*(, [a-z_][a-z0-9_]*)*)$' THEN
      RAISE EXCEPTION 'audit.install_guard: bad operation %', op USING ERRCODE = '22023';
    END IF;
    trigger_name := format('audit_guard_%s_%s_%s', lower(split_part(op, ' ', 1)),
      left(p_key_column::text, 30), left(md5(op || '|' || p_key_column || '|' || array_to_string(p_events, ',')), 8));
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trigger_name, p_table);
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER %s ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION audit.require_event(%L, %L)',
      trigger_name, op, p_table, p_key_column, array_to_string(p_events, ','));
  END LOOP;
END
$$;

CREATE TABLE email.template_grant (
  template text NOT NULL CHECK (template ~ '^[a-z][a-z0-9-]*/[a-z][a-z0-9-]*$'),
  role text NOT NULL,
  category text NOT NULL CHECK (category IN ('code', 'security', 'notice', 'customer', 'ops')),
  PRIMARY KEY (template, role)
);

CREATE TABLE email_private.outbox (
  id text PRIMARY KEY CHECK (id ~ '^eml_[0-9a-hjkmnp-tv-z]{26}$'),
  template text NOT NULL,
  category text NOT NULL,
  priority smallint NOT NULL,
  recipient_kind text NOT NULL,
  recipient text NOT NULL,
  params jsonb NOT NULL,
  carries_code boolean NOT NULL,
  due_at timestamptz NOT NULL,
  enqueued_by text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE FUNCTION email.enqueue(p jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = email, pg_temp AS $$
DECLARE
  g email.template_grant%ROWTYPE;
  k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('id', 'template', 'recipient_kind', 'recipient', 'params', 'due_at') THEN
      RAISE EXCEPTION 'email.enqueue: unknown key %', k USING ERRCODE = 'FE002';
    END IF;
  END LOOP;
  SELECT t.* INTO g FROM email.template_grant t
  JOIN pg_catalog.pg_roles pr ON pr.rolname = t.role
  WHERE t.template = p ->> 'template' AND pg_catalog.pg_has_role(session_user, pr.oid, 'MEMBER')
  ORDER BY t.role LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'email.enqueue: this login may not send that template' USING ERRCODE = 'FE001';
  END IF;
  IF coalesce(p ->> 'id', '') !~ '^eml_[0-9a-hjkmnp-tv-z]{26}$'
     OR p ->> 'recipient_kind' <> 'address'
     OR coalesce(p ->> 'recipient', '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'email.enqueue: shape' USING ERRCODE = 'FE002';
  END IF;
  INSERT INTO email_private.outbox (id, template, category, priority, recipient_kind, recipient, params,
    carries_code, due_at, enqueued_by, created_at)
  VALUES (p ->> 'id', g.template, g.category,
    CASE g.category WHEN 'code' THEN 1 WHEN 'security' THEN 2 ELSE 3 END,
    p ->> 'recipient_kind', p ->> 'recipient', coalesce(p -> 'params', '{}'::jsonb), g.category = 'code',
    pg_catalog.statement_timestamp(), session_user, pg_catalog.statement_timestamp());
  RETURN p ->> 'id';
END
$$;

CREATE TABLE ops.kill_switch (
  name text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('on', 'off')),
  reason_code text,
  changed_by_kind text,
  changed_by_id text,
  changed_at timestamptz NOT NULL
);
INSERT INTO ops.kill_switch (name, state, changed_at) VALUES ('signups', 'off', now());

CREATE UNLOGGED TABLE ops.rate_window (
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 200),
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (key, window_start)
);

REVOKE EXECUTE ON FUNCTION audit.record(jsonb), audit.install_guard(regclass, text[], name, text[]),
  email.enqueue(jsonb) FROM PUBLIC;
