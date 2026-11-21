-- Fin Admin's audit log (spec 02 §14.3, §14.5, §16.4; spec 06 §7.2's AdminAudit; ARCHITECTURE §8.6;
-- spec 08 §3.11): the staff-scope rows, read through two SECURITY DEFINER functions that stand in
-- for `api`'s `audit.staff_log` door operation until the door matrix and `apps/api/src/doors/audit/`
-- exist (the lane's recorded decision, as the console's two reads in `_orgs_views` do). Each
-- re-checks, from the session's own row, what the door would: a live staff session at `aal2` made
-- under the Access identity the API half verified (its `sub`), an active member with a second
-- factor, and a role holding `audit.read` (the four prebuilt roles hold it; a custom role holds it
-- when its permission row says so). They return only `scope = 'staff'` rows, never an
-- organisation's or a person's. fin_admin holds EXECUTE on the two reads and still no privilege on
-- audit.event itself.
--
-- Paging is by keyset on the row ID, newest first (the `aud_` ID is time-ordered and
-- `event_staff_log` indexes it): `p_after` reads the rows older than an ID, `p_before` the rows
-- newer than one, at most `p_limit` (1 to 100) plus one row that says whether more lie beyond. A
-- cursor is only a bound: no row is read for it, so an ID from another scope reveals nothing.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The staff member behind a working session (spec 02 §6.4, §10.5), or an exception (42501). It
-- reads the session and the member themselves, never a value the caller asserts but the Access
-- `sub`, which must equal the one the session was made under.
CREATE FUNCTION staff.audit_reader(p_session_id text, p_access_sub text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  reader text;
  held_role text;
BEGIN
  SELECT m.id, m.role_key INTO reader, held_role
    FROM staff.session s
    JOIN staff.member m ON m.id = s.user_id
   WHERE s.id = p_session_id
     AND s.expires_at > now() AND s.absolute_expires_at > now()
     AND s.step_up_failures < 5
     AND s.assurance = 'aal2'
     AND p_access_sub IS NOT NULL AND s.access_sub = p_access_sub
     AND m.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff audit read: no working staff session' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff.passkey p WHERE p.user_id = reader)
     AND NOT EXISTS (SELECT 1 FROM staff.two_factor t WHERE t.user_id = reader AND t.verified) THEN
    RAISE EXCEPTION 'staff audit read: no second factor' USING ERRCODE = '42501';
  END IF;
  IF held_role NOT IN ('viewer', 'compliance', 'operator', 'admin') AND NOT EXISTS (
    SELECT 1 FROM staff.role_permission rp
     WHERE rp.role_id = held_role AND rp.permission = 'audit.read'
  ) THEN
    RAISE EXCEPTION 'staff audit read: the role cannot read the audit log' USING ERRCODE = '42501';
  END IF;
  RETURN reader;
END
$$;

-- The filters of one read, as one predicate the two reads share (inlined by the planner). A null
-- list or bound filters nothing; an empty list matches nothing.
CREATE FUNCTION staff.audit_matches(
  e_actor_kind text,
  e_actor_id text,
  e_event text,
  e_organization_id text,
  e_recorded_at timestamptz,
  p_actors text[],
  p_events text[],
  p_orgs text[],
  p_from timestamptz,
  p_to timestamptz
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_actors IS NULL OR (e_actor_kind = 'staff' AND e_actor_id = ANY (p_actors)))
     AND (p_events IS NULL OR e_event = ANY (p_events))
     AND (p_orgs IS NULL OR e_organization_id = ANY (p_orgs))
     AND (p_from IS NULL OR e_recorded_at >= p_from)
     AND (p_to IS NULL OR e_recorded_at < p_to)
$$;

-- One page of the staff log (§14.5). `p_mine` keeps the rows the reader made (the reader as the
-- database read it, never an ID the caller names); `total` counts the matching rows up to 10,001;
-- `beyond` says whether rows lie on the other side of the cursor (newer for `p_after`, older for
-- `p_before`). Address and user agent come from the context row ([BC-03]); the actor's address
-- and name from the staff table, as they are now.
CREATE FUNCTION staff.audit_log(
  p_session_id text,
  p_access_sub text,
  p_mine boolean,
  p_actors text[],
  p_events text[],
  p_orgs text[],
  p_from timestamptz,
  p_to timestamptz,
  p_after text,
  p_before text,
  p_limit integer
) RETURNS TABLE (
  id text, event text, category text, recorded_at timestamptz,
  actor_kind text, actor_id text, actor_via text, actor_email text, actor_name text,
  step_up_method text, target_id text, ref_ids text[], metadata jsonb, organization_id text,
  client_ip text, user_agent text, total bigint, beyond boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  reader text;
  actors text[];
  page_ids text[];
  matching bigint;
  more boolean := false;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR (p_after IS NOT NULL AND p_before IS NOT NULL)
     OR coalesce(cardinality(p_actors), 0) > 20 OR coalesce(cardinality(p_events), 0) > 50
     OR coalesce(cardinality(p_orgs), 0) > 20 THEN
    RAISE EXCEPTION 'staff audit read: paging or filters' USING ERRCODE = '22023';
  END IF;
  reader := staff.audit_reader(p_session_id, p_access_sub);
  actors := CASE
    WHEN coalesce(p_mine, false) IS FALSE THEN p_actors
    WHEN p_actors IS NULL OR reader = ANY (p_actors) THEN ARRAY[reader]
    ELSE ARRAY[]::text[]
  END;
  IF p_before IS NULL THEN
    SELECT array_agg(x.id) INTO page_ids FROM (
      SELECT e.id FROM audit.event e
       WHERE e.scope = 'staff'
         AND staff.audit_matches(e.actor_kind, e.actor_id, e.event, e.organization_id,
               e.recorded_at, actors, p_events, p_orgs, p_from, p_to)
         AND (p_after IS NULL OR e.id < p_after)
       ORDER BY e.id DESC
       LIMIT p_limit + 1
    ) x;
    IF p_after IS NOT NULL THEN
      more := EXISTS (
        SELECT 1 FROM audit.event e
         WHERE e.scope = 'staff' AND e.id >= p_after
           AND staff.audit_matches(e.actor_kind, e.actor_id, e.event, e.organization_id,
                 e.recorded_at, actors, p_events, p_orgs, p_from, p_to));
    END IF;
  ELSE
    SELECT array_agg(x.id) INTO page_ids FROM (
      SELECT e.id FROM audit.event e
       WHERE e.scope = 'staff' AND e.id > p_before
         AND staff.audit_matches(e.actor_kind, e.actor_id, e.event, e.organization_id,
               e.recorded_at, actors, p_events, p_orgs, p_from, p_to)
       ORDER BY e.id ASC
       LIMIT p_limit + 1
    ) x;
    more := EXISTS (
      SELECT 1 FROM audit.event e
       WHERE e.scope = 'staff' AND e.id <= p_before
         AND staff.audit_matches(e.actor_kind, e.actor_id, e.event, e.organization_id,
               e.recorded_at, actors, p_events, p_orgs, p_from, p_to));
  END IF;
  SELECT count(*) INTO matching FROM (
    SELECT 1 FROM audit.event e
     WHERE e.scope = 'staff'
       AND staff.audit_matches(e.actor_kind, e.actor_id, e.event, e.organization_id,
             e.recorded_at, actors, p_events, p_orgs, p_from, p_to)
     LIMIT 10001
  ) counted;
  RETURN QUERY
    SELECT e.id, e.event, e.category, e.recorded_at,
           e.actor_kind, e.actor_id, e.actor_via, m.email, nullif(m.name, ''),
           e.step_up_method, e.target_id, e.ref_ids, e.metadata, e.organization_id,
           host(c.client_ip), c.user_agent, matching, more
      FROM audit.event e
      LEFT JOIN audit.event_context c ON c.event_id = e.id
      LEFT JOIN staff.member m ON e.actor_kind = 'staff' AND m.id = e.actor_id
     WHERE e.scope = 'staff' AND e.id = ANY (coalesce(page_ids, ARRAY[]::text[]))
     ORDER BY e.id DESC;
END
$$;

-- One entry of the staff log (the drawer's deep link, `view=<aud_…>`): the row when it is a staff
-- row, nothing otherwise, so an ID from another scope reads as not found.
CREATE FUNCTION staff.audit_entry(p_session_id text, p_access_sub text, p_event_id text)
RETURNS TABLE (
  id text, event text, category text, recorded_at timestamptz,
  actor_kind text, actor_id text, actor_via text, actor_email text, actor_name text,
  step_up_method text, target_id text, ref_ids text[], metadata jsonb, organization_id text,
  client_ip text, user_agent text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  reader text;
BEGIN
  reader := staff.audit_reader(p_session_id, p_access_sub);
  RETURN QUERY
    SELECT e.id, e.event, e.category, e.recorded_at,
           e.actor_kind, e.actor_id, e.actor_via, m.email, nullif(m.name, ''),
           e.step_up_method, e.target_id, e.ref_ids, e.metadata, e.organization_id,
           host(c.client_ip), c.user_agent
      FROM audit.event e
      LEFT JOIN audit.event_context c ON c.event_id = e.id
      LEFT JOIN staff.member m ON e.actor_kind = 'staff' AND m.id = e.actor_id
     WHERE e.id = p_event_id AND e.scope = 'staff';
END
$$;

REVOKE EXECUTE ON FUNCTION staff.audit_reader(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION staff.audit_matches(text, text, text, text, timestamptz, text[], text[],
  text[], timestamptz, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION staff.audit_log(text, text, boolean, text[], text[], text[], timestamptz,
  timestamptz, text, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION staff.audit_entry(text, text, text) FROM PUBLIC;
