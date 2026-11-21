-- The organisation objects other services read (spec 02 §13.6, [SA-36]) and the console's two audit
-- reads (§14.5). None exposes a token, secret or code.
--
-- The audit reads stand in for `api`'s door until the door matrix and `apps/api/src/doors/audit/`
-- exist (the lane's recorded decision): each is a SECURITY DEFINER function that re-checks, from the
-- session's own row, what the door would re-check (a live session at gate `ok`, the membership and
-- `auditLog.read` for the organisation's log; a live session at `ok` for the person's activity), and
-- returns only the rows of that organisation or person. `fin_console` holds EXECUTE on them and no
-- privilege on `audit.event` itself.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE VIEW identity.membership_view AS
  SELECT m.id AS member_id, m.organization_id, m.user_id, m.role_key
  FROM identity.member m
  JOIN identity.organization o ON o.id = m.organization_id AND o.deleted_at IS NULL;

CREATE VIEW identity.role_permission_view AS
  SELECT rp.role_id, r.organization_id, rp.permission
  FROM identity.role_permission rp
  JOIN identity.role r ON r.id = rp.role_id;

CREATE VIEW identity.organization_view AS
  SELECT id, name, live_status, deleted_at FROM identity.organization;

-- The person behind a live session whose gate is `ok` (spec 02 §6.2), or an exception (42501). It
-- reads the session row itself, never a value the caller asserts.
CREATE FUNCTION identity.audit_reader(p_session_id text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  s record;
  f record;
  trusted boolean;
BEGIN
  SELECT ses.id, ses.user_id, ses.assurance, ses.trusted_browser_id INTO s
    FROM identity.session ses
   WHERE ses.id = p_session_id
     AND ses.expires_at > now() AND ses.absolute_expires_at > now() AND ses.step_up_failures < 5;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit read: no live session' USING ERRCODE = '42501';
  END IF;
  SELECT g.factor_count, g.privileged_anywhere, g.production_member INTO f
    FROM identity.person_gate(s.user_id) g;
  IF s.assurance = 'aal1' AND f.factor_count > 0 THEN
    trusted := s.trusted_browser_id IS NOT NULL
      AND NOT f.privileged_anywhere AND NOT f.production_member
      AND EXISTS (SELECT 1 FROM identity.trusted_browser tb
                   WHERE tb.id = s.trusted_browser_id AND tb.user_id = s.user_id
                     AND tb.revoked_at IS NULL AND tb.expires_at > now());
    IF NOT trusted THEN
      RAISE EXCEPTION 'audit read: the session is at the factor step' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF f.factor_count = 0 AND f.privileged_anywhere THEN
    RAISE EXCEPTION 'audit read: the person is held' USING ERRCODE = '42501';
  END IF;
  RETURN s.user_id;
END
$$;

-- The organisation's audit log (§14.5, §16.3, §15.2.1) for a member whose role holds `auditLog.read`.
-- `target` and `target_kind` are applied inside the organisation's own rows, so an ID from another
-- organisation matches nothing. Paging is bounded (`limit` 1 to 100, `offset` at most 10,000). A row
-- whose actor is not a person of the console (Fin staff, the operator, the system) returns no actor
-- ID, client address or user agent: the organisation sees that Fin acted, never from where or who.
CREATE FUNCTION identity.organization_audit_log(
  p_session_id text,
  p_organization_id text,
  p_category text,
  p_from timestamptz,
  p_to timestamptz,
  p_target text,
  p_target_kind text,
  p_query text,
  p_limit integer,
  p_offset integer
) RETURNS TABLE (
  id text, event text, category text, recorded_at timestamptz,
  actor_kind text, actor_id text, actor_via text, actor_name text, actor_email text,
  step_up_method text, target_id text, ref_ids text[], metadata jsonb,
  client_ip text, user_agent text, total bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  reader text;
  held_role text;
  pattern text;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_offset IS NULL OR p_offset < 0
     OR p_offset > 10000 THEN
    RAISE EXCEPTION 'audit read: paging' USING ERRCODE = '22023';
  END IF;
  reader := identity.audit_reader(p_session_id);
  SELECT m.role_key INTO held_role
    FROM identity.member m
    JOIN identity.organization o ON o.id = m.organization_id AND o.deleted_at IS NULL
   WHERE m.organization_id = p_organization_id AND m.user_id = reader;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit read: not a member' USING ERRCODE = '42501';
  END IF;
  IF held_role NOT IN ('super_admin', 'admin') AND NOT EXISTS (
    SELECT 1 FROM identity.role r
    JOIN identity.role_permission rp ON rp.role_id = r.id
    WHERE r.id = held_role AND r.organization_id = p_organization_id
      AND rp.permission = 'auditLog.read'
  ) THEN
    RAISE EXCEPTION 'audit read: the role cannot read the audit log' USING ERRCODE = '42501';
  END IF;
  pattern := CASE WHEN p_query IS NULL OR p_query = '' THEN NULL
    ELSE '%' || replace(replace(replace(left(p_query, 100), '\', '\\'), '%', '\%'), '_', '\_')
         || '%' END;
  RETURN QUERY
    SELECT e.id, e.event, e.category, e.recorded_at,
           e.actor_kind,
           CASE WHEN e.actor_kind = 'user' THEN e.actor_id END,
           e.actor_via, u.name, u.email,
           e.step_up_method, e.target_id, e.ref_ids, e.metadata,
           CASE WHEN e.actor_kind = 'user' THEN host(c.client_ip) END,
           CASE WHEN e.actor_kind = 'user' THEN c.user_agent END,
           count(*) OVER ()
      FROM audit.event e
      LEFT JOIN audit.event_context c ON c.event_id = e.id
      LEFT JOIN identity."user" u ON e.actor_kind = 'user' AND u.id = e.actor_id
     WHERE e.scope = 'organisation'
       AND e.organization_id = p_organization_id
       AND (p_category IS NULL OR e.category = p_category)
       AND (p_from IS NULL OR e.recorded_at >= p_from)
       AND (p_to IS NULL OR e.recorded_at < p_to)
       AND (p_target IS NULL OR e.target_id = p_target OR p_target = ANY (e.ref_ids))
       AND (p_target_kind IS NULL OR (p_target_kind = 'role' AND e.target_id LIKE 'rol\_%'))
       AND (pattern IS NULL OR e.event ILIKE pattern OR u.name ILIKE pattern
            OR u.email ILIKE pattern)
     ORDER BY e.recorded_at DESC, e.id DESC
     LIMIT p_limit OFFSET p_offset;
END
$$;

-- The person's own activity (§14.5, §16.2: Account security's "Recent activity"). Some rows about
-- the person were made by someone else (a team admin's removal or role change revokes the person's
-- trusted browsers; Fin staff revoke them at a go-live approval): such a row returns no actor ID,
-- step-up method, client address or user agent, which are that other actor's, never the person's.
CREATE FUNCTION identity.person_activity(p_session_id text, p_limit integer, p_offset integer)
RETURNS TABLE (
  id text, event text, category text, recorded_at timestamptz,
  actor_kind text, actor_id text, actor_via text, actor_is_reader boolean,
  step_up_method text, target_id text, ref_ids text[], metadata jsonb,
  client_ip text, user_agent text, total bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  reader text;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_offset IS NULL OR p_offset < 0
     OR p_offset > 10000 THEN
    RAISE EXCEPTION 'audit read: paging' USING ERRCODE = '22023';
  END IF;
  reader := identity.audit_reader(p_session_id);
  RETURN QUERY
    SELECT e.id, e.event, e.category, e.recorded_at,
           e.actor_kind,
           CASE WHEN own.is_reader THEN e.actor_id END,
           e.actor_via, own.is_reader,
           CASE WHEN own.is_reader THEN e.step_up_method END,
           e.target_id, e.ref_ids, e.metadata,
           CASE WHEN own.is_reader THEN host(c.client_ip) END,
           CASE WHEN own.is_reader THEN c.user_agent END,
           count(*) OVER ()
      FROM audit.event e
      LEFT JOIN audit.event_context c ON c.event_id = e.id
      CROSS JOIN LATERAL (
        SELECT e.actor_kind = 'user' AND e.actor_id IS NOT DISTINCT FROM reader AS is_reader
      ) own
     WHERE e.scope = 'person' AND e.subject_user_id = reader
     ORDER BY e.recorded_at DESC, e.id DESC
     LIMIT p_limit OFFSET p_offset;
END
$$;

REVOKE EXECUTE ON FUNCTION identity.audit_reader(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity.organization_audit_log(text, text, text, timestamptz,
  timestamptz, text, text, text, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity.person_activity(text, integer, integer) FROM PUBLIC;
