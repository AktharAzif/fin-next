-- audit core (spec 08 §3.2, §3.3, §3.5, §3.6; spec 01 §6.10 row 3; DECISIONS AU-02). Run as fin_owner.
--
-- audit.event is written only through audit.record(), which stamps what the caller cannot choose
-- (the login, application_name, backend PID, transaction ID and the server's time) and checks the
-- event against the per-role registry. Rows are inserted unchained, and writers never wait on each
-- other or on the sequencer; the sequencer gives each row a gapless seq and its hash afterwards. No
-- service role holds INSERT, UPDATE or DELETE on any audit table; triggers refuse every change but the
-- sequencer's one write of the chain fields, and the bootstrap's guard (040_audit_guard.sql) refuses
-- anyone but the superuser the DDL that would switch those triggers off.
--
-- SQLSTATE class FA is Fin's audit class: FA001 unknown or retired event, FA002 role not allowed,
-- FA003 scope fields missing, FA004 metadata shape, FA005 refs or ID, FA006 any other input shape
-- (an unknown key, a missing field, a value outside its list), FA010 the guard, FA011 no current
-- epoch, FA012 an epoch start the environment refuses (a reset in production, or a task that names
-- another environment than the one the bootstrap recorded).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE audit.event_type (
  name           text PRIMARY KEY CHECK (name ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*){1,2}$'),
  area           text NOT NULL CHECK (area ~ '^[a-z][a-z0-9-]{0,62}$'),
  category       text NOT NULL CHECK (category IN ('sign_in', 'security', 'team', 'api_keys',
                   'organisation', 'customers', 'going_live', 'webhooks', 'money', 'staff',
                   'operations', 'system')),
  scope          text NOT NULL CHECK (scope IN ('organisation', 'person', 'staff')),
  roles          text[] NOT NULL CHECK (
                   cardinality(roles) >= 1
                   AND roles <@ ARRAY['fin_edge', 'fin_api', 'fin_worker', 'fin_payments',
                     'fin_console', 'fin_admin', 'fin_owner']::text[]),
  -- The revocation-journal kind the event declares (§3.10), synced from the registry's `journal.kind`.
  -- audit.record_journal() takes the kind from here, never from its caller.
  journal_kind   text CHECK (journal_kind IN ('key_revoked', 'key_rolled', 'sessions_ended',
                   'member_removed', 'invitation_cancelled', 'role_lowered', 'organisation_deleted',
                   'organisation_paused', 'factor_removed', 'trusted_browser_revoked', 'staff_removed',
                   'staff_factors_reset', 'staff_role_lowered', 'links_revoked', 'customer_erased',
                   'webhook_secret_rolled', 'webhook_endpoint_deleted', 'beneficiary_removed',
                   'switch_set', 'switch_cleared')),
  retired        boolean NOT NULL DEFAULT false,
  synced_release text NOT NULL
);

CREATE TABLE audit.event (
  id                    text PRIMARY KEY CHECK (id ~ '^aud_[0-9a-hjkmnp-tv-z]{26}$'),
  epoch                 integer NOT NULL,
  seq                   bigint,
  event                 text NOT NULL REFERENCES audit.event_type (name),
  category              text NOT NULL,
  scope                 text NOT NULL CHECK (scope IN ('organisation', 'person', 'staff')),
  organization_id       text,
  subject_user_id       text,
  mode                  text CHECK (mode IN ('sandbox', 'live')),
  actor_kind            text NOT NULL CHECK (actor_kind IN ('user', 'api_key', 'staff', 'customer_link',
                          'person_link', 'system', 'provider', 'operator')),
  actor_id              text,
  actor_via             text NOT NULL CHECK (actor_via IN ('console', 'api', 'hosted_pages', 'admin', 'job',
                          'webhook', 'reconciliation', 'operator')),
  actor_key_id          text,
  actor_link_session_id text,
  step_up_kind          text CHECK (step_up_kind IN ('window', 'intent')),
  step_up_method        text CHECK (step_up_method IN ('passkey', 'totp', 'backup_code')),
  step_up_ref           text,
  target_id             text NOT NULL,
  ref_ids               text[] NOT NULL DEFAULT '{}' CHECK (cardinality(ref_ids) <= 32),
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  request_id            text,
  release               text NOT NULL,
  db_login              text NOT NULL,
  app_name              text NOT NULL,
  backend_pid           integer NOT NULL,
  xid                   xid8 NOT NULL,
  recorded_at           timestamptz NOT NULL,
  prev_hash             bytea,
  hash                  bytea,
  CHECK ((seq IS NULL) = (hash IS NULL) AND (seq IS NULL) = (prev_hash IS NULL))
);
CREATE INDEX event_org_log    ON audit.event (organization_id, id DESC) WHERE scope = 'organisation';
CREATE INDEX event_person_log ON audit.event (subject_user_id, id DESC) WHERE scope = 'person';
CREATE INDEX event_staff_log  ON audit.event (id DESC) WHERE scope = 'staff';
CREATE INDEX event_target     ON audit.event (target_id, id DESC);
CREATE INDEX event_unchained  ON audit.event (xid, id) WHERE seq IS NULL;
-- One row per chain position (spec 08 §3.3's unique index), as a constraint: an index a constraint
-- owns cannot be dropped with DROP INDEX, so DROP INDEX CONCURRENTLY, whose first steps commit before
-- the bootstrap's guard could refuse it, never leaves it half-dropped (040_audit_guard.sql).
ALTER TABLE audit.event ADD CONSTRAINT event_epoch_seq UNIQUE (epoch, seq);

-- The client address and user agent of console and Fin Admin actors (BC-03), outside the chain so
-- their retention can differ (13 months, D08-02).
CREATE TABLE audit.event_context (
  event_id    text PRIMARY KEY REFERENCES audit.event (id),
  client_ip   inet,
  user_agent  text CHECK (length(user_agent) <= 400),
  created_at  timestamptz NOT NULL
);

-- The chain head, one row per epoch, exactly one current (§3.6, §3.9).
CREATE TABLE audit.head (
  epoch           integer PRIMARY KEY CHECK (epoch >= 1),
  seq             bigint NOT NULL CHECK (seq >= 0),
  hash            bytea NOT NULL CHECK (octet_length(hash) = 32),
  moved_at        timestamptz NOT NULL,
  started_at      timestamptz NOT NULL,
  start_reason    text NOT NULL CHECK (start_reason IN ('created', 'restore', 'reset', 'failover')),
  start_prev_hash bytea NOT NULL CHECK (octet_length(start_prev_hash) = 32),
  marker_key      text,
  current         boolean NOT NULL
);
-- Exactly one current epoch (§3.6's unique partial index), as an exclusion constraint for the reason
-- event_epoch_seq is a constraint.
ALTER TABLE audit.head ADD CONSTRAINT head_current EXCLUDE USING btree (current WITH =) WHERE (current);
INSERT INTO audit.head (epoch, seq, hash, moved_at, started_at, start_reason, start_prev_hash, marker_key, current)
VALUES (1, 0, decode(repeat('00', 32), 'hex'), now(), now(), 'created', decode(repeat('00', 32), 'hex'), NULL, true);

-- One trigger function guards every audit table (the journal migration attaches it to its own).
-- It is SECURITY INVOKER on purpose: its rule is "only fin_owner", and inside a SECURITY DEFINER
-- function current_user would always be the owner. As an invoker it sees the statement's own role:
-- fin_owner inside the sequencer and start_epoch (SECURITY DEFINER, owned by fin_owner) or a watched
-- fin_owner login, and anyone else, the superuser included, is refused. Its search_path holds no
-- schema fin_owner can create objects in, so no function or operator it calls can be shadowed; the
-- bootstrap's guard refuses any later change to it but the superuser's.
CREATE FUNCTION audit.append_only() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'audit.% cannot be truncated', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Context rows are swept after 13 months, only by the owner's sweep (D08-02). Nothing else in
    -- the audit schema is ever deleted.
    IF TG_TABLE_NAME = 'event_context' AND current_user = 'fin_owner' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'audit.% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'event' THEN
      -- Only the chain fields, once, from null to a value, inside the owner's functions (§3.3).
      IF current_user = 'fin_owner'
         AND OLD.seq IS NULL AND OLD.prev_hash IS NULL AND OLD.hash IS NULL
         AND NEW.seq IS NOT NULL AND NEW.prev_hash IS NOT NULL AND NEW.hash IS NOT NULL
         AND (to_jsonb(NEW) - 'seq' - 'prev_hash' - 'hash') = (to_jsonb(OLD) - 'seq' - 'prev_hash' - 'hash')
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'audit.event rows are immutable once written' USING ERRCODE = '42501';
    END IF;
    IF TG_TABLE_NAME = 'head' THEN
      -- The sequencer moves seq and hash forward; start_epoch clears current on the old epoch.
      IF current_user = 'fin_owner'
         AND NEW.epoch = OLD.epoch AND NEW.started_at = OLD.started_at
         AND NEW.start_reason = OLD.start_reason AND NEW.start_prev_hash = OLD.start_prev_hash
         AND NEW.marker_key IS NOT DISTINCT FROM OLD.marker_key
         AND NEW.seq >= OLD.seq
         AND (NEW.seq > OLD.seq OR NEW.hash = OLD.hash)
         AND NOT (NEW.current AND NOT OLD.current)
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'audit.head moves only forward' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'audit.% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER event_append_only BEFORE UPDATE OR DELETE ON audit.event
  FOR EACH ROW EXECUTE FUNCTION audit.append_only();
CREATE TRIGGER event_no_truncate BEFORE TRUNCATE ON audit.event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.append_only();
CREATE TRIGGER event_context_append_only BEFORE UPDATE OR DELETE ON audit.event_context
  FOR EACH ROW EXECUTE FUNCTION audit.append_only();
CREATE TRIGGER event_context_no_truncate BEFORE TRUNCATE ON audit.event_context
  FOR EACH STATEMENT EXECUTE FUNCTION audit.append_only();
CREATE TRIGGER head_forward_only BEFORE UPDATE OR DELETE ON audit.head
  FOR EACH ROW EXECUTE FUNCTION audit.append_only();
CREATE TRIGGER head_no_truncate BEFORE TRUNCATE ON audit.head
  FOR EACH STATEMENT EXECUTE FUNCTION audit.append_only();
CREATE TRIGGER event_type_no_delete BEFORE DELETE ON audit.event_type
  FOR EACH ROW EXECUTE FUNCTION audit.append_only();
CREATE TRIGGER event_type_no_truncate BEFORE TRUNCATE ON audit.event_type
  FOR EACH STATEMENT EXECUTE FUNCTION audit.append_only();

-- audit.record(p jsonb) (§3.3): the only way a row reaches audit.event.
CREATE FUNCTION audit.record(p jsonb) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $fn$
DECLARE
  allowed constant text[] := ARRAY['id', 'event', 'actor_kind', 'actor_id', 'actor_via', 'actor_key_id',
    'actor_link_session_id', 'step_up_kind', 'step_up_method', 'step_up_ref', 'target_id', 'ref_ids',
    'organization_id', 'subject_user_id', 'mode', 'metadata', 'request_id', 'release', 'context'];
  string_keys constant text[] := ARRAY['id', 'event', 'actor_kind', 'actor_id', 'actor_via',
    'actor_key_id', 'actor_link_session_id', 'step_up_kind', 'step_up_method', 'step_up_ref',
    'target_id', 'organization_id', 'subject_user_id', 'mode', 'request_id', 'release'];
  et audit.event_type%ROWTYPE;
  k text;
  v jsonb;
  meta jsonb;
  refs text[] := '{}';
  ctx jsonb;
  ctx_ip inet;
  cur_epoch integer;
BEGIN
  -- 1. The keys.
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'audit.record takes a JSON object' USING ERRCODE = 'FA006';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF NOT (k = ANY (allowed)) THEN
      RAISE EXCEPTION 'audit.record: unknown key %', k USING ERRCODE = 'FA006';
    END IF;
  END LOOP;
  FOREACH k IN ARRAY string_keys LOOP
    IF p ? k AND jsonb_typeof(p -> k) NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'audit.record: % must be a string', k USING ERRCODE = 'FA006';
    END IF;
  END LOOP;

  -- 2. The event, which must be registered and not retired.
  SELECT * INTO et FROM audit.event_type WHERE name = p ->> 'event';
  IF NOT FOUND OR et.retired THEN
    RAISE EXCEPTION 'audit.record: unknown or retired event' USING ERRCODE = 'FA001';
  END IF;

  -- 3. The login must belong to one of the event's roles.
  IF NOT EXISTS (
    SELECT 1 FROM unnest(et.roles) AS r(name)
    JOIN pg_catalog.pg_roles pr ON pr.rolname = r.name
    WHERE pg_catalog.pg_has_role(session_user, pr.oid, 'MEMBER')
  ) THEN
    RAISE EXCEPTION 'audit.record: this login may not record %', et.name USING ERRCODE = 'FA002';
  END IF;

  -- 4. The scope's fields.
  IF et.scope = 'organisation' AND coalesce(p ->> 'organization_id', '') = '' THEN
    RAISE EXCEPTION 'audit.record: organisation scope needs organization_id' USING ERRCODE = 'FA003';
  END IF;
  IF et.scope = 'person' AND coalesce(p ->> 'subject_user_id', '') = '' THEN
    RAISE EXCEPTION 'audit.record: person scope needs subject_user_id' USING ERRCODE = 'FA003';
  END IF;

  -- 5. Metadata: a flat object of short strings, numbers, booleans, nulls and short arrays of those.
  meta := coalesce(p -> 'metadata', '{}'::jsonb);
  IF jsonb_typeof(meta) <> 'object' OR octet_length(meta::text) > 4096 THEN
    RAISE EXCEPTION 'audit.record: metadata must be an object of at most 4 KB' USING ERRCODE = 'FA004';
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(meta) LOOP
    IF k !~ '^[a-z][A-Za-z0-9_]{0,63}$' THEN
      RAISE EXCEPTION 'audit.record: metadata key shape' USING ERRCODE = 'FA004';
    END IF;
    CASE jsonb_typeof(v)
      WHEN 'string' THEN
        IF char_length(v #>> '{}') > 200 THEN
          RAISE EXCEPTION 'audit.record: metadata string longer than 200' USING ERRCODE = 'FA004';
        END IF;
      WHEN 'number', 'boolean', 'null' THEN
        NULL;
      WHEN 'array' THEN
        IF jsonb_array_length(v) > 50 OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(v) AS e(value)
          WHERE jsonb_typeof(e.value) NOT IN ('string', 'number', 'boolean', 'null')
             OR (jsonb_typeof(e.value) = 'string' AND char_length(e.value #>> '{}') > 200)
        ) THEN
          RAISE EXCEPTION 'audit.record: metadata array shape' USING ERRCODE = 'FA004';
        END IF;
      ELSE
        RAISE EXCEPTION 'audit.record: metadata is flat' USING ERRCODE = 'FA004';
    END CASE;
  END LOOP;

  -- 6. The refs and the ID.
  IF p ? 'ref_ids' AND jsonb_typeof(p -> 'ref_ids') <> 'null' THEN
    IF jsonb_typeof(p -> 'ref_ids') <> 'array' OR jsonb_array_length(p -> 'ref_ids') > 32 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p -> 'ref_ids') AS e(value)
      WHERE jsonb_typeof(e.value) <> 'string' OR char_length(e.value #>> '{}') NOT BETWEEN 1 AND 200
    ) THEN
      RAISE EXCEPTION 'audit.record: ref_ids must be at most 32 IDs' USING ERRCODE = 'FA005';
    END IF;
    refs := ARRAY(SELECT jsonb_array_elements_text(p -> 'ref_ids'));
  END IF;
  IF coalesce(p ->> 'id', '') !~ '^aud_[0-9a-hjkmnp-tv-z]{26}$' THEN
    RAISE EXCEPTION 'audit.record: id shape' USING ERRCODE = 'FA005';
  END IF;

  -- The rest of the input's shape.
  IF coalesce(p ->> 'target_id', '') = '' OR char_length(p ->> 'target_id') > 200 THEN
    RAISE EXCEPTION 'audit.record: target_id is required' USING ERRCODE = 'FA006';
  END IF;
  IF coalesce(p ->> 'release', '') = '' OR char_length(p ->> 'release') > 64 THEN
    RAISE EXCEPTION 'audit.record: release is required' USING ERRCODE = 'FA006';
  END IF;
  IF coalesce(p ->> 'actor_kind', '') NOT IN ('user', 'api_key', 'staff', 'customer_link',
       'person_link', 'system', 'provider', 'operator') THEN
    RAISE EXCEPTION 'audit.record: actor_kind' USING ERRCODE = 'FA006';
  END IF;
  IF coalesce(p ->> 'actor_via', '') NOT IN ('console', 'api', 'hosted_pages', 'admin', 'job',
       'webhook', 'reconciliation', 'operator') THEN
    RAISE EXCEPTION 'audit.record: actor_via' USING ERRCODE = 'FA006';
  END IF;
  IF p ->> 'mode' IS NOT NULL AND p ->> 'mode' NOT IN ('sandbox', 'live') THEN
    RAISE EXCEPTION 'audit.record: mode' USING ERRCODE = 'FA006';
  END IF;
  IF ((p ->> 'step_up_kind') IS NULL) <> ((p ->> 'step_up_method') IS NULL)
     OR ((p ->> 'step_up_kind') IS NULL) <> ((p ->> 'step_up_ref') IS NULL)
     OR coalesce(p ->> 'step_up_kind', 'window') NOT IN ('window', 'intent')
     OR coalesce(p ->> 'step_up_method', 'passkey') NOT IN ('passkey', 'totp', 'backup_code') THEN
    RAISE EXCEPTION 'audit.record: step-up fields come together' USING ERRCODE = 'FA006';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['actor_id', 'actor_key_id', 'actor_link_session_id', 'step_up_ref',
      'organization_id', 'subject_user_id', 'request_id']) AS f(name)
    WHERE char_length(p ->> f.name) > 200
  ) THEN
    RAISE EXCEPTION 'audit.record: an ID longer than 200' USING ERRCODE = 'FA006';
  END IF;
  ctx := p -> 'context';
  IF ctx IS NOT NULL AND jsonb_typeof(ctx) <> 'null' THEN
    IF jsonb_typeof(ctx) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(ctx) AS c(key) WHERE c.key NOT IN ('client_ip', 'user_agent'))
       OR jsonb_typeof(coalesce(ctx -> 'client_ip', 'null')) NOT IN ('string', 'null')
       OR jsonb_typeof(coalesce(ctx -> 'user_agent', 'null')) NOT IN ('string', 'null')
       OR char_length(ctx ->> 'user_agent') > 400 THEN
      RAISE EXCEPTION 'audit.record: context shape' USING ERRCODE = 'FA006';
    END IF;
    BEGIN
      ctx_ip := (ctx ->> 'client_ip')::inet;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'audit.record: context client_ip' USING ERRCODE = 'FA006';
    END;
  ELSE
    ctx := NULL;
  END IF;

  -- 7. The row, with what the database stamps. The epoch is the current head's, held FOR KEY SHARE
  -- until this transaction ends: the lock a foreign key to the head would take, with ROW SHARE on the
  -- table. It never waits on another writer or on the sequencer (FOR NO KEY UPDATE). Only
  -- audit.start_epoch() waits for it (EXCLUSIVE on the table), so no row can still be uncommitted in an
  -- epoch that has ended (§3.9), and a writer that arrives while a start waits queues behind it and
  -- records in the new epoch. A start committing while this waits leaves the old head no longer
  -- current, so the read is retried.
  FOR attempt IN 1..3 LOOP
    SELECT h.epoch INTO cur_epoch FROM audit.head h WHERE h.current FOR KEY SHARE;
    EXIT WHEN cur_epoch IS NOT NULL;
  END LOOP;
  IF cur_epoch IS NULL THEN
    RAISE EXCEPTION 'audit.record: no current epoch' USING ERRCODE = 'FA011';
  END IF;
  INSERT INTO audit.event (id, epoch, event, category, scope, organization_id, subject_user_id, mode,
    actor_kind, actor_id, actor_via, actor_key_id, actor_link_session_id, step_up_kind, step_up_method,
    step_up_ref, target_id, ref_ids, metadata, request_id, release, db_login, app_name, backend_pid,
    xid, recorded_at)
  VALUES (p ->> 'id', cur_epoch, et.name, et.category, et.scope, p ->> 'organization_id',
    p ->> 'subject_user_id', p ->> 'mode', p ->> 'actor_kind', p ->> 'actor_id', p ->> 'actor_via',
    p ->> 'actor_key_id', p ->> 'actor_link_session_id', p ->> 'step_up_kind', p ->> 'step_up_method',
    p ->> 'step_up_ref', p ->> 'target_id', refs, meta, p ->> 'request_id', p ->> 'release',
    session_user, coalesce(pg_catalog.current_setting('application_name', true), ''),
    pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), pg_catalog.statement_timestamp());

  -- 8. The context row, for console and Fin Admin actors only.
  IF ctx IS NOT NULL AND p ->> 'actor_via' IN ('console', 'admin') THEN
    INSERT INTO audit.event_context (event_id, client_ip, user_agent, created_at)
    VALUES (p ->> 'id', ctx_ip, ctx ->> 'user_agent', pg_catalog.statement_timestamp());
  END IF;

  -- 9. Wake the sequencer.
  NOTIFY audit_written;
  RETURN p ->> 'id';
END
$fn$;

-- The guard (§3.5): a deferred constraint trigger per guarded operation checks, at commit, that the
-- same transaction recorded an accepted event naming the row's key. Like audit.append_only(), its
-- search_path holds no schema fin_owner can create objects in, and the bootstrap's guard refuses any
-- later change to it, or to a trigger calling it, but the superuser's.
CREATE FUNCTION audit.require_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  key_value text;
  accepted text[];
BEGIN
  IF TG_NARGS <> 2 THEN
    RAISE EXCEPTION 'audit.require_event takes a key column and an event list' USING ERRCODE = '22023';
  END IF;
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
  -- The table's name only, never the row's values.
  RAISE EXCEPTION 'audit guard: %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'FA010';
END
$fn$;

-- audit.install_guard(table, ops, key column, events): run only by migrations, as fin_owner. A guard's
-- trigger name is made from its operation, key column and events, so installing the same guard again
-- finds it in place and leaves it: a guard, once installed, is changed or removed only by the
-- superuser (040_audit_guard.sql).
CREATE FUNCTION audit.install_guard(p_table regclass, p_ops text[], p_key_column name, p_events text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $fn$
DECLARE
  op text;
  col text;
  ev text;
  trigger_name text;
BEGIN
  IF p_table IS NULL OR p_key_column IS NULL
     OR coalesce(cardinality(p_ops), 0) = 0 OR coalesce(cardinality(p_events), 0) = 0 THEN
    RAISE EXCEPTION 'audit.install_guard: table, operations, key column and events are required'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = p_table AND attname = p_key_column AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'audit.install_guard: % has no column %', p_table, p_key_column USING ERRCODE = '42703';
  END IF;
  FOREACH ev IN ARRAY p_events LOOP
    IF ev IS NULL OR (ev <> '*' AND ev !~ '^[a-z][a-z_]*(\.[a-z][a-z_]*){1,2}$') THEN
      RAISE EXCEPTION 'audit.install_guard: bad event name' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  FOREACH op IN ARRAY p_ops LOOP
    IF op IS NULL OR op !~ '^(INSERT|DELETE|UPDATE|UPDATE OF [a-z_][a-z0-9_]*(, [a-z_][a-z0-9_]*)*)$' THEN
      RAISE EXCEPTION 'audit.install_guard: bad operation %', op USING ERRCODE = '22023';
    END IF;
    IF op LIKE 'UPDATE OF %' THEN
      FOREACH col IN ARRAY string_to_array(substr(op, 11), ', ') LOOP
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute
          WHERE attrelid = p_table AND attname = col AND attnum > 0 AND NOT attisdropped
        ) THEN
          RAISE EXCEPTION 'audit.install_guard: % has no column %', p_table, col USING ERRCODE = '42703';
        END IF;
      END LOOP;
    END IF;
    trigger_name := format('audit_guard_%s_%s_%s',
      lower(split_part(op, ' ', 1)),
      left(p_key_column::text, 30),
      left(md5(op || '|' || p_key_column || '|' || array_to_string(p_events, ',')), 8));
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = p_table AND t.tgname = trigger_name
    );
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER %s ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION audit.require_event(%L, %L)',
      trigger_name, op, p_table, p_key_column, array_to_string(p_events, ','));
  END LOOP;
END
$fn$;

-- The row hash, version 1 (§3.6), recomputed in packages/audit/src/chain.ts. SHA-256 over the fields
-- in order, each as a 4-byte big-endian length and its UTF-8 bytes, a null as FF FF FF FF. Every byte
-- comes from a function, never from a string literal, so no session setting (such as
-- standard_conforming_strings) can change what is hashed.
CREATE FUNCTION audit.row_hash(r audit.event, p_prev_hash bytea) RETURNS bytea
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $fn$
DECLARE
  null_field constant bytea := decode('ffffffff', 'hex');
  buf bytea := ''::bytea;
  f text;
  b bytea;
  head_fields text[];
  fields text[];
BEGIN
  head_fields := ARRAY['fin-audit-v1', r.epoch::text, r.seq::text];
  fields := ARRAY[r.id, r.event, r.category, r.scope, r.organization_id, r.subject_user_id, r.mode,
                  r.actor_kind, r.actor_id, r.actor_via, r.actor_key_id, r.actor_link_session_id,
                  r.step_up_kind, r.step_up_method, r.step_up_ref,
                  r.target_id,
                  cardinality(r.ref_ids)::text]
            || r.ref_ids
            || ARRAY[r.metadata::text,
                     r.request_id, r.release, r.db_login, r.app_name, r.backend_pid::text, r.xid::text,
                     to_char(r.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')];
  FOREACH f IN ARRAY head_fields LOOP
    IF f IS NULL THEN
      buf := buf || null_field;
    ELSE
      b := convert_to(f, 'UTF8');
      buf := buf || int4send(octet_length(b)) || b;
    END IF;
  END LOOP;
  IF p_prev_hash IS NULL THEN
    buf := buf || null_field;
  ELSE
    buf := buf || int4send(octet_length(p_prev_hash)) || p_prev_hash;
  END IF;
  FOREACH f IN ARRAY fields LOOP
    IF f IS NULL THEN
      buf := buf || null_field;
    ELSE
      b := convert_to(f, 'UTF8');
      buf := buf || int4send(octet_length(b)) || b;
    END IF;
  END LOOP;
  RETURN sha256(buf);
END
$fn$;

-- Chains up to p_max (all when null) committed, unchained rows of epoch p_epoch onto that epoch's
-- head, in (xid, id) order, gaplessly, and moves the head. Only committed rows are visible, so a row of
-- an open transaction waits for the next pass. It runs inside audit.sequence() and
-- audit.start_epoch(), as fin_owner (it is SECURITY INVOKER and granted to no one), and takes the head
-- row itself, so a caller that has not locked it still chains under the lock.
CREATE FUNCTION audit.chain_epoch(p_epoch integer, p_max integer) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = audit, pg_temp
AS $fn$
DECLARE
  h audit.head%ROWTYPE;
  r audit.event%ROWTYPE;
  next_seq bigint;
  prev bytea;
  new_hash bytea;
  n integer := 0;
BEGIN
  SELECT * INTO h FROM audit.head WHERE epoch = p_epoch FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit.chain_epoch: no such epoch' USING ERRCODE = 'FA011';
  END IF;
  next_seq := h.seq;
  prev := h.hash;
  FOR r IN
    SELECT * FROM audit.event
    WHERE seq IS NULL AND epoch = p_epoch
    ORDER BY xid, id
    LIMIT p_max
    FOR UPDATE
  LOOP
    next_seq := next_seq + 1;
    r.seq := next_seq;
    new_hash := audit.row_hash(r, prev);
    UPDATE audit.event SET seq = next_seq, prev_hash = prev, hash = new_hash WHERE id = r.id;
    prev := new_hash;
    n := n + 1;
  END LOOP;
  IF n > 0 THEN
    UPDATE audit.head SET seq = next_seq, hash = prev, moved_at = pg_catalog.clock_timestamp()
    WHERE epoch = p_epoch;
  END IF;
  RETURN n;
END
$fn$;

-- The sequencer (§3.6): chains up to p_max committed, unchained rows of the current epoch and moves
-- the head. EXECUTE for fin_worker only. It locks the head FOR NO KEY UPDATE, which writers' FOR KEY
-- SHARE never conflicts with, so a transaction held open never stalls it; like a writer, it queues
-- behind an epoch start, and a start committing while it waits leaves the old head no longer current,
-- so the read is retried.
CREATE FUNCTION audit.sequence(p_max integer DEFAULT 5000) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $fn$
DECLARE
  cur_epoch integer;
BEGIN
  IF p_max IS NULL OR p_max < 1 OR p_max > 50000 THEN
    RAISE EXCEPTION 'audit.sequence: p_max must be between 1 and 50000' USING ERRCODE = '22023';
  END IF;
  FOR attempt IN 1..3 LOOP
    SELECT h.epoch INTO cur_epoch FROM audit.head h WHERE h.current FOR NO KEY UPDATE;
    EXIT WHEN cur_epoch IS NOT NULL;
  END LOOP;
  IF cur_epoch IS NULL THEN
    RAISE EXCEPTION 'audit.sequence: no current epoch' USING ERRCODE = 'FA011';
  END IF;
  RETURN audit.chain_epoch(cur_epoch, p_max);
END
$fn$;

-- Seconds since the oldest unchained row of any epoch, 0 when none: the probe reads it even when the
-- sequencer has stopped (audit-unsequenced). No row is left unchained in an epoch that has ended
-- (audit.start_epoch() chains them first), so a row counted here is always one the sequencer will
-- reach, or one that should page. EXECUTE for fin_probe.
CREATE FUNCTION audit.unsequenced_age() RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $fn$
  SELECT coalesce(
    greatest(0, floor(extract(epoch FROM (pg_catalog.now() - min(e.recorded_at)))))::integer, 0)
  FROM audit.event e
  WHERE e.seq IS NULL
$fn$;

-- A new epoch (§3.9), only through a registered `migrate --task` run as fin_owner. In order, it:
--   1. refuses a start the environment does not allow: the task's FIN_ENVIRONMENT must be the one the
--      bootstrap wrote to ops.environment, and production refuses a reset (FA012);
--   2. locks audit.head IN EXCLUSIVE MODE, which waits until every transaction that recorded a row in
--      the old epoch has ended (audit.record() holds the head FOR KEY SHARE, so ROW SHARE on the table)
--      and holds new ones off until this commits: a writer's ROW SHARE request queues behind the
--      waiting EXCLUSIVE one, where a row lock alone would let each new KEY SHARE locker in ahead of
--      it, without end. That is one lock wait, so its 30-second lock timeout bounds it; readers
--      (ACCESS SHARE) are never held;
--   3. chains the old epoch's remaining committed rows into the old epoch, so none is left outside the
--      chain, and records the head it reached as `previousSeq`;
--   4. inserts the new head (seq 0, hash = p_prev_hash), clears current on the old one, records
--      audit.epoch_started, and chains it at once as the new epoch's first row, so no row of a
--      transaction that waited on this one can come before it.
-- The row's ID, the run ID and the release come from the task, because IDs are made in the
-- application (DA-02).
CREATE FUNCTION audit.start_epoch(p_reason text, p_prev_hash bytea, p_marker_key text,
  p_event_id text, p_run_id text, p_release text, p_environment text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_temp
SET lock_timeout = '30s'
AS $fn$
DECLARE
  old audit.head%ROWTYPE;
  new_epoch integer;
  recorded_rows bigint;
  recorded_environment text;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('restore', 'reset', 'failover') THEN
    RAISE EXCEPTION 'audit.start_epoch: reason must be restore, reset or failover' USING ERRCODE = '22023';
  END IF;
  IF p_prev_hash IS NULL OR octet_length(p_prev_hash) <> 32 THEN
    RAISE EXCEPTION 'audit.start_epoch: the previous hash is 32 bytes' USING ERRCODE = '22023';
  END IF;
  IF p_marker_key IS NULL OR p_marker_key !~ '^ops/(restore|reset|failover)/[A-Za-z0-9._-]{1,120}\.json$' THEN
    RAISE EXCEPTION 'audit.start_epoch: marker key shape' USING ERRCODE = '22023';
  END IF;
  -- The bootstrap's one row, and only it: ONLY leaves out any child table, and anything but exactly
  -- one row is refused rather than read.
  SELECT count(*), min(e.name) INTO recorded_rows, recorded_environment
  FROM ONLY ops.environment e WHERE e.only_row;
  IF recorded_rows <> 1 OR recorded_environment IS NULL THEN
    RAISE EXCEPTION 'audit.start_epoch: the bootstrap recorded no environment' USING ERRCODE = 'FA012';
  END IF;
  IF p_environment IS DISTINCT FROM recorded_environment THEN
    RAISE EXCEPTION 'audit.start_epoch: the task names another environment than this database''s'
      USING ERRCODE = 'FA012';
  END IF;
  IF p_reason = 'reset' AND recorded_environment = 'production' THEN
    RAISE EXCEPTION 'audit.start_epoch: production refuses a reset' USING ERRCODE = 'FA012';
  END IF;
  LOCK TABLE audit.head IN EXCLUSIVE MODE;
  SELECT * INTO old FROM audit.head WHERE current FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit.start_epoch: no current epoch' USING ERRCODE = 'FA011';
  END IF;
  PERFORM audit.chain_epoch(old.epoch, NULL);
  SELECT * INTO old FROM audit.head WHERE epoch = old.epoch;
  SELECT max(epoch) + 1 INTO new_epoch FROM audit.head;
  UPDATE audit.head SET current = false WHERE epoch = old.epoch;
  INSERT INTO audit.head (epoch, seq, hash, moved_at, started_at, start_reason, start_prev_hash, marker_key, current)
  VALUES (new_epoch, 0, p_prev_hash, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
          p_reason, p_prev_hash, p_marker_key, true);
  PERFORM audit.record(jsonb_build_object(
    'id', p_event_id,
    'event', 'audit.epoch_started',
    'actor_kind', 'operator',
    'actor_id', p_run_id,
    'actor_via', 'operator',
    'target_id', 'epoch:' || new_epoch,
    'metadata', jsonb_build_object('reason', p_reason, 'previousEpoch', old.epoch,
                                   'previousSeq', old.seq, 'markerKey', p_marker_key),
    'release', p_release));
  PERFORM audit.chain_epoch(new_epoch, NULL);
  RETURN new_epoch;
END
$fn$;

REVOKE ALL ON FUNCTION audit.append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.record(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.require_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.install_guard(regclass, text[], name, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.row_hash(audit.event, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.chain_epoch(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.sequence(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.unsequenced_age() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.start_epoch(text, bytea, text, text, text, text, text) FROM PUBLIC;
