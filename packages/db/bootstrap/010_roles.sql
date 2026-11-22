-- 010_roles.sql: the roles and schemas of spec 01 §6.6 step 4 (ARCHITECTURE §6.3, DECISIONS DA-03,
-- P-20, AU-08). Run by `migrate --bootstrap` as the template's superuser, inside the bootstrap's one
-- transaction. Idempotent: a second run converges the roles and schemas to this file.
--
-- Passwords never appear here. The runner sets each login's SCRAM verifier and CONNECTION LIMIT after
-- this file, from FIN_ROLE_VERIFIERS; a login without a verifier keeps the one it has, and a new one
-- has none (the `_b` logins until their first rotation, P-20).

DO $roles$
DECLARE
  groups constant text[] := ARRAY['fin_edge', 'fin_api', 'fin_worker', 'fin_payments', 'fin_console', 'fin_admin'];
  grp text;
  login text;
  extra record;
BEGIN
  -- fin_owner owns the schemas and runs migrations. It is no superuser and has no standing password:
  -- each registered run sets one VALID UNTIL its end (AU-08).
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fin_owner') THEN
    CREATE ROLE fin_owner;
  END IF;
  ALTER ROLE fin_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    INHERIT PASSWORD NULL;

  -- One NOLOGIN group per service holds the grants (P-20).
  FOREACH grp IN ARRAY groups LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = grp) THEN
      EXECUTE format('CREATE ROLE %I', grp);
    END IF;
    EXECUTE format(
      'ALTER ROLE %I WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT',
      grp);
    -- Two logins per group, members of exactly that group.
    FOREACH login IN ARRAY ARRAY[grp || '_a', grp || '_b'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = login) THEN
        EXECUTE format('CREATE ROLE %I', login);
      END IF;
      EXECUTE format(
        'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
        login);
      EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET TRUE', grp, login);
      -- Per-role timeouts (ARCHITECTURE §4.5). A session may change them for itself, so nothing relies on
      -- them to protect others; they stop accidents.
      EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', login, '15s');
      EXECUTE format('ALTER ROLE %I SET lock_timeout = %L', login, '5s');
      EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', login, '30s');
    END LOOP;
  END LOOP;

  -- The backup login reads everything (dumps leave out the tables DA-15 names), the probe holds
  -- pg_monitor only, the operator's read-only login has no password.
  FOREACH login IN ARRAY ARRAY['fin_backup', 'fin_probe', 'fin_readonly'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = login) THEN
      EXECUTE format('CREATE ROLE %I', login);
    END IF;
    EXECUTE format(
      'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
      login);
    EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', login, '15s');
    EXECUTE format('ALTER ROLE %I SET lock_timeout = %L', login, '5s');
    EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', login, '30s');
  END LOOP;
  -- pg_read_all_data does not reach past row-level security, so without this a dump of a table with
  -- policies (the jobs, the leases, the duty state) fails under pg_dump's default, or comes out empty
  -- with --enable-row-security (DA-15: "a junk dump of the right size"). The backup login reads every
  -- row of every table it dumps, so it bypasses row-level security, and nothing else.
  ALTER ROLE fin_backup WITH BYPASSRLS;
  ALTER ROLE fin_readonly WITH PASSWORD NULL;
  GRANT pg_read_all_data TO fin_backup WITH INHERIT TRUE, SET FALSE;
  GRANT pg_monitor TO fin_probe WITH INHERIT TRUE, SET FALSE;

  -- email.enqueue()'s owner. The function is SECURITY DEFINER and reaches email_private, the schema
  -- only the worker may use besides it; its owner cannot log in, is a member of nothing, and is granted
  -- only what the function needs (roles/grants/email.json). fin_owner is its one member: it moves the
  -- function to this owner in the migration (which needs SET), and replaces and grants on it later
  -- (which needs INHERIT).
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fin_email_enqueue') THEN
    CREATE ROLE fin_email_enqueue;
  END IF;
  ALTER ROLE fin_email_enqueue WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
    NOBYPASSRLS NOINHERIT PASSWORD NULL;
  GRANT fin_email_enqueue TO fin_owner WITH INHERIT TRUE, SET TRUE;

  -- "Members of exactly their group": remove any other membership a login or the owner has, and any
  -- in or of enqueue's owner but fin_owner's.
  FOR extra IN
    SELECT member.rolname AS member_name, granted.rolname AS granted_name
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    WHERE (member.rolname = 'fin_owner' AND granted.rolname <> 'fin_email_enqueue')
       OR (member.rolname ~ '^fin_(edge|api|worker|payments|console|admin)_[ab]$'
           AND granted.rolname <> regexp_replace(member.rolname, '_[ab]$', ''))
       OR (member.rolname = 'fin_backup' AND granted.rolname <> 'pg_read_all_data')
       OR (member.rolname = 'fin_probe' AND granted.rolname <> 'pg_monitor')
       OR member.rolname = 'fin_readonly'
       OR member.rolname = ANY (groups)
       OR member.rolname = 'fin_email_enqueue'
       OR (granted.rolname = 'fin_email_enqueue' AND member.rolname <> 'fin_owner')
  LOOP
    EXECUTE format('REVOKE %I FROM %I CASCADE', extra.granted_name, extra.member_name);
  END LOOP;

  -- Every statement by the owner and the operator's read-only login is logged (AU-08).
  ALTER ROLE fin_owner SET log_statement = 'all';
  ALTER ROLE fin_readonly SET log_statement = 'all';
END
$roles$;

-- The schemas, one per area (DECISIONS DA-01), owned by fin_owner, with nothing for PUBLIC; and
-- email_private, the worker's outbox and sender tables, which only the worker and enqueue's owner may
-- use (the grant fragments say so), so no other login can name, and so lock, a table in it.
DO $schemas$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['identity', 'staff', 'keys', 'kyc', 'money', 'events', 'email', 'email_private', 'audit', 'ops'] LOOP
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION fin_owner', s);
    EXECUTE format('ALTER SCHEMA %I OWNER TO fin_owner', s);
    EXECUTE format('REVOKE CREATE, USAGE ON SCHEMA %I FROM PUBLIC', s);
  END LOOP;

  -- The database: no privilege for PUBLIC; CONNECT for Fin's roles only (logins inherit it).
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO fin_owner, fin_edge, fin_api, fin_worker, fin_payments, fin_console, fin_admin, fin_backup, fin_probe, fin_readonly',
    current_database());
END
$schemas$;

-- No object fin_owner creates is executable by PUBLIC unless a grant fragment says so; nothing is
-- granted to a service role by default (ARCHITECTURE §6.3).
ALTER DEFAULT PRIVILEGES FOR ROLE fin_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE fin_owner REVOKE USAGE ON TYPES FROM PUBLIC;
