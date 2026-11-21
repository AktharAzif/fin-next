-- 040_audit_guard.sql: the superuser's guard on the audit trail's protections (spec 08 §3.3, §3.5;
-- AC-P0-11 "no role can update or delete audit rows"; ARCHITECTURE §8.3). Run by `migrate --bootstrap`
-- as the superuser.
--
-- fin_owner owns the audit tables, their trigger functions and every guarded table, because it runs
-- the migrations that create them. Without this, a fin_owner session could switch a protection off
-- with DDL and then change rows, or change what the rows say without touching them: disable,
-- re-target or drop an append-only or guard trigger, replace the function it calls, rename a column
-- and add another under its name (or swap two), put a generated column, a rule, a policy or a child
-- table in front of the rows, drop the unique index that keeps one row per chain position, rewrite a
-- column with ALTER ... TYPE ... USING, drop a column or the table, or rename a guarded table's key
-- column so its guard checks a column of fin_owner's choosing. These event triggers refuse each of
-- those for anyone but a superuser.
--
-- The record (ops_guard.protected_*), kept by name, never by OID or column number, so it still holds
-- after a logical restore:
--   - the protected functions, audit.append_only() (the append-only triggers) and
--     audit.require_event() (the guards, §3.5), with their definitions, when they first exist;
--   - every trigger that calls one, with its definition and enabled state, when it is created (by a
--     migration, as fin_owner);
--   - the shape of every audit table (a table carrying an append-only trigger), when its first one is
--     created: each column's type, collation, not-null, default or generation expression and
--     identity; its constraints and unique indexes; whether it has row-level security, and its
--     policies, rules, inheritance parents and children (partitions included), and other triggers.
-- After any DDL command by anyone else:
--   - every recorded function and trigger still exists exactly as recorded, enabled as recorded (so a
--     drop, a rename, a disable, a replacement or a re-targeting is refused, and the table it sits on
--     cannot be dropped);
--   - every audit table still has every recorded column, constraint and live unique index exactly as
--     recorded, and nothing else about it has changed. A rename always leaves a recorded name missing
--     when its command ends, so no rename, swap or rename-and-add passes. The table may gain a plain
--     column (no default, not generated, not an identity), a constraint or a unique index, which then
--     joins the record, and any index that is not unique;
--   - the column each guard names as its key still exists and is not generated;
--   - an audit table is never rewritten and never loses a column.
-- A refusal rolls the command back, except the steps a CONCURRENTLY command has already committed: a
-- refused DROP INDEX CONCURRENTLY leaves its index dead. So the uniqueness an audit table relies on is
-- held by constraints (the migrations add their unique indexes as constraints), whose indexes DROP
-- INDEX refuses before it starts; a dead unique index of the record is refused at the next command.
-- A superuser's DDL is allowed and becomes the new record, so only the superuser can change a
-- protection on purpose (a later change to one is a registered superuser run, not a migration). After a
-- major-version upgrade, which may print definitions differently, the superuser runs
-- `SELECT ops_guard.record_audit_protections()`.
--
-- A guarded business table (identity, keys, money) stays fin_owner's to migrate: only its guards and
-- their key columns are held here. Its rows are changed by the migrations fin_owner runs, which are
-- reviewed, logged statement by statement and recorded by the privileged-login record (ARCHITECTURE
-- §6.3); the guard there is against a leaked service login.

CREATE TABLE IF NOT EXISTS ops_guard.protected_function (
  identity   text PRIMARY KEY,   -- regprocedure text: audit.append_only()
  definition text NOT NULL       -- pg_get_functiondef()
);
CREATE TABLE IF NOT EXISTS ops_guard.protected_trigger (
  table_name   text NOT NULL,    -- regclass text: audit.event
  trigger_name name NOT NULL,
  append_only  boolean NOT NULL, -- it calls audit.append_only(): its table holds audit rows
  definition   text NOT NULL,    -- pg_get_triggerdef()
  enabled      "char" NOT NULL,  -- pg_trigger.tgenabled
  PRIMARY KEY (table_name, trigger_name)
);
CREATE TABLE IF NOT EXISTS ops_guard.protected_table (
  table_name text PRIMARY KEY,   -- regclass text: audit.event
  shape      jsonb NOT NULL      -- ops_guard.audit_table_shape()
);
REVOKE ALL ON ops_guard.protected_function FROM PUBLIC;
REVOKE ALL ON ops_guard.protected_trigger FROM PUBLIC;
REVOKE ALL ON ops_guard.protected_table FROM PUBLIC;

-- What DDL could change about an audit table that would change what its rows say, or who sees them.
-- Every part is keyed or sorted by name, so equal shapes compare equal whatever the catalog order.
CREATE OR REPLACE FUNCTION ops_guard.audit_table_shape(p_table oid) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT pg_catalog.jsonb_build_object(
    'kind', c.relkind::text,
    'rowSecurity', c.relrowsecurity,
    'forceRowSecurity', c.relforcerowsecurity,
    'columns', coalesce((
      SELECT pg_catalog.jsonb_object_agg(a.attname, pg_catalog.jsonb_build_object(
        'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
        'collation', (
          SELECT pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname)
          FROM pg_catalog.pg_collation co
          JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
          WHERE co.oid = a.attcollation),
        'notNull', a.attnotnull,
        'default', pg_catalog.pg_get_expr(d.adbin, d.adrelid),
        'generated', a.attgenerated::text,
        'identity', a.attidentity::text))
      FROM pg_catalog.pg_attribute a
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '{}'::jsonb),
    'constraints', coalesce((
      SELECT pg_catalog.jsonb_object_agg(k.conname, pg_catalog.pg_get_constraintdef(k.oid))
      FROM pg_catalog.pg_constraint k
      WHERE k.conrelid = c.oid), '{}'::jsonb),
    -- Only a live index counts, so one left dead (by a DROP INDEX CONCURRENTLY refused at its end,
    -- after its first steps committed) is missing from the shape and refused at the next command.
    'uniqueIndexes', coalesce((
      SELECT pg_catalog.jsonb_object_agg(ic.relname, pg_catalog.pg_get_indexdef(i.indexrelid))
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = c.oid AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive),
      '{}'::jsonb),
    'policies', coalesce((
      SELECT pg_catalog.jsonb_object_agg(p.polname, pg_catalog.jsonb_build_object(
        'command', p.polcmd::text,
        'permissive', p.polpermissive,
        'roles', (
          SELECT pg_catalog.jsonb_agg(s.name ORDER BY s.name)
          FROM (
            SELECT CASE WHEN r.role_oid = 0 THEN 'public'
                        ELSE pg_catalog.pg_get_userbyid(r.role_oid)::text END AS name
            FROM pg_catalog.unnest(p.polroles) AS r(role_oid)) s),
        'using', pg_catalog.pg_get_expr(p.polqual, p.polrelid),
        'check', pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)))
      FROM pg_catalog.pg_policy p
      WHERE p.polrelid = c.oid), '{}'::jsonb),
    'rules', coalesce((
      SELECT pg_catalog.jsonb_object_agg(w.rulename, pg_catalog.jsonb_build_object(
        'definition', pg_catalog.pg_get_ruledef(w.oid),
        'enabled', w.ev_enabled::text))
      FROM pg_catalog.pg_rewrite w
      WHERE w.ev_class = c.oid), '{}'::jsonb),
    'parents', coalesce((
      SELECT pg_catalog.jsonb_agg(s.name ORDER BY s.name)
      FROM (
        SELECT i.inhparent::pg_catalog.regclass::text AS name
        FROM pg_catalog.pg_inherits i
        WHERE i.inhrelid = c.oid) s), '[]'::jsonb),
    'children', coalesce((
      SELECT pg_catalog.jsonb_agg(s.name ORDER BY s.name)
      FROM (
        SELECT i.inhrelid::pg_catalog.regclass::text AS name
        FROM pg_catalog.pg_inherits i
        WHERE i.inhparent = c.oid) s), '[]'::jsonb),
    -- The protected triggers are recorded on their own; any other (but a foreign key's) is here.
    'triggers', coalesce((
      SELECT pg_catalog.jsonb_object_agg(t.tgname, pg_catalog.jsonb_build_object(
        'definition', pg_catalog.pg_get_triggerdef(t.oid),
        'enabled', t.tgenabled::text))
      FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
        AND t.tgfoid IS DISTINCT FROM pg_catalog.to_regprocedure('audit.append_only()')::oid
        AND t.tgfoid IS DISTINCT FROM pg_catalog.to_regprocedure('audit.require_event()')::oid),
      '{}'::jsonb))
  FROM pg_catalog.pg_class c
  WHERE c.oid = p_table
$fn$;
REVOKE ALL ON FUNCTION ops_guard.audit_table_shape(oid) FROM PUBLIC;

-- How an audit table's current shape differs from its record, or null when the change is allowed:
-- every recorded column, constraint and unique index still there exactly as recorded, nothing else
-- changed, and every column added since a plain one.
CREATE OR REPLACE FUNCTION ops_guard.audit_table_change(p_recorded jsonb, p_current jsonb) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE
    WHEN p_current IS NULL THEN 'the table is gone'
    WHEN (p_current - 'columns' - 'constraints' - 'uniqueIndexes')
         IS DISTINCT FROM (p_recorded - 'columns' - 'constraints' - 'uniqueIndexes')
      THEN 'its row-level security, policies, rules, inheritance or other triggers changed'
    WHEN NOT (p_current -> 'columns') @> (p_recorded -> 'columns')
      THEN 'a column was renamed, dropped or changed'
    WHEN NOT (p_current -> 'constraints') @> (p_recorded -> 'constraints')
      THEN 'a constraint was dropped or changed'
    WHEN NOT (p_current -> 'uniqueIndexes') @> (p_recorded -> 'uniqueIndexes')
      THEN 'a unique index was dropped or changed'
    WHEN EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_each(p_current -> 'columns') AS added(name, descriptor)
      WHERE NOT (p_recorded -> 'columns') ? added.name
        AND (added.descriptor ->> 'default' IS NOT NULL
             OR added.descriptor ->> 'generated' <> ''
             OR added.descriptor ->> 'identity' <> ''))
      THEN 'a column was added with a default, a generation expression or an identity'
  END
$fn$;
REVOKE ALL ON FUNCTION ops_guard.audit_table_change(jsonb, jsonb) FROM PUBLIC;

-- Makes the record what the database holds now: the two functions, every trigger calling one, and the
-- shape of every table carrying an append-only trigger. A superuser's DDL calls it, the bootstrap
-- calls it below, and after a major-version upgrade the superuser runs it by hand.
CREATE OR REPLACE FUNCTION ops_guard.record_audit_protections() RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  append_only_fn oid := pg_catalog.to_regprocedure('audit.append_only()');
  guard_fn oid := pg_catalog.to_regprocedure('audit.require_event()');
BEGIN
  DELETE FROM ops_guard.protected_function;
  INSERT INTO ops_guard.protected_function (identity, definition)
  SELECT f.oid::pg_catalog.regprocedure::text, pg_catalog.pg_get_functiondef(f.oid)
  FROM pg_catalog.pg_proc f
  WHERE f.oid = append_only_fn OR f.oid = guard_fn;

  DELETE FROM ops_guard.protected_trigger;
  INSERT INTO ops_guard.protected_trigger (table_name, trigger_name, append_only, definition, enabled)
  SELECT t.tgrelid::pg_catalog.regclass::text, t.tgname, t.tgfoid IS NOT DISTINCT FROM append_only_fn,
         pg_catalog.pg_get_triggerdef(t.oid), t.tgenabled
  FROM pg_catalog.pg_trigger t
  WHERE t.tgfoid = append_only_fn OR t.tgfoid = guard_fn;

  DELETE FROM ops_guard.protected_table;
  INSERT INTO ops_guard.protected_table (table_name, shape)
  SELECT r.rel::pg_catalog.regclass::text, ops_guard.audit_table_shape(r.rel)
  FROM (SELECT DISTINCT t.tgrelid AS rel FROM pg_catalog.pg_trigger t WHERE t.tgfoid = append_only_fn) r;
END
$fn$;
REVOKE ALL ON FUNCTION ops_guard.record_audit_protections() FROM PUBLIC;

CREATE OR REPLACE FUNCTION ops_guard.guard_audit_protections() RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  superuser boolean;
  append_only_fn oid := pg_catalog.to_regprocedure('audit.append_only()');
  guard_fn oid := pg_catalog.to_regprocedure('audit.require_event()');
  dropped record;
  audit_table record;
  change text;
  unkeyed text;
BEGIN
  superuser := EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = session_user AND r.rolsuper
  );

  IF TG_EVENT = 'table_rewrite' THEN
    IF NOT superuser AND EXISTS (
      SELECT 1 FROM ops_guard.protected_table p
      WHERE pg_catalog.to_regclass(p.table_name) = pg_catalog.pg_event_trigger_table_rewrite_oid()
    ) THEN
      RAISE EXCEPTION 'an append-only audit table can be rewritten only by the superuser'
        USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;

  IF TG_EVENT = 'sql_drop' THEN
    -- A dropped column of an audit table. Dropped triggers, functions, constraints and indexes, and
    -- dropped tables with their triggers, are found missing at the command's end, below.
    IF superuser THEN
      RETURN;
    END IF;
    FOR dropped IN SELECT * FROM pg_catalog.pg_event_trigger_dropped_objects() LOOP
      IF dropped.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND dropped.objsubid > 0
         AND EXISTS (
           SELECT 1 FROM ops_guard.protected_table p
           WHERE pg_catalog.to_regclass(p.table_name) = dropped.objid
         ) THEN
        RAISE EXCEPTION 'a column of an append-only audit table can be dropped only by the superuser'
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
    RETURN;
  END IF;

  -- ddl_command_end. A grant, a revoke or a comment changes nothing the record holds, and the
  -- migration runner's grants are most of a run's DDL, so a command made only of those is let through
  -- unchecked (a command the event reports nothing for is checked like any other).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger_ddl_commands())
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_event_trigger_ddl_commands() c
       WHERE c.command_tag NOT IN ('GRANT', 'REVOKE', 'COMMENT')
     ) THEN
    RETURN;
  END IF;

  -- The superuser's change is the new record.
  IF superuser THEN
    PERFORM ops_guard.record_audit_protections();
    RETURN;
  END IF;

  -- What a migration creates joins the record the first time: each protected function, each trigger
  -- calling one, and the shape of a table that has just gained its first append-only trigger.
  INSERT INTO ops_guard.protected_function (identity, definition)
  SELECT f.oid::pg_catalog.regprocedure::text, pg_catalog.pg_get_functiondef(f.oid)
  FROM pg_catalog.pg_proc f
  WHERE f.oid = append_only_fn OR f.oid = guard_fn
  ON CONFLICT (identity) DO NOTHING;
  INSERT INTO ops_guard.protected_trigger (table_name, trigger_name, append_only, definition, enabled)
  SELECT t.tgrelid::pg_catalog.regclass::text, t.tgname, t.tgfoid IS NOT DISTINCT FROM append_only_fn,
         pg_catalog.pg_get_triggerdef(t.oid), t.tgenabled
  FROM pg_catalog.pg_trigger t
  WHERE t.tgfoid = append_only_fn OR t.tgfoid = guard_fn
  ON CONFLICT (table_name, trigger_name) DO NOTHING;
  INSERT INTO ops_guard.protected_table (table_name, shape)
  SELECT r.name, ops_guard.audit_table_shape(r.rel)
  FROM (
    SELECT DISTINCT t.tgrelid AS rel, t.tgrelid::pg_catalog.regclass::text AS name
    FROM pg_catalog.pg_trigger t
    WHERE t.tgfoid = append_only_fn
  ) r
  WHERE NOT EXISTS (SELECT 1 FROM ops_guard.protected_table p WHERE p.table_name = r.name)
  ON CONFLICT (table_name) DO NOTHING;

  IF EXISTS (
    SELECT 1 FROM ops_guard.protected_trigger p
    LEFT JOIN pg_catalog.pg_trigger t
      ON t.tgrelid = pg_catalog.to_regclass(p.table_name) AND t.tgname = p.trigger_name
    WHERE t.oid IS NULL
       OR t.tgenabled <> p.enabled
       OR pg_catalog.pg_get_triggerdef(t.oid) IS DISTINCT FROM p.definition
  ) OR EXISTS (
    SELECT 1 FROM ops_guard.protected_function f
    WHERE pg_catalog.to_regprocedure(f.identity) IS NULL
       OR pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(f.identity))
          IS DISTINCT FROM f.definition
  ) THEN
    RAISE EXCEPTION 'the audit trail''s protections can be changed only by the superuser'
      USING ERRCODE = '42501';
  END IF;

  -- Each audit table: refused unless the change only added to it; an addition joins the record.
  FOR audit_table IN
    SELECT p.table_name, p.shape AS recorded,
           ops_guard.audit_table_shape(pg_catalog.to_regclass(p.table_name)) AS current
    FROM ops_guard.protected_table p
  LOOP
    change := ops_guard.audit_table_change(audit_table.recorded, audit_table.current);
    IF change IS NOT NULL THEN
      RAISE EXCEPTION 'an audit table''s shape can be changed only by the superuser (%: %)',
        audit_table.table_name, change USING ERRCODE = '42501';
    END IF;
    IF audit_table.current IS DISTINCT FROM audit_table.recorded THEN
      UPDATE ops_guard.protected_table SET shape = audit_table.current
      WHERE table_name = audit_table.table_name;
    END IF;
  END LOOP;

  -- Each guard's key column (its first argument): a rename would leave the guard checking whatever
  -- column then holds the name, and a generated one whatever its expression says.
  SELECT p.table_name INTO unkeyed
  FROM ops_guard.protected_trigger p
  JOIN pg_catalog.pg_trigger t
    ON t.tgrelid = pg_catalog.to_regclass(p.table_name) AND t.tgname = p.trigger_name
  WHERE t.tgfoid = guard_fn AND t.tgnargs >= 1
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = t.tgrelid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
        AND a.attname::text = pg_catalog.convert_from(
          pg_catalog.substring(t.tgargs, 1,
            greatest(pg_catalog.position(t.tgargs, pg_catalog.decode('00', 'hex')) - 1, 0)),
          'UTF8'))
  LIMIT 1;
  IF unkeyed IS NOT NULL THEN
    RAISE EXCEPTION 'the key column of an audit guard on % can be renamed, dropped or replaced only by the superuser',
      unkeyed USING ERRCODE = '42501';
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION ops_guard.guard_audit_protections() FROM PUBLIC;

DROP EVENT TRIGGER IF EXISTS fin_audit_guard_change;
CREATE EVENT TRIGGER fin_audit_guard_change ON ddl_command_end
  EXECUTE FUNCTION ops_guard.guard_audit_protections();

DROP EVENT TRIGGER IF EXISTS fin_audit_guard_drop;
CREATE EVENT TRIGGER fin_audit_guard_drop ON sql_drop
  EXECUTE FUNCTION ops_guard.guard_audit_protections();

DROP EVENT TRIGGER IF EXISTS fin_audit_guard_rewrite;
CREATE EVENT TRIGGER fin_audit_guard_rewrite ON table_rewrite
  EXECUTE FUNCTION ops_guard.guard_audit_protections();

-- The superuser vouches for what is there now: on a database migrated before this file changed, the
-- record is taken here rather than at fin_owner's next DDL.
SELECT ops_guard.record_audit_protections();
