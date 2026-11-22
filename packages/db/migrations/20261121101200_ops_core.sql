-- ops core (spec 01 §6.10 row 5; ARCHITECTURE §4.6, §6.1, §15.1; DECISIONS OP-01, DA-14, DA-16). Run as
-- fin_owner. ops.schema_migrations belongs to the runner and ops.privileged_login to the bootstrap;
-- this file adds the rest of Phase 0's ops tables and their checked functions.
--
-- SQLSTATE FJ001: a job kind the caller's role may not enqueue (or no such kind); FJ002: a job's shape.
-- FS001: a kill switch the caller may not change this way.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The worker's match of each privileged login with a registered run (§8.7, privileged-login).
CREATE TABLE ops.privileged_login_check (
  login_id   bigint PRIMARY KEY REFERENCES ops.privileged_login (id),
  result     text NOT NULL CHECK (result IN ('matched', 'unmatched', 'replication')),
  run_id     text CHECK (char_length(run_id) BETWEEN 1 AND 64),
  checked_at timestamptz NOT NULL
);

-- Kill switches (OP-01), read on every request with no cache. `on` stops the work.
CREATE TABLE ops.kill_switch (
  name            text PRIMARY KEY CHECK (name ~ '^[a-z][a-z_]*(:[a-z0-9][a-z0-9_-]{0,62})?$'),
  state           text NOT NULL CHECK (state IN ('on', 'off')),
  reason_code     text CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  changed_by_kind text CHECK (changed_by_kind IN ('staff', 'operator', 'system')),
  changed_by_id   text CHECK (char_length(changed_by_id) <= 64),
  changed_at      timestamptz NOT NULL
);
-- The six switches of ARCHITECTURE §15.1 and spec 08 §8.6, seeded off before the guard exists. There
-- is no whole-API switch in the database: all of `api.` is stopped by the Cloudflare rule alone.
INSERT INTO ops.kill_switch (name, state, reason_code, changed_by_kind, changed_by_id, changed_at) VALUES
  ('live_keys', 'off', NULL, 'system', NULL, now()),
  ('live_money', 'off', NULL, 'system', NULL, now()),
  ('signups', 'off', NULL, 'system', NULL, now()),
  ('hosted_verify', 'off', NULL, 'system', NULL, now()),
  ('outbound_webhooks', 'off', NULL, 'system', NULL, now()),
  ('sumsub_writes', 'off', NULL, 'system', NULL, now());
-- Spec 08 §3.5 (D08-20): no switch row is inserted or changes state without its event.
SELECT audit.install_guard('ops.kill_switch'::regclass, ARRAY['INSERT', 'UPDATE OF state'], 'name',
  ARRAY['switch.set', 'switch.cleared', 'switch.tripped']);

-- One lease row per scheduler (ARCHITECTURE §4.6), not advisory locks, which any login can take.
CREATE TABLE ops.scheduler_lease (
  name       text PRIMARY KEY CHECK (name IN ('worker', 'payments')),
  holder     text CHECK (char_length(holder) <= 128),
  until      timestamptz,
  renewed_at timestamptz
);
INSERT INTO ops.scheduler_lease (name) VALUES ('worker'), ('payments');
ALTER TABLE ops.scheduler_lease ENABLE ROW LEVEL SECURITY;
CREATE POLICY scheduler_lease_worker ON ops.scheduler_lease TO fin_worker
  USING (name = 'worker') WITH CHECK (name = 'worker');
CREATE POLICY scheduler_lease_payments ON ops.scheduler_lease TO fin_payments
  USING (name = 'payments') WITH CHECK (name = 'payments');
CREATE POLICY scheduler_lease_probe ON ops.scheduler_lease FOR SELECT TO fin_probe USING (true);

-- Each duty's last success, per scheduler, under the lease's row-level security.
CREATE TABLE ops.duty_state (
  scheduler            text NOT NULL CHECK (scheduler IN ('worker', 'payments')),
  duty                 text NOT NULL CHECK (duty ~ '^[a-z][a-z0-9-]{1,62}$'),
  last_success_at      timestamptz,
  last_attempt_at      timestamptz,
  last_result          text CHECK (last_result IN ('ok', 'failed')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  PRIMARY KEY (scheduler, duty)
);
ALTER TABLE ops.duty_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY duty_state_worker ON ops.duty_state TO fin_worker
  USING (scheduler = 'worker') WITH CHECK (scheduler = 'worker');
CREATE POLICY duty_state_payments ON ops.duty_state TO fin_payments
  USING (scheduler = 'payments') WITH CHECK (scheduler = 'payments');
CREATE POLICY duty_state_probe ON ops.duty_state FOR SELECT TO fin_probe USING (true);

-- Coarse request windows: UNLOGGED, so they are lost on a crash, which only coarse windows may be
-- (DA-16); lockouts and pauses live in logged tables (spec 02).
CREATE UNLOGGED TABLE ops.rate_window (
  key          text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 200),
  window_start timestamptz NOT NULL,
  count        integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (key, window_start)
);

-- Generic one-off jobs (ARCHITECTURE §4.6). Phase 0 registers only ops.noop, for the tests.
CREATE TABLE ops.job_kind (
  kind          text PRIMARY KEY CHECK (kind ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  enqueue_roles text[] NOT NULL CHECK (
                  cardinality(enqueue_roles) >= 1
                  AND enqueue_roles <@ ARRAY['fin_api', 'fin_worker', 'fin_payments']::text[]),
  runner        text NOT NULL CHECK (runner IN ('worker', 'payments'))
);
INSERT INTO ops.job_kind (kind, enqueue_roles, runner) VALUES ('ops.noop', ARRAY['fin_worker'], 'worker');

CREATE TABLE ops.job (
  id              text PRIMARY KEY CHECK (id ~ '^job_[0-9a-hjkmnp-tv-z]{26}$'),
  kind            text NOT NULL REFERENCES ops.job_kind (kind),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4096),
  priority        smallint NOT NULL DEFAULT 100,
  due_at          timestamptz NOT NULL,
  lease_until     timestamptz,
  leased_by       text CHECK (char_length(leased_by) <= 128),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    integer NOT NULL DEFAULT 10 CHECK (max_attempts BETWEEN 1 AND 100),
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
  last_error_code text CHECK (last_error_code ~ '^[a-z][a-z0-9_.]{0,63}$'),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);
CREATE INDEX job_due ON ops.job (priority, due_at) WHERE state = 'pending';
-- The kind's runner, and only it, sees and claims its rows.
ALTER TABLE ops.job ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_worker ON ops.job TO fin_worker
  USING (EXISTS (SELECT 1 FROM ops.job_kind k WHERE k.kind = job.kind AND k.runner = 'worker'))
  WITH CHECK (EXISTS (SELECT 1 FROM ops.job_kind k WHERE k.kind = job.kind AND k.runner = 'worker'));
CREATE POLICY job_payments ON ops.job TO fin_payments
  USING (EXISTS (SELECT 1 FROM ops.job_kind k WHERE k.kind = job.kind AND k.runner = 'payments'))
  WITH CHECK (EXISTS (SELECT 1 FROM ops.job_kind k WHERE k.kind = job.kind AND k.runner = 'payments'));

-- ops.set_switch: Fin Admin (staff, with switches.manage and a step-up intent checked in the app) and
-- the operator's task (fin_owner). The caller records switch.set or switch.cleared in the same
-- transaction; the guard refuses the commit otherwise. Until that event is registered, it fails
-- closed (FA001).
CREATE FUNCTION ops.set_switch(p_name text, p_state text, p_reason_code text, p_actor jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, pg_temp
AS $fn$
DECLARE
  ev text;
  actor_kind text;
  actor_id text;
  is_admin boolean;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('on', 'off') THEN
    RAISE EXCEPTION 'ops.set_switch: state is on or off' USING ERRCODE = '22023';
  END IF;
  ev := CASE p_state WHEN 'on' THEN 'switch.set' ELSE 'switch.cleared' END;
  IF NOT EXISTS (SELECT 1 FROM audit.event_type t WHERE t.name = ev AND NOT t.retired) THEN
    RAISE EXCEPTION 'ops.set_switch: % is not registered', ev USING ERRCODE = 'FA001';
  END IF;
  IF p_reason_code IS NOT NULL AND p_reason_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'ops.set_switch: reason code shape' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL OR jsonb_typeof(p_actor) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_actor) AS k(key) WHERE k.key NOT IN ('kind', 'id')) THEN
    RAISE EXCEPTION 'ops.set_switch: actor is {kind, id}' USING ERRCODE = '22023';
  END IF;
  actor_kind := p_actor ->> 'kind';
  actor_id := p_actor ->> 'id';
  is_admin := pg_catalog.pg_has_role(session_user, 'fin_admin', 'MEMBER');
  IF is_admin AND (actor_kind IS DISTINCT FROM 'staff' OR coalesce(actor_id, '') !~ '^stf_[0-9a-hjkmnp-tv-z]{26}$') THEN
    RAISE EXCEPTION 'ops.set_switch: Fin Admin acts as a staff member' USING ERRCODE = 'FS001';
  END IF;
  IF NOT is_admin AND (session_user <> 'fin_owner' OR actor_kind IS DISTINCT FROM 'operator'
       OR coalesce(actor_id, '') = '' OR char_length(actor_id) > 64) THEN
    RAISE EXCEPTION 'ops.set_switch: only Fin Admin or an operator task' USING ERRCODE = 'FS001';
  END IF;
  UPDATE ops.kill_switch
  SET state = p_state, reason_code = p_reason_code, changed_by_kind = actor_kind,
      changed_by_id = actor_id, changed_at = pg_catalog.statement_timestamp()
  WHERE name = p_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ops.set_switch: no such switch' USING ERRCODE = 'FS001';
  END IF;
END
$fn$;

-- ops.trip_switch: the automatic money trips (payments and the worker's reconciliation). It only sets
-- `on`, never clears, only the money switches, and records switch.tripped itself. The event's ID and
-- the release come from the caller (IDs are made in the application, DA-02).
CREATE FUNCTION ops.trip_switch(p_name text, p_reason_code text, p_ref text, p_via text,
  p_event_id text, p_release text, p_request_id text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit.event_type t WHERE t.name = 'switch.tripped' AND NOT t.retired) THEN
    RAISE EXCEPTION 'ops.trip_switch: switch.tripped is not registered' USING ERRCODE = 'FA001';
  END IF;
  IF p_name IS NULL OR (p_name <> 'live_money' AND p_name !~ '^provider_instance:[a-z0-9][a-z0-9_-]{0,62}$') THEN
    RAISE EXCEPTION 'ops.trip_switch: only the money switches trip automatically' USING ERRCODE = 'FS001';
  END IF;
  IF p_reason_code IS NULL OR p_reason_code NOT IN ('idempotency_mismatch', 'sent_after_end',
       'orphan_payout', 'reconciliation_break') THEN
    RAISE EXCEPTION 'ops.trip_switch: reason code' USING ERRCODE = '22023';
  END IF;
  IF p_via IS NULL OR p_via NOT IN ('reconciliation', 'job') THEN
    RAISE EXCEPTION 'ops.trip_switch: via is reconciliation or job' USING ERRCODE = '22023';
  END IF;
  IF p_ref IS NOT NULL AND (char_length(p_ref) > 64 OR p_ref !~ '^[a-z]{2,4}_[0-9a-hjkmnp-tv-z]{26}$') THEN
    RAISE EXCEPTION 'ops.trip_switch: ref is an ID' USING ERRCODE = '22023';
  END IF;
  UPDATE ops.kill_switch
  SET state = 'on', reason_code = p_reason_code, changed_by_kind = 'system', changed_by_id = NULL,
      changed_at = pg_catalog.statement_timestamp()
  WHERE name = p_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ops.trip_switch: no such switch' USING ERRCODE = 'FS001';
  END IF;
  PERFORM audit.record(jsonb_build_object(
    'id', p_event_id,
    'event', 'switch.tripped',
    'actor_kind', 'system',
    'actor_via', p_via,
    'target_id', p_name,
    'metadata', jsonb_build_object('reasonCode', p_reason_code, 'ref', p_ref),
    'request_id', p_request_id,
    'release', p_release));
END
$fn$;

-- ops.enqueue_job: the only way a job row is written. The kind must list one of the caller's groups.
CREATE FUNCTION ops.enqueue_job(p_id text, p_kind text, p_payload jsonb, p_due_at timestamptz DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, pg_temp
AS $fn$
DECLARE
  k ops.job_kind%ROWTYPE;
BEGIN
  SELECT * INTO k FROM ops.job_kind WHERE kind = p_kind;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM unnest(k.enqueue_roles) AS r(name)
    JOIN pg_catalog.pg_roles pr ON pr.rolname = r.name
    WHERE pg_catalog.pg_has_role(session_user, pr.oid, 'MEMBER')
  ) THEN
    RAISE EXCEPTION 'ops.enqueue_job: this login may not enqueue that kind' USING ERRCODE = 'FJ001';
  END IF;
  IF coalesce(p_id, '') !~ '^job_[0-9a-hjkmnp-tv-z]{26}$' THEN
    RAISE EXCEPTION 'ops.enqueue_job: id shape' USING ERRCODE = 'FJ002';
  END IF;
  IF p_payload IS NOT NULL AND (jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text) > 4096) THEN
    RAISE EXCEPTION 'ops.enqueue_job: payload is an object of at most 4 KB' USING ERRCODE = 'FJ002';
  END IF;
  INSERT INTO ops.job (id, kind, payload, due_at, created_at, updated_at)
  VALUES (p_id, p_kind, coalesce(p_payload, '{}'::jsonb),
          coalesce(p_due_at, pg_catalog.statement_timestamp()),
          pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp());
  PERFORM pg_catalog.pg_notify('jobs_' || k.runner, '');
  RETURN p_id;
END
$fn$;

-- ops.sweep_rate_windows: the worker deletes old windows only through this (never fresher than an hour).
CREATE FUNCTION ops.sweep_rate_windows(p_older_than interval DEFAULT interval '1 day')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, pg_temp
AS $fn$
DECLARE
  deleted integer;
BEGIN
  IF p_older_than IS NULL OR p_older_than < interval '1 hour' THEN
    RAISE EXCEPTION 'ops.sweep_rate_windows: at least an hour old' USING ERRCODE = '22023';
  END IF;
  DELETE FROM ops.rate_window WHERE window_start < pg_catalog.statement_timestamp() - p_older_than;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END
$fn$;

REVOKE ALL ON FUNCTION ops.set_switch(text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.trip_switch(text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.enqueue_job(text, text, jsonb, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.sweep_rate_windows(interval) FROM PUBLIC;
