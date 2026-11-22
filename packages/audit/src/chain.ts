// The audit chain's hash, version 1 (spec 08 §3.6), recomputed outside the database, and the walk that
// checks a run of chained rows (§3.8 step 2). It must equal audit.row_hash byte for byte (T08-09):
// SHA-256 over the fields in order, each a 4-byte big-endian length then its UTF-8 bytes, a null as
// FF FF FF FF with nothing after. The verifier reads `metadata::text`, `xid::text` and the formatted
// `recorded_at` from the database and never re-serialises them.
import { createHash } from "node:crypto";

export const HASH_VERSION_LITERAL = "fin-audit-v1";
export const ZERO_HASH: Buffer = Buffer.alloc(32);

/** A chained row as the verifier selects it (see CHAIN_SELECT). */
export interface ChainRow {
  epoch: number;
  seq: string;
  id: string;
  event: string;
  category: string;
  scope: string;
  organization_id: string | null;
  subject_user_id: string | null;
  mode: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_via: string;
  actor_key_id: string | null;
  actor_link_session_id: string | null;
  step_up_kind: string | null;
  step_up_method: string | null;
  step_up_ref: string | null;
  target_id: string;
  ref_ids: readonly string[];
  metadata_text: string;
  request_id: string | null;
  release: string;
  db_login: string;
  app_name: string;
  backend_pid: number;
  xid: string;
  recorded_at_text: string;
  prev_hash: Buffer | null;
  hash: Buffer | null;
}

/** The select list that yields ChainRow from audit.event (alias `e`). */
export const CHAIN_SELECT = `e.epoch, e.seq::text AS seq, e.id, e.event, e.category, e.scope, e.organization_id,
  e.subject_user_id, e.mode, e.actor_kind, e.actor_id, e.actor_via, e.actor_key_id, e.actor_link_session_id,
  e.step_up_kind, e.step_up_method, e.step_up_ref, e.target_id, e.ref_ids, e.metadata::text AS metadata_text,
  e.request_id, e.release, e.db_login, e.app_name, e.backend_pid, e.xid::text AS xid,
  to_char(e.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at_text,
  e.prev_hash, e.hash`;

const NULL_FIELD = Buffer.from([0xff, 0xff, 0xff, 0xff]);

function field(value: string | null): Buffer[] {
  if (value === null) return [NULL_FIELD];
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength);
  return [length, bytes];
}

function rawField(value: Buffer | null): Buffer[] {
  if (value === null) return [NULL_FIELD];
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.byteLength);
  return [length, value];
}

/** audit.row_hash(row, prevHash), version 1. */
export function rowHash(row: ChainRow, prevHash: Buffer | null): Buffer {
  const parts: Buffer[] = [
    ...field(HASH_VERSION_LITERAL),
    ...field(String(row.epoch)),
    ...field(row.seq),
    ...rawField(prevHash),
    ...field(row.id),
    ...field(row.event),
    ...field(row.category),
    ...field(row.scope),
    ...field(row.organization_id),
    ...field(row.subject_user_id),
    ...field(row.mode),
    ...field(row.actor_kind),
    ...field(row.actor_id),
    ...field(row.actor_via),
    ...field(row.actor_key_id),
    ...field(row.actor_link_session_id),
    ...field(row.step_up_kind),
    ...field(row.step_up_method),
    ...field(row.step_up_ref),
    ...field(row.target_id),
    ...field(String(row.ref_ids.length)),
    ...row.ref_ids.flatMap((ref) => field(ref)),
    ...field(row.metadata_text),
    ...field(row.request_id),
    ...field(row.release),
    ...field(row.db_login),
    ...field(row.app_name),
    ...field(String(row.backend_pid)),
    ...field(row.xid),
    ...field(row.recorded_at_text),
  ];
  return createHash("sha256").update(Buffer.concat(parts)).digest();
}

export type ChainFailure = { reason: "hash" | "link" | "gap"; epoch: number; seq: string };

export interface ChainCheck {
  ok: boolean;
  failure?: ChainFailure;
  /** The last row that verified: where the next check starts. */
  lastSeq: string;
  lastHash: Buffer;
  checked: number;
}

/**
 * Walks rows of one epoch in `seq` order from a verified point (`afterSeq`, `afterHash`): each row's
 * seq must follow the last with no gap, its prev_hash must be the last hash, and its stored hash must
 * be the recomputed one. Stops at the first failure.
 */
export function verifyRows(
  rows: readonly ChainRow[],
  afterSeq: string,
  afterHash: Buffer,
): ChainCheck {
  let lastSeq = BigInt(afterSeq);
  let lastHash = afterHash;
  let checked = 0;
  for (const row of rows) {
    const seq = BigInt(row.seq);
    if (seq !== lastSeq + 1n) {
      return {
        ok: false,
        failure: { reason: "gap", epoch: row.epoch, seq: row.seq },
        lastSeq: String(lastSeq),
        lastHash,
        checked,
      };
    }
    if (row.prev_hash === null || !row.prev_hash.equals(lastHash)) {
      return {
        ok: false,
        failure: { reason: "link", epoch: row.epoch, seq: row.seq },
        lastSeq: String(lastSeq),
        lastHash,
        checked,
      };
    }
    const computed = rowHash(row, row.prev_hash);
    if (row.hash === null || !row.hash.equals(computed)) {
      return {
        ok: false,
        failure: { reason: "hash", epoch: row.epoch, seq: row.seq },
        lastSeq: String(lastSeq),
        lastHash,
        checked,
      };
    }
    lastSeq = seq;
    lastHash = row.hash;
    checked += 1;
  }
  return { ok: true, lastSeq: String(lastSeq), lastHash, checked };
}
