-- 030_environment.sql: the environment this database serves (spec 08 §3.9: "the function checks
-- FIN_ENVIRONMENT passed by the task against a row the bootstrap wrote"). Run by `migrate --bootstrap`
-- as the superuser, which then writes the one row from its own FIN_ENVIRONMENT and refuses a database
-- that was bootstrapped for another environment.
--
-- The table is the superuser's, like ops.privileged_login: fin_owner may only read it (audit.start_epoch()
-- refuses a reset when it says production, and any start whose task names another environment), a
-- trigger refuses UPDATE, DELETE and TRUNCATE, and the guard in 020 refuses its DROP or ALTER by anyone
-- but the superuser. Like the record, an existing table is adopted only if it is the bootstrap's own
-- (020's ops_guard.assert_bootstrap_table, checked after the create, on the table adopted): one
-- fin_owner made could hide the row behind a policy or a child table, or run its trigger with the
-- superuser's rights when the bootstrap writes the row. The bootstrap and audit.start_epoch() read the
-- row with ONLY and require exactly one.

CREATE TABLE IF NOT EXISTS ops.environment (
  only_row    boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  name        text NOT NULL CHECK (name IN ('development', 'ci', 'staging', 'production')),
  recorded_at timestamptz NOT NULL
);
SELECT ops_guard.assert_bootstrap_table('ops.environment');
DO $owner$
BEGIN
  EXECUTE format('ALTER TABLE ops.environment OWNER TO %I', current_user);
END
$owner$;
REVOKE ALL ON ops.environment FROM PUBLIC;
GRANT SELECT ON ops.environment TO fin_owner;

CREATE OR REPLACE FUNCTION ops_guard.refuse_environment_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'ops.environment is written once, by the bootstrap' USING ERRCODE = '42501';
END
$fn$;
REVOKE ALL ON FUNCTION ops_guard.refuse_environment_change() FROM PUBLIC;

CREATE OR REPLACE TRIGGER environment_unchanged
  BEFORE UPDATE OR DELETE ON ops.environment
  FOR EACH ROW EXECUTE FUNCTION ops_guard.refuse_environment_change();
CREATE OR REPLACE TRIGGER environment_no_truncate
  BEFORE TRUNCATE ON ops.environment
  FOR EACH STATEMENT EXECUTE FUNCTION ops_guard.refuse_environment_change();
