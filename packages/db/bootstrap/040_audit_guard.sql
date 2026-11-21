-- 040_audit_guard.sql: the superuser's guard on the audit trail's own protections (spec 08 §3.3, §3.5;
-- AC-P0-11 "no role can update or delete audit rows"; ARCHITECTURE §8.3). Run by `migrate --bootstrap`
-- as the superuser.
--
-- fin_owner owns the audit tables, their trigger functions and every guarded table, because it runs
-- the migrations that create them. Without this, a fin_owner session could switch a protection off
-- with DDL and then change rows: disable, re-target or drop an append-only or guard trigger, replace
-- the function it calls, rewrite a column with ALTER ... TYPE ... USING, or drop a column or the table.
-- These event triggers refuse each of those for anyone but a superuser:
--   - the protected functions are audit.append_only() (the append-only triggers) and
--     audit.require_event() (the guards, §3.5). Each is recorded in ops_guard.protected_function with
--     its definition when it first exists, and every trigger that calls one in
--     ops_guard.protected_trigger with its definition and enabled state, when it is created (by a
--     migration, as fin_owner). Records are kept by name, not OID, so they still hold after a logical
--     restore or a major-version upgrade;
--   - after any DDL command by anyone else, every recorded function and trigger must still exist
--     exactly as recorded, enabled as recorded (so a drop, a rename, a disable, a replacement or a
--     re-targeting is refused, and the table it sits on cannot be dropped);
--   - a table carrying an append-only trigger may not be rewritten or lose a column, except by a
--     superuser;
--   - a superuser's DDL is allowed and becomes the new record, so only the superuser can change a
--     protection on purpose (a later change to one is a registered superuser run, not a migration).
-- Adding is never refused: new tables, functions, columns, indexes and guards.

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
REVOKE ALL ON ops_guard.protected_function FROM PUBLIC;
REVOKE ALL ON ops_guard.protected_trigger FROM PUBLIC;

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
BEGIN
  superuser := EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = session_user AND r.rolsuper
  );

  IF TG_EVENT = 'table_rewrite' THEN
    IF NOT superuser AND EXISTS (
      SELECT 1 FROM ops_guard.protected_trigger p
      WHERE p.append_only
        AND pg_catalog.to_regclass(p.table_name) = pg_catalog.pg_event_trigger_table_rewrite_oid()
    ) THEN
      RAISE EXCEPTION 'an append-only audit table can be rewritten only by the superuser'
        USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;

  IF TG_EVENT = 'sql_drop' THEN
    -- A dropped column of an append-only table. Dropped triggers and functions, and dropped tables
    -- with their triggers, are found missing at the command's end, below.
    IF superuser THEN
      RETURN;
    END IF;
    FOR dropped IN SELECT * FROM pg_catalog.pg_event_trigger_dropped_objects() LOOP
      IF dropped.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND dropped.objsubid > 0
         AND EXISTS (
           SELECT 1 FROM ops_guard.protected_trigger p
           WHERE p.append_only AND pg_catalog.to_regclass(p.table_name) = dropped.objid
         ) THEN
        RAISE EXCEPTION 'a column of an append-only audit table can be dropped only by the superuser'
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
    RETURN;
  END IF;

  -- ddl_command_end: record each protected function and each trigger calling one, the first time.
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

  IF superuser THEN
    -- The superuser's change is the new record.
    DELETE FROM ops_guard.protected_trigger p
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = pg_catalog.to_regclass(p.table_name) AND t.tgname = p.trigger_name
    );
    UPDATE ops_guard.protected_trigger p
    SET definition = pg_catalog.pg_get_triggerdef(t.oid), enabled = t.tgenabled,
        append_only = t.tgfoid IS NOT DISTINCT FROM append_only_fn
    FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = pg_catalog.to_regclass(p.table_name) AND t.tgname = p.trigger_name
      AND (p.definition, p.enabled) IS DISTINCT FROM (pg_catalog.pg_get_triggerdef(t.oid), t.tgenabled);
    DELETE FROM ops_guard.protected_function f
    WHERE pg_catalog.to_regprocedure(f.identity) IS NULL;
    UPDATE ops_guard.protected_function f
    SET definition = pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(f.identity))
    WHERE f.definition IS DISTINCT FROM pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(f.identity));
    RETURN;
  END IF;

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
