-- audit journal and anchors (spec 08 §3.7, §3.10; spec 01 §6.10 row 4; DECISIONS AU-03, AU-04). Run as
-- fin_owner. The tables are written only through the SECURITY DEFINER functions below:
--   - audit.record_journal(): the journal entry an access-removing event declares, written by
--     recordAudit in the action's transaction, and refused unless that transaction recorded the event.
--     Everything the entry says comes from the event: its kind from the event type's journal_kind,
--     its organisation and subjects from the event's own row, one entry per event. A restore replays
--     the automatic kinds without asking anyone, so no caller may choose what an entry revokes;
--   - audit.record_anchor(), audit.record_anchor_conflict(): the anchoring duty's outcomes, each
--     accepted only under the object key that names its head, and an audit head only when the chain
--     actually reached it;
--   - audit.mark_journal_shipped(): the shipper's record of each entry it wrote to the vault.
-- SQLSTATE FA007: a journal entry whose event is not in the same transaction; FA009: an event that
-- declares no journal kind, or already has its entry.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE audit.journal_entry (
  id              text PRIMARY KEY CHECK (id ~ '^jrn_[0-9a-hjkmnp-tv-z]{26}$'),
  epoch           integer NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('key_revoked', 'key_rolled', 'sessions_ended',
                    'member_removed', 'invitation_cancelled', 'role_lowered', 'organisation_deleted',
                    'organisation_paused', 'factor_removed', 'trusted_browser_revoked', 'staff_removed',
                    'staff_factors_reset', 'staff_role_lowered', 'links_revoked', 'customer_erased',
                    'webhook_secret_rolled', 'webhook_endpoint_deleted', 'beneficiary_removed',
                    'switch_set', 'switch_cleared')),
  organization_id text,
  subject_ids     text[] NOT NULL CHECK (cardinality(subject_ids) BETWEEN 1 AND 33),
  audit_event_id  text NOT NULL REFERENCES audit.event (id),
  recorded_at     timestamptz NOT NULL
);
CREATE UNIQUE INDEX journal_entry_event ON audit.journal_entry (audit_event_id);
CREATE INDEX journal_entry_recorded ON audit.journal_entry (recorded_at, id);

CREATE TABLE audit.journal_shipped (
  entry_id   text PRIMARY KEY REFERENCES audit.journal_entry (id),
  object_key text NOT NULL UNIQUE
               CHECK (object_key ~ '^journal/e[1-9][0-9]*/[0-9]{8}T[0-9]{6}Z-jrn_[0-9a-hjkmnp-tv-z]{26}\.json$'),
  shipped_at timestamptz NOT NULL
);

CREATE TABLE audit.anchor (
  kind       text NOT NULL CHECK (kind IN ('audit', 'ledger')),
  epoch      integer NOT NULL CHECK (epoch >= 1),
  seq        bigint NOT NULL CHECK (seq >= 0),
  hash       bytea NOT NULL CHECK (octet_length(hash) = 32),
  object_key text NOT NULL UNIQUE
               CHECK (object_key ~ '^(audit|ledger)/head/e[1-9][0-9]*/[0-9]{12}-[0-9a-f]{16}\.json$'),
  written_at timestamptz NOT NULL,
  PRIMARY KEY (kind, epoch, seq)
);

CREATE TABLE audit.anchor_conflict (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('audit', 'ledger')),
  epoch         integer NOT NULL,
  seq           bigint NOT NULL,
  object_key    text NOT NULL,
  expected_hash bytea NOT NULL CHECK (octet_length(expected_hash) = 32),
  found_sha256  bytea CHECK (octet_length(found_sha256) = 32),
  detected_at   timestamptz NOT NULL
);

CREATE TRIGGER journal_entry_append_only BEFORE UPDATE OR DELETE ON audit.journal_entry
  FOR EACH ROW EXECUTE FUNCTION audit.append_only();
CREATE TRIGGER journal_entry_no_truncate BEFORE TRUNCATE ON audit.journal_entry
  FOR EACH STATEMENT EXECUTE FUNCTION audit.append_only();
CREATE TRIGGER journal_shipped_append_only BEFORE UPDATE OR DELETE ON audit.journal_shipped
  FOR EACH ROW EXECUTE FUNCTION audit.append_only();
CREATE TRIGGER journal_shipped_no_truncate BEFORE TRUNCATE ON audit.journal_shipped
  FOR EACH STATEMENT EXECUTE FUNCTION audit.append_only();
CREATE TRIGGER anchor_append_only BEFORE UPDATE OR DELETE ON audit.anchor
  FOR EACH ROW EXECUTE FUNCTION audit.append_only();
CREATE TRIGGER anchor_no_truncate BEFORE TRUNCATE ON audit.anchor
  FOR EACH STATEMENT EXECUTE FUNCTION audit.append_only();
CREATE TRIGGER anchor_conflict_append_only BEFORE UPDATE OR DELETE ON audit.anchor_conflict
  FOR EACH ROW EXECUTE FUNCTION audit.append_only();
CREATE TRIGGER anchor_conflict_no_truncate BEFORE TRUNCATE ON audit.anchor_conflict
  FOR EACH STATEMENT EXECUTE FUNCTION audit.append_only();

-- The journal entry of an event recorded in this transaction by this login (§3.10). EXECUTE for the
-- roles that execute audit.record(). The caller gives only the entry's ID and the event's; whether to
-- write it at all (a fragment's conditional `when`) is recordAudit's, what it says is the event's: the
-- kind its type declares, its organisation, and its target followed by its refs as the subjects.
CREATE FUNCTION audit.record_journal(p jsonb) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $fn$
DECLARE
  ev audit.event%ROWTYPE;
  entry_kind text;
  k text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'audit.record_journal takes a JSON object' USING ERRCODE = 'FA006';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('id', 'audit_event_id') THEN
      RAISE EXCEPTION 'audit.record_journal: unknown key %', k USING ERRCODE = 'FA006';
    END IF;
  END LOOP;
  IF jsonb_typeof(p -> 'id') IS DISTINCT FROM 'string'
     OR (p ->> 'id') !~ '^jrn_[0-9a-hjkmnp-tv-z]{26}$' THEN
    RAISE EXCEPTION 'audit.record_journal: id shape' USING ERRCODE = 'FA005';
  END IF;
  IF jsonb_typeof(p -> 'audit_event_id') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'audit.record_journal: audit_event_id is required' USING ERRCODE = 'FA006';
  END IF;
  SELECT * INTO ev FROM audit.event
  WHERE id = p ->> 'audit_event_id'
    AND xid = pg_catalog.pg_current_xact_id()
    AND seq IS NULL
    AND db_login = session_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit.record_journal: the event is not in this transaction' USING ERRCODE = 'FA007';
  END IF;
  SELECT t.journal_kind INTO entry_kind FROM audit.event_type t WHERE t.name = ev.event;
  IF entry_kind IS NULL THEN
    RAISE EXCEPTION 'audit.record_journal: % declares no journal entry', ev.event USING ERRCODE = 'FA009';
  END IF;
  IF EXISTS (SELECT 1 FROM audit.journal_entry j WHERE j.audit_event_id = ev.id) THEN
    RAISE EXCEPTION 'audit.record_journal: the event already has its entry' USING ERRCODE = 'FA009';
  END IF;
  INSERT INTO audit.journal_entry (id, epoch, kind, organization_id, subject_ids, audit_event_id, recorded_at)
  VALUES (p ->> 'id', ev.epoch, entry_kind, ev.organization_id, ARRAY[ev.target_id] || ev.ref_ids, ev.id,
          pg_catalog.statement_timestamp());
  NOTIFY audit_journal;
  RETURN p ->> 'id';
END
$fn$;

-- The anchoring duty's record of a head written to the vault (§3.7). An audit anchor must name a
-- head the chain reached: an existing row's (epoch, seq, hash), or an epoch's start.
CREATE FUNCTION audit.record_anchor(p_kind text, p_epoch integer, p_seq bigint, p_hash bytea,
  p_object_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $fn$
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('audit', 'ledger') THEN
    RAISE EXCEPTION 'audit.record_anchor: kind' USING ERRCODE = '22023';
  END IF;
  IF p_object_key IS DISTINCT FROM format('%s/head/e%s/%s-%s.json', p_kind, p_epoch,
       lpad(p_seq::text, 12, '0'), left(encode(p_hash, 'hex'), 16)) THEN
    RAISE EXCEPTION 'audit.record_anchor: the object key does not name this head' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'audit' AND NOT EXISTS (
    SELECT 1 FROM audit.event e WHERE e.epoch = p_epoch AND e.seq = p_seq AND e.hash = p_hash
  ) AND NOT EXISTS (
    SELECT 1 FROM audit.head h WHERE h.epoch = p_epoch AND p_seq = 0 AND h.start_prev_hash = p_hash
  ) THEN
    RAISE EXCEPTION 'audit.record_anchor: no such head in the chain' USING ERRCODE = 'FA008';
  END IF;
  INSERT INTO audit.anchor (kind, epoch, seq, hash, object_key, written_at)
  VALUES (p_kind, p_epoch, p_seq, p_hash, p_object_key, pg_catalog.statement_timestamp())
  ON CONFLICT (kind, epoch, seq) DO NOTHING;
END
$fn$;

-- The anchoring duty's record of a head whose object already holds other content (a 412 that read
-- back differently, §3.7). Like an anchor, it must name its head by the object key, and an audit head
-- must be one the chain reached, so a caller cannot fill the table with conflicts that never were.
CREATE FUNCTION audit.record_anchor_conflict(p_kind text, p_epoch integer, p_seq bigint,
  p_object_key text, p_expected_hash bytea, p_found_sha256 bytea)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $fn$
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('audit', 'ledger') THEN
    RAISE EXCEPTION 'audit.record_anchor_conflict: kind' USING ERRCODE = '22023';
  END IF;
  IF p_object_key IS DISTINCT FROM format('%s/head/e%s/%s-%s.json', p_kind, p_epoch,
       lpad(p_seq::text, 12, '0'), left(encode(p_expected_hash, 'hex'), 16)) THEN
    RAISE EXCEPTION 'audit.record_anchor_conflict: the object key does not name this head'
      USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'audit' AND NOT EXISTS (
    SELECT 1 FROM audit.event e WHERE e.epoch = p_epoch AND e.seq = p_seq AND e.hash = p_expected_hash
  ) AND NOT EXISTS (
    SELECT 1 FROM audit.head h WHERE h.epoch = p_epoch AND p_seq = 0 AND h.start_prev_hash = p_expected_hash
  ) THEN
    RAISE EXCEPTION 'audit.record_anchor_conflict: no such head in the chain' USING ERRCODE = 'FA008';
  END IF;
  INSERT INTO audit.anchor_conflict (kind, epoch, seq, object_key, expected_hash, found_sha256, detected_at)
  VALUES (p_kind, p_epoch, p_seq, p_object_key, p_expected_hash, p_found_sha256,
          pg_catalog.statement_timestamp());
END
$fn$;

CREATE FUNCTION audit.mark_journal_shipped(p_entry_id text, p_object_key text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $fn$
DECLARE
  entry audit.journal_entry%ROWTYPE;
BEGIN
  SELECT * INTO entry FROM audit.journal_entry WHERE id = p_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit.mark_journal_shipped: no such entry' USING ERRCODE = '22023';
  END IF;
  IF p_object_key IS DISTINCT FROM format('journal/e%s/%s-%s.json', entry.epoch,
       to_char(entry.recorded_at AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'), entry.id) THEN
    RAISE EXCEPTION 'audit.mark_journal_shipped: the object key does not name this entry'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO audit.journal_shipped (entry_id, object_key, shipped_at)
  VALUES (entry.id, p_object_key, pg_catalog.statement_timestamp())
  ON CONFLICT (entry_id) DO NOTHING;
END
$fn$;

REVOKE ALL ON FUNCTION audit.record_journal(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.record_anchor(text, integer, bigint, bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.record_anchor_conflict(text, integer, bigint, text, bytea, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.mark_journal_shipped(text, text) FROM PUBLIC;
