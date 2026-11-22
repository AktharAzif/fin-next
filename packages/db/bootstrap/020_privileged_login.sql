-- 020_privileged_login.sql: the privileged-login record and its guards (spec 01 §6.10 row 2;
-- ARCHITECTURE §6.3; DECISIONS DA-03, P-19, AU-08). Run by `migrate --bootstrap` as the superuser.
--
-- What this protects against: a login as the superuser or fin_owner outside a registered run. The
-- record must survive that login, so:
--   - ops.privileged_login is owned by the superuser (not by fin_owner, the login it watches), has no
--     privilege for anyone but fin_worker's SELECT, and refuses UPDATE, DELETE and TRUNCATE by trigger;
--   - its rows come only from the `login` event trigger's SECURITY DEFINER function, which returns at
--     once on a standby and for every login it does not watch (the services);
--   - a superuser login is never refused, whatever fails (P-19: Patroni and break-glass must always get
--     in, and a superuser can skip the trigger with `event_triggers = off` anyway);
--   - a fin_owner login whose record cannot be written is refused. fin_owner is the login the record
--     exists to watch, and a client chooses its session settings in the startup packet: a read-only
--     start (`default_transaction_read_only`) or a short lock timeout would make the insert fail, and a
--     swallowed failure would let the login in unrecorded. The one exception is a record that is not
--     installed (the table or its schema gone), which only the superuser can bring about;
--   - the function writes only the bootstrap's own table (ops_guard.is_bootstrap_table), checked under
--     the lock its insert takes, so the table checked is the table written. While the record is gone,
--     fin_owner (which owns `ops`) can make a table of its name, and the function runs as the
--     superuser: writing that table would run fin_owner's trigger or rule with the superuser's rights.
--     Such a table is never written: a superuser's login goes ahead unrecorded, a fin_owner login is
--     refused;
--   - the function pins its own lock timeout, so a lock held on the table (a foreign key being created,
--     a superuser's maintenance) delays a login by at most a second instead of blocking it;
--   - every function here lives in ops_guard, a schema the superuser owns. fin_owner owns `ops`, and
--     the owner of a schema may drop any object in it; were these functions in `ops`, fin_owner could
--     `DROP FUNCTION ... CASCADE` and take the event triggers with them;
--   - an event trigger refuses, for anyone but a superuser, any DROP that takes the superuser's tables in
--     `ops` (this record and ops.environment, 030) or anything in ops_guard, and any ALTER of those
--     tables or of the schema holding them (a rename would send the inserts nowhere);
--   - the bootstrap adopts a table in `ops` only if it made it (ops_guard.assert_bootstrap_table).
--     fin_owner owns `ops`, so a table of this name it created first (before the bootstrap, or after
--     the superuser dropped the real one) could carry a child table, row-level security and a policy,
--     a rule or a trigger of fin_owner's, all of which an ownership change would keep: a rule
--     `DO INSTEAD NOTHING` would send every login record nowhere. The check is made after
--     `CREATE TABLE IF NOT EXISTS`, on the table the bootstrap then adopts: checked first, a table
--     fin_owner made between the check and the create would be adopted unchecked.
-- The disable path (`event_triggers = off`, superuser only) is in the restore and incident runbooks.
-- A superuser inspects a table fin_owner may have made through the catalog only, never by reading or
-- writing it, which could run fin_owner's code with the superuser's rights.

CREATE SCHEMA IF NOT EXISTS ops_guard;
DO $owner$
BEGIN
  EXECUTE format('ALTER SCHEMA ops_guard OWNER TO %I', current_user);
END
$owner$;
REVOKE ALL ON SCHEMA ops_guard FROM PUBLIC;

-- Whether a relation is a table the bootstrap made: a plain table owned by a superuser (only a
-- superuser can make a table a superuser's), with no inheritance parent or child, no row-level
-- security, policy or rule, and no trigger but the bootstrap's own (functions in ops_guard, which only
-- the superuser can create). Writing such a table runs no code but the superuser's.
CREATE OR REPLACE FUNCTION ops_guard.is_bootstrap_table(p_rel oid) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT EXISTS (
           SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
           WHERE c.oid = p_rel AND c.relkind = 'r' AND r.rolsuper
             AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
     AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = p_rel OR i.inhparent = p_rel)
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = p_rel)
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite w WHERE w.ev_class = p_rel)
     AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc f ON f.oid = t.tgfoid
           WHERE t.tgrelid = p_rel AND NOT t.tgisinternal
             AND f.pronamespace IS DISTINCT FROM pg_catalog.to_regnamespace('ops_guard'))
$fn$;
REVOKE ALL ON FUNCTION ops_guard.is_bootstrap_table(oid) FROM PUBLIC;

-- Refuses a table the bootstrap did not make, or a missing one. Run right after the bootstrap's
-- `CREATE TABLE IF NOT EXISTS`, so the table checked is the table it adopts: fin_owner cannot drop,
-- alter or replace a superuser's table in `ops` (the guard below), and a table of its own fails here.
CREATE OR REPLACE FUNCTION ops_guard.assert_bootstrap_table(p_table text) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  rel oid := pg_catalog.to_regclass(p_table);
BEGIN
  IF rel IS NULL THEN
    RAISE EXCEPTION '% is missing after the bootstrap created it: bootstrap again', p_table
      USING ERRCODE = '42501';
  END IF;
  IF NOT ops_guard.is_bootstrap_table(rel) THEN
    RAISE EXCEPTION '% exists but is not the bootstrap''s own table: a superuser inspects it through the catalog and drops it, then bootstraps again',
      p_table USING ERRCODE = '42501';
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION ops_guard.assert_bootstrap_table(text) FROM PUBLIC;

CREATE TABLE IF NOT EXISTS ops.privileged_login (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  login_role       text NOT NULL,
  application_name text,
  client_addr      inet,
  backend_pid      integer NOT NULL,
  logged_in_at     timestamptz NOT NULL
);
SELECT ops_guard.assert_bootstrap_table('ops.privileged_login');
DO $owner$
BEGIN
  EXECUTE format('ALTER TABLE ops.privileged_login OWNER TO %I', current_user);
END
$owner$;
REVOKE ALL ON ops.privileged_login FROM PUBLIC;
-- ops.privileged_login_check (fin_owner's, in the ops core migration) references these rows. Creating
-- that foreign key locks this table for the migration's transaction; the login function's own lock
-- timeout bounds what that lock can do to a login.
GRANT REFERENCES (id) ON ops.privileged_login TO fin_owner;

CREATE OR REPLACE FUNCTION ops_guard.refuse_privileged_login_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'ops.privileged_login is append-only' USING ERRCODE = '42501';
END
$fn$;

CREATE OR REPLACE TRIGGER privileged_login_append_only
  BEFORE UPDATE OR DELETE ON ops.privileged_login
  FOR EACH ROW EXECUTE FUNCTION ops_guard.refuse_privileged_login_change();
CREATE OR REPLACE TRIGGER privileged_login_no_truncate
  BEFORE TRUNCATE ON ops.privileged_login
  FOR EACH STATEMENT EXECUTE FUNCTION ops_guard.refuse_privileged_login_change();

-- The guarded login trigger (P-19). Whether the login is fin_owner's is decided first, by a comparison
-- that cannot fail, so no later error can turn a watched login into an unwatched one. Every other
-- failure is caught: a superuser's login goes ahead (logged at LOG level), a fin_owner login is refused.
-- It writes the record only once it holds the insert's lock on it and has found it the bootstrap's own:
-- the table cannot be dropped or renamed while that lock is held, so the insert writes the table
-- checked. A table of the name that is not the bootstrap's own is never written, and so none of its
-- code runs with this function's (the superuser's) rights.
CREATE OR REPLACE FUNCTION ops_guard.record_privileged_login() RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '1s'
AS $fn$
DECLARE
  watched boolean := false;
  failure text;
BEGIN
  BEGIN
    watched := session_user = 'fin_owner';
    IF pg_catalog.pg_is_in_recovery() THEN
      RETURN;
    END IF;
    IF NOT watched AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = session_user AND r.rolsuper
    ) THEN
      RETURN;
    END IF;
    LOCK TABLE ONLY ops.privileged_login IN ROW EXCLUSIVE MODE;
    IF NOT coalesce(
         ops_guard.is_bootstrap_table(pg_catalog.to_regclass('ops.privileged_login')), false) THEN
      RAISE EXCEPTION 'ops.privileged_login is not the bootstrap''s own table' USING ERRCODE = '42501';
    END IF;
    INSERT INTO ops.privileged_login (login_role, application_name, client_addr, backend_pid, logged_in_at)
    VALUES (
      session_user,
      pg_catalog.left(pg_catalog.current_setting('application_name', true), 64),
      pg_catalog.inet_client_addr(),
      pg_catalog.pg_backend_pid(),
      pg_catalog.clock_timestamp()
    );
    RETURN;
  EXCEPTION
    WHEN undefined_table OR invalid_schema_name THEN
      -- The record is not installed: only the superuser can drop or move it (the guard below).
      failure := SQLSTATE;
      watched := false;
    WHEN OTHERS THEN
      failure := SQLSTATE;
  END;
  BEGIN
    RAISE LOG 'fin: privileged login not recorded (SQLSTATE %)', failure;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  IF watched THEN
    RAISE EXCEPTION 'fin: a fin_owner login whose record cannot be written is refused'
      USING ERRCODE = '42501';
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION ops_guard.refuse_privileged_login_ddl() RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  obj record;
  guarded_tables constant text[] := ARRAY['privileged_login', 'environment'];
  guarded_oids oid[];
  guarded_schemas oid[];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = session_user AND r.rolsuper) THEN
    RETURN;
  END IF;
  IF TG_EVENT = 'sql_drop' THEN
    FOR obj IN SELECT * FROM pg_catalog.pg_event_trigger_dropped_objects() LOOP
      IF (obj.schema_name = 'ops' AND obj.object_name = ANY (guarded_tables))
         OR obj.schema_name = 'ops_guard'
         OR (obj.object_type = 'schema' AND obj.object_name IN ('ops', 'ops_guard')) THEN
        RAISE EXCEPTION 'the superuser''s tables in ops and their guards can be dropped only by the superuser'
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
  ELSE
    -- The superuser's tables, and the schema holding them, found by owner and name (a rename of the
    -- schema is one of the things this refuses, so the schema's name cannot be relied on here).
    SELECT pg_catalog.array_agg(c.oid), pg_catalog.array_agg(DISTINCT c.relnamespace)
      INTO guarded_oids, guarded_schemas
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE c.relname = ANY (guarded_tables) AND c.relkind = 'r' AND r.rolsuper;
    FOR obj IN SELECT * FROM pg_catalog.pg_event_trigger_ddl_commands() LOOP
      IF obj.schema_name = 'ops_guard'
         OR (obj.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
             AND (obj.objid = ANY (guarded_schemas) OR obj.object_identity = 'ops_guard'))
         OR (obj.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
             AND obj.objid = ANY (guarded_oids)) THEN
        RAISE EXCEPTION 'the superuser''s tables in ops and their guards can be altered only by the superuser'
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION ops_guard.refuse_privileged_login_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_guard.record_privileged_login() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_guard.refuse_privileged_login_ddl() FROM PUBLIC;

DROP EVENT TRIGGER IF EXISTS fin_privileged_login;
CREATE EVENT TRIGGER fin_privileged_login ON login
  EXECUTE FUNCTION ops_guard.record_privileged_login();

DROP EVENT TRIGGER IF EXISTS fin_privileged_login_guard_drop;
CREATE EVENT TRIGGER fin_privileged_login_guard_drop ON sql_drop
  EXECUTE FUNCTION ops_guard.refuse_privileged_login_ddl();

DROP EVENT TRIGGER IF EXISTS fin_privileged_login_guard_alter;
CREATE EVENT TRIGGER fin_privileged_login_guard_alter ON ddl_command_end
  EXECUTE FUNCTION ops_guard.refuse_privileged_login_ddl();
