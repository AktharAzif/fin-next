-- The operator's reset of the last Admin (spec 02 §10.6, §10.4, §11.4) ends every way in the
-- member had or had begun, as an Admin's reset in Fin Admin does (@fin/staff's members.ts):
-- staff.bootstrap_admin is replaced so that its reset branch
--   - takes the member's ceremony lock (their staff.totp_step row, FOR UPDATE) after the
--     staff-change lock and before their row, in the one lock order of @fin/staff's lock.ts, so a
--     sign-in or factor ceremony of theirs in flight finishes first and the reset then ends the
--     session it made, and one that comes later waits for the reset and reads what it left;
--   - deletes the sign-in codes already emailed to them (their 'sign-in-otp-<address>' row of
--     staff.verification), so that a code sent before the reset signs no one in after it.
-- Everything else is as 20261121140100_staff_bootstrap.sql made it: the same arguments, refusals,
-- events and answer, and no grant to anyone but its owner.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION staff.bootstrap_admin(
  p_address text,
  p_code_hash bytea,
  p_reset boolean,
  p_reason_code text,
  p_run_id text,
  p_release text,
  p_ids jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  address text;
  m staff.member%ROWTYPE;
  has_member boolean;
  active_admins integer;
  staff_id text;
  ceremony_of text;
  reactivated boolean := false;
  sessions_ended integer := 0;
  passkeys_removed integer := 0;
  authenticators_removed integer := 0;
  code_id text := p_ids ->> 'code_id';
  actor jsonb;
  id_shape constant text := '^%s_[0-9a-hjkmnp-tv-z]{26}$';
BEGIN
  IF p_address IS NULL OR p_code_hash IS NULL OR p_reset IS NULL OR p_reason_code IS NULL
     OR p_run_id IS NULL OR p_release IS NULL OR p_ids IS NULL OR jsonb_typeof(p_ids) <> 'object' THEN
    RAISE EXCEPTION 'staff.bootstrap_admin: every argument is required' USING ERRCODE = '22023';
  END IF;
  address := lower(btrim(p_address));
  IF char_length(address) NOT BETWEEN 3 AND 254 OR address !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'staff.bootstrap_admin: address shape' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_code_hash) <> 32 THEN
    RAISE EXCEPTION 'staff.bootstrap_admin: the code hash is SHA-256' USING ERRCODE = '22023';
  END IF;
  IF p_reason_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'staff.bootstrap_admin: reason code shape' USING ERRCODE = '22023';
  END IF;
  IF char_length(p_run_id) NOT BETWEEN 1 AND 64 OR char_length(p_release) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'staff.bootstrap_admin: run and release' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_ids ->> 'member_id', '') !~ format(id_shape, 'stf')
     OR coalesce(code_id, '') !~ format(id_shape, 'enc')
     OR coalesce(p_ids ->> 'member_event_id', '') !~ format(id_shape, 'aud')
     OR coalesce(p_ids ->> 'code_event_id', '') !~ format(id_shape, 'aud')
     OR coalesce(p_ids ->> 'bootstrap_event_id', '') !~ format(id_shape, 'aud')
     OR coalesce(p_ids ->> 'journal_id', '') !~ format(id_shape, 'jrn') THEN
    RAISE EXCEPTION 'staff.bootstrap_admin: ids shape' USING ERRCODE = '22023';
  END IF;
  actor := jsonb_build_object('actor_kind', 'operator', 'actor_id', p_run_id, 'actor_via', 'operator',
    'release', p_release);

  PERFORM 1 FROM staff.change_lock WHERE id = 1 FOR UPDATE;
  SELECT count(*)::integer INTO active_admins
    FROM staff.member WHERE role_key = 'admin' AND status = 'active';
  IF p_reset THEN
    -- The member's ceremony lock before their row, as every change that ends a member's sessions
    -- or removes their factors takes them (@fin/staff's lock.ts, @fin/identity's
    -- holdCeremonyLock): the reset waits only for the sign-ins queued before it, and none runs
    -- while it holds the row.
    SELECT id INTO ceremony_of FROM staff.member WHERE email = address;
    IF FOUND THEN
      INSERT INTO staff.totp_step (user_id, last_step, updated_at)
      VALUES (ceremony_of, 0, statement_timestamp())
      ON CONFLICT (user_id) DO NOTHING;
      PERFORM 1 FROM staff.totp_step WHERE user_id = ceremony_of FOR UPDATE;
    END IF;
  END IF;
  SELECT * INTO m FROM staff.member WHERE email = address FOR UPDATE;
  has_member := FOUND;

  IF NOT p_reset THEN
    IF active_admins > 0 THEN
      RAISE EXCEPTION 'staff.bootstrap_admin: an active Admin exists' USING ERRCODE = 'FB001';
    END IF;
    IF NOT (has_member AND m.role_key = 'admin' AND m.status = 'pending')
       AND EXISTS (SELECT 1 FROM staff.member
                    WHERE role_key = 'admin' AND status = 'pending' AND email <> address) THEN
      RAISE EXCEPTION 'staff.bootstrap_admin: another address is a pending Admin' USING ERRCODE = 'FB002';
    END IF;
    IF has_member AND m.status = 'active' THEN
      RAISE EXCEPTION 'staff.bootstrap_admin: the address is an active member' USING ERRCODE = 'FB003';
    END IF;
    IF has_member THEN
      staff_id := m.id;
      reactivated := true;
    ELSE
      staff_id := p_ids ->> 'member_id';
    END IF;
    PERFORM audit.record(actor || jsonb_build_object(
      'id', p_ids ->> 'member_event_id',
      'event', 'staff.member_added',
      'target_id', staff_id,
      'metadata', jsonb_build_object('roleKey', 'admin', 'reactivated', reactivated)));
    IF has_member THEN
      UPDATE staff.member
         SET role_key = 'admin', status = 'pending', removed_at = NULL, factor_enrolled_at = NULL,
             added_by = 'operator', updated_at = statement_timestamp()
       WHERE id = staff_id;
    ELSE
      INSERT INTO staff.member (id, email, role_key, status, added_by, created_at, updated_at)
      VALUES (staff_id, address, 'admin', 'pending', 'operator', statement_timestamp(), statement_timestamp());
    END IF;
  ELSE
    IF NOT has_member OR m.role_key <> 'admin' OR m.status <> 'active' THEN
      RAISE EXCEPTION 'staff.bootstrap_admin: a reset names an active Admin' USING ERRCODE = 'FB004';
    END IF;
    IF active_admins > 1 THEN
      RAISE EXCEPTION 'staff.bootstrap_admin: another active Admin can reset them' USING ERRCODE = 'FB005';
    END IF;
    staff_id := m.id;
    -- The sign-in codes already emailed to them go with their sessions, so that no sign-in begun
    -- before the reset finishes after it.
    DELETE FROM staff.verification WHERE identifier = 'sign-in-otp-' || m.email;
    DELETE FROM staff.session WHERE user_id = staff_id;
    GET DIAGNOSTICS sessions_ended = ROW_COUNT;
    DELETE FROM staff.passkey WHERE user_id = staff_id;
    GET DIAGNOSTICS passkeys_removed = ROW_COUNT;
    DELETE FROM staff.two_factor WHERE user_id = staff_id AND verified;
    GET DIAGNOSTICS authenticators_removed = ROW_COUNT;
    DELETE FROM staff.two_factor WHERE user_id = staff_id;
    PERFORM audit.record(actor || jsonb_build_object(
      'id', p_ids ->> 'member_event_id',
      'event', 'staff.factors_reset',
      'target_id', staff_id,
      'metadata', jsonb_build_object('sessionsEnded', sessions_ended,
        'factorsRemoved', passkeys_removed + authenticators_removed)));
    PERFORM audit.record_journal(jsonb_build_object(
      'id', p_ids ->> 'journal_id', 'audit_event_id', p_ids ->> 'member_event_id'));
    UPDATE staff.member
       SET status = 'pending', factor_enrolled_at = NULL, two_factor_enabled = false,
           updated_at = statement_timestamp()
     WHERE id = staff_id;
  END IF;

  UPDATE staff.enrolment_code SET voided_at = statement_timestamp()
   WHERE member_id = staff_id AND redeemed_at IS NULL AND voided_at IS NULL;
  PERFORM audit.record(actor || jsonb_build_object(
    'id', p_ids ->> 'code_event_id',
    'event', 'staff.enrolment_code_issued',
    'target_id', code_id,
    'ref_ids', jsonb_build_array(staff_id),
    'metadata', jsonb_build_object('reason', 'bootstrap')));
  INSERT INTO staff.enrolment_code (id, member_id, code_hash, reason, issued_by, issued_at, expires_at)
  VALUES (code_id, staff_id, p_code_hash, 'bootstrap', 'operator', statement_timestamp(),
          statement_timestamp() + interval '30 minutes');
  PERFORM audit.record(actor || jsonb_build_object(
    'id', p_ids ->> 'bootstrap_event_id',
    'event', 'staff.bootstrapped',
    'target_id', staff_id,
    'ref_ids', jsonb_build_array(code_id),
    'metadata', jsonb_build_object('reset', p_reset, 'reasonCode', p_reason_code)));

  RETURN jsonb_build_object('staff_id', staff_id, 'enrolment_code_id', code_id,
    'reactivated', reactivated, 'reset', p_reset);
END
$fn$;

-- Only fin_owner, in a registered operator run, ever runs it: no grant to any service role.
REVOKE ALL ON FUNCTION staff.bootstrap_admin(text, bytea, boolean, text, text, text, jsonb) FROM PUBLIC;
