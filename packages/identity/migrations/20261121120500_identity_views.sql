-- The identity objects other services read (spec 02 §13.6) and the sweeps (§13.4). None exposes a
-- token, secret or code. The organisation views (membership_view, role_permission_view,
-- organization_view) follow L-SAT-03's _orgs_tables; person_gate() and
-- revoke_trusted_browsers() are PL/pgSQL so they bind to the organisation tables only when they
-- run, and fail closed until those tables exist.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- A time-ordered ID made in the database (ARCHITECTURE §6.2's shape), for rows the database
-- writes by itself (the audit events of revoke_trusted_browsers).
CREATE FUNCTION identity.new_id(p_prefix text) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  alphabet constant text := '0123456789abcdefghjkmnpqrstvwxyz';
  ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  random_bytes bytea := substring(uuid_send(gen_random_uuid()) FROM 1 FOR 10);
  out_text text := '';
  buf bigint := 0;
  bits integer := 0;
  i integer;
BEGIN
  IF p_prefix !~ '^[a-z]{3}$' THEN
    RAISE EXCEPTION 'identity.new_id: bad prefix' USING ERRCODE = '22023';
  END IF;
  FOR i IN 1..10 LOOP
    out_text := substr(alphabet, (ms % 32)::integer + 1, 1) || out_text;
    ms := ms / 32;
  END LOOP;
  FOR i IN 0..9 LOOP
    buf := (buf << 8) | get_byte(random_bytes, i);
    bits := bits + 8;
    WHILE bits >= 5 LOOP
      bits := bits - 5;
      out_text := out_text || substr(alphabet, ((buf >> bits) & 31)::integer + 1, 1);
    END LOOP;
    buf := buf & ((1::bigint << bits) - 1);
  END LOOP;
  RETURN p_prefix || '_' || out_text;
END
$$;

-- The developer gate's facts (§6.2), read on every request, never cached.
CREATE FUNCTION identity.person_gate(p_user_id text)
RETURNS TABLE (factor_count integer, privileged_anywhere boolean, production_member boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = identity, pg_temp AS $$
BEGIN
  RETURN QUERY SELECT
    (
      (SELECT count(*) FROM identity.passkey p WHERE p.user_id = p_user_id)
      + (SELECT count(*) FROM identity.two_factor t WHERE t.user_id = p_user_id AND t.verified)
    )::integer,
    EXISTS (
      SELECT 1
      FROM identity.member m
      JOIN identity.organization o ON o.id = m.organization_id AND o.deleted_at IS NULL
      WHERE m.user_id = p_user_id
        AND (
          m.role_key IN ('super_admin', 'admin')
          OR EXISTS (
            SELECT 1
            FROM identity.role_permission rp
            JOIN identity.privileged_permission pp ON pp.permission = rp.permission
            WHERE rp.role_id = m.role_key
          )
        )
    ),
    EXISTS (
      SELECT 1
      FROM identity.member m
      JOIN identity.organization o ON o.id = m.organization_id AND o.deleted_at IS NULL
      WHERE m.user_id = p_user_id AND o.live_status = 'approved'
    );
END
$$;

CREATE VIEW identity.session_view AS
  SELECT id, user_id, assurance, expires_at, absolute_expires_at, current_organization_id
  FROM identity.session;

CREATE VIEW identity.proof_view AS
  SELECT session_id, user_id, method, created_at FROM identity.assurance;

CREATE VIEW staff.session_view AS
  SELECT id, user_id, assurance, expires_at, absolute_expires_at FROM staff.session;

CREATE VIEW staff.proof_view AS
  SELECT session_id, user_id, method, created_at FROM staff.assurance;

CREATE VIEW staff.member_view AS
  SELECT id, email, role_key, status FROM staff.member;

-- Revokes the trusted browsers of every member of an organisation, one browser.trust_revoked
-- per row, in the caller's transaction (§6.6, IF-09): Sunday's go-live approval calls it.
CREATE FUNCTION identity.revoke_trusted_browsers(
  p_org_id text,
  p_reason text,
  p_actor jsonb DEFAULT '{"kind": "system", "via": "job"}',
  p_release text DEFAULT 'database',
  p_request_id text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = identity, pg_temp AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  IF p_reason NOT IN ('production_access', 'role_elevated', 'removed') THEN
    RAISE EXCEPTION 'identity.revoke_trusted_browsers: reason' USING ERRCODE = '22023';
  END IF;
  FOR r IN
    UPDATE identity.trusted_browser tb
       SET revoked_at = now(), revoked_reason = p_reason
     WHERE tb.revoked_at IS NULL
       AND tb.user_id IN (SELECT m.user_id FROM identity.member m WHERE m.organization_id = p_org_id)
    RETURNING tb.id, tb.user_id
  LOOP
    PERFORM audit.record(jsonb_build_object(
      'id', identity.new_id('aud'),
      'event', 'browser.trust_revoked',
      'actor_kind', coalesce(p_actor ->> 'kind', 'system'),
      'actor_id', p_actor ->> 'id',
      'actor_via', coalesce(p_actor ->> 'via', 'job'),
      'target_id', r.id,
      'ref_ids', jsonb_build_array(r.user_id, p_org_id),
      'subject_user_id', r.user_id,
      'metadata', jsonb_build_object('reason', p_reason),
      'request_id', p_request_id,
      'release', p_release
    ));
    n := n + 1;
  END LOOP;
  RETURN n;
END
$$;

-- The hourly sweeps (§13.4), each for fin_worker only; they return what they deleted per table
-- so the duty can record system.sweep_completed and its job.run line.
CREATE FUNCTION identity.sweep() RETURNS TABLE (table_name text, deleted bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = identity, pg_temp AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM identity.verification WHERE expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'identity.verification'; deleted := n; RETURN NEXT;
  DELETE FROM identity.session WHERE expires_at < now() OR absolute_expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'identity.session'; deleted := n; RETURN NEXT;
  DELETE FROM identity.sign_up_request WHERE expires_at < now() - interval '2 hours';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'identity.sign_up_request'; deleted := n; RETURN NEXT;
  DELETE FROM identity.email_code_request WHERE expires_at < now() - interval '2 hours';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'identity.email_code_request'; deleted := n; RETURN NEXT;
  -- Never identity.email_code_lock: a delete is a row lock held to the end of the caller's
  -- transaction, which would let fin_worker hold every old address's lock open (codes.ts).
  DELETE FROM identity.known_browser WHERE last_seen_at < now() - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'identity.known_browser'; deleted := n; RETURN NEXT;
  DELETE FROM identity.trusted_browser WHERE expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'identity.trusted_browser'; deleted := n; RETURN NEXT;
END
$$;

CREATE FUNCTION staff.sweep() RETURNS TABLE (table_name text, deleted bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = staff, pg_temp AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM staff.verification WHERE expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'staff.verification'; deleted := n; RETURN NEXT;
  DELETE FROM staff.session WHERE expires_at < now() OR absolute_expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'staff.session'; deleted := n; RETURN NEXT;
  UPDATE staff.enrolment_code SET voided_at = now()
   WHERE redeemed_at IS NULL AND voided_at IS NULL AND expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'staff.enrolment_code'; deleted := n; RETURN NEXT;
END
$$;

CREATE FUNCTION ops.sweep_step_up() RETURNS TABLE (table_name text, deleted bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM ops.step_up_intent WHERE created_at < now() - interval '1 day';
  GET DIAGNOSTICS n = ROW_COUNT; table_name := 'ops.step_up_intent'; deleted := n; RETURN NEXT;
END
$$;

REVOKE EXECUTE ON FUNCTION identity.new_id(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity.person_gate(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity.revoke_trusted_browsers(text, text, jsonb, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity.sweep() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION staff.sweep() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ops.sweep_step_up() FROM PUBLIC;
