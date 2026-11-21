-- 020_privileged_login.sql: the privileged-login record and its guards (spec 01 §6.10 row 2;
-- ARCHITECTURE §6.3; DECISIONS DA-03, P-19, AU-08). Run by `migrate --bootstrap` as the superuser.
--
-- What this protects against: a login as the superuser or fin_owner outside a registered run. The
-- record must survive that login, so:
--   - ops.privileged_login is owned by the superuser (not by fin_owner, the login it watches), has no
--     privilege for anyone but fin_worker's SELECT, and refuses UPDATE, DELETE and TRUNCATE by trigger;
--   - its rows come only from the `login` event trigger's SECURITY DEFINER function, which returns at
--     once on a standby and never raises, because a failing login trigger blocks every login (P-19);
--   - every function here lives in ops_guard, a schema the superuser owns. fin_owner owns `ops`, and
--     the owner of a schema may drop any object in it; were these functions in `ops`, fin_owner could
--     `DROP FUNCTION ... CASCADE` and take the event triggers with them;
--   - an event trigger refuses, for anyone but a superuser, any DROP that takes the table or anything
--     in ops_guard, and any ALTER of the `ops` schema (a rename would send the inserts nowhere).
-- The disable path (`event_triggers = off`, superuser only) is in the restore and incident runbooks.

CREATE SCHEMA IF NOT EXISTS ops_guard;
DO $owner$
BEGIN
  EXECUTE format('ALTER SCHEMA ops_guard OWNER TO %I', current_user);
END
$owner$;
REVOKE ALL ON SCHEMA ops_guard FROM PUBLIC;

CREATE TABLE IF NOT EXISTS ops.privileged_login (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  login_role       text NOT NULL,
  application_name text,
  client_addr      inet,
  backend_pid      integer NOT NULL,
  logged_in_at     timestamptz NOT NULL
);
DO $owner$
BEGIN
  EXECUTE format('ALTER TABLE ops.privileged_login OWNER TO %I', current_user);
END
$owner$;
REVOKE ALL ON ops.privileged_login FROM PUBLIC;
-- ops.privileged_login_check (fin_owner's, in the ops core migration) references these rows.
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

-- The guarded login trigger (P-19). Everything is inside one exception block that swallows every
-- error: a bug here must never lock out the services, Patroni or the operator.
CREATE OR REPLACE FUNCTION ops_guard.record_privileged_login() RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  BEGIN
    IF pg_catalog.pg_is_in_recovery() THEN
      RETURN;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles r
      WHERE r.rolname = session_user AND (r.rolsuper OR r.rolname = 'fin_owner')
    ) THEN
      RETURN;
    END IF;
    INSERT INTO ops.privileged_login (login_role, application_name, client_addr, backend_pid, logged_in_at)
    VALUES (
      session_user,
      pg_catalog.left(pg_catalog.current_setting('application_name', true), 64),
      pg_catalog.inet_client_addr(),
      pg_catalog.pg_backend_pid(),
      pg_catalog.clock_timestamp()
    );
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      RAISE LOG 'fin: privileged login not recorded (SQLSTATE %)', SQLSTATE;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;
END
$fn$;

CREATE OR REPLACE FUNCTION ops_guard.refuse_privileged_login_ddl() RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  obj record;
  guarded_schemas oid[];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = session_user AND r.rolsuper) THEN
    RETURN;
  END IF;
  IF TG_EVENT = 'sql_drop' THEN
    FOR obj IN SELECT * FROM pg_catalog.pg_event_trigger_dropped_objects() LOOP
      IF (obj.schema_name = 'ops' AND obj.object_name = 'privileged_login')
         OR obj.schema_name = 'ops_guard'
         OR (obj.object_type = 'schema' AND obj.object_name IN ('ops', 'ops_guard')) THEN
        RAISE EXCEPTION 'ops.privileged_login and its guards can be dropped only by the superuser'
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
  ELSE
    -- The schema holding the record, found by the table's own name (a rename of the schema is what
    -- this refuses, so the schema's name cannot be relied on here).
    SELECT pg_catalog.array_agg(c.relnamespace) INTO guarded_schemas
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE c.relname = 'privileged_login' AND c.relkind = 'r' AND r.rolsuper;
    FOR obj IN SELECT * FROM pg_catalog.pg_event_trigger_ddl_commands() LOOP
      IF obj.schema_name = 'ops_guard'
         OR (obj.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
             AND (obj.objid = ANY (guarded_schemas) OR obj.object_identity = 'ops_guard'))
         OR (obj.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
             AND obj.objid = pg_catalog.to_regclass('ops.privileged_login')) THEN
        RAISE EXCEPTION 'ops.privileged_login and its guards can be altered only by the superuser'
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
