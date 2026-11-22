-- A stand-in for P0-E's revocation journal (packages/db's _audit_journal: audit.journal_entry and
-- audit.record_journal(p jsonb)) over the identity lane's platform fixture, for this package's
-- integration tests only. It keeps the real function's interface and its refusals: the entry's
-- event must be in this transaction and recorded by this login (FA007), its type must declare a
-- journal kind and have no entry yet (FA009); what the entry says comes from the event's own row.
ALTER TABLE audit.event_type ADD COLUMN journal_kind text;

CREATE TABLE audit.journal_entry (
  id text PRIMARY KEY CHECK (id ~ '^jrn_[0-9a-hjkmnp-tv-z]{26}$'),
  kind text NOT NULL,
  organization_id text,
  subject_ids text[] NOT NULL CHECK (cardinality(subject_ids) BETWEEN 1 AND 33),
  audit_event_id text NOT NULL UNIQUE REFERENCES audit.event (id),
  recorded_at timestamptz NOT NULL
);

CREATE FUNCTION audit.record_journal(p jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = audit, pg_temp AS $$
DECLARE
  ev audit.event%ROWTYPE;
  entry_kind text;
  k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('id', 'audit_event_id') THEN
      RAISE EXCEPTION 'audit.record_journal: unknown key %', k USING ERRCODE = 'FA006';
    END IF;
  END LOOP;
  IF coalesce(p ->> 'id', '') !~ '^jrn_[0-9a-hjkmnp-tv-z]{26}$' THEN
    RAISE EXCEPTION 'audit.record_journal: id shape' USING ERRCODE = 'FA005';
  END IF;
  SELECT * INTO ev FROM audit.event
   WHERE id = p ->> 'audit_event_id' AND xid = pg_catalog.pg_current_xact_id() AND seq IS NULL
     AND db_login = session_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit.record_journal: the event is not in this transaction' USING ERRCODE = 'FA007';
  END IF;
  SELECT t.journal_kind INTO entry_kind FROM audit.event_type t WHERE t.name = ev.event;
  IF entry_kind IS NULL THEN
    RAISE EXCEPTION 'audit.record_journal: no journal entry declared' USING ERRCODE = 'FA009';
  END IF;
  IF EXISTS (SELECT 1 FROM audit.journal_entry j WHERE j.audit_event_id = ev.id) THEN
    RAISE EXCEPTION 'audit.record_journal: the event already has its entry' USING ERRCODE = 'FA009';
  END IF;
  INSERT INTO audit.journal_entry (id, kind, organization_id, subject_ids, audit_event_id, recorded_at)
  VALUES (p ->> 'id', entry_kind, ev.organization_id, ARRAY[ev.target_id] || ev.ref_ids, ev.id,
          pg_catalog.statement_timestamp());
  RETURN p ->> 'id';
END
$$;

REVOKE EXECUTE ON FUNCTION audit.record_journal(jsonb) FROM PUBLIC;
