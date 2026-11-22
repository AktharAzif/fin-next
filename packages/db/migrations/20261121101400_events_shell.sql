-- events shell (spec 01 §6.10 row 7; spec 05 §5.5; DECISIONS DA-14). Run as fin_owner.
--
-- events.emit() exists from Phase 0 so the roles that will emit developer events hold EXECUTE on a
-- checked function and nothing else, and refuses every type until spec 05's migration adds
-- events.event, events.delivery and the per-role type allowlist, replacing this body.
--
-- SQLSTATE FV001: a developer event type the caller's role may not emit.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION events.emit(p jsonb) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = events, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'events.emit: no developer event type is allowed yet' USING ERRCODE = 'FV001';
END
$fn$;

REVOKE ALL ON FUNCTION events.emit(jsonb) FROM PUBLIC;
