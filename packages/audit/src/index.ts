// @fin/audit: the event registry and its fragments, recordAudit, the chain hash and verifier walk, the
// registry sync, the sequencer loop and the automatic switch trips (spec 08 §3; ARCHITECTURE §8).
export {
  CHAIN_SELECT,
  type ChainCheck,
  type ChainFailure,
  type ChainRow,
  rowHash,
  verifyRows,
  ZERO_HASH,
} from "./chain.ts";
export {
  ACTOR_KINDS,
  type ActorKind,
  type ActorVia,
  type AuditCategory,
  AuditRegistryError,
  type AuditRole,
  type AuditScope,
  CATEGORIES,
  defineEvents,
  type EventSpec,
  isFlatStrictObject,
  type JournalKind,
  ROLES,
  SCOPES,
} from "./define.ts";
export {
  AUDIT_EVENT_AREAS,
  AUDIT_EVENTS,
  type AuditEventName,
  type AuditEvents,
} from "./events/_index.gen.ts";
export {
  type AuditActor,
  AuditEventError,
  type AuditEventId,
  AuditWriteError,
  eventSpec,
  type RecordInput,
  recordAudit,
  storedUserAgent,
  USER_AGENT_MAX,
} from "./record.ts";
export {
  oldestUnsequencedSeconds,
  runSequencer,
  SEQUENCER_BATCH,
  type SequencerOptions,
  sequencePass,
} from "./sequencer.ts";
export {
  AuditMetadataError,
  assertNoPersonalShapes,
  assertStorableText,
  personalShapeOf,
} from "./shapes.ts";
export { type Trip, type TripReason, tripSwitch } from "./switches.ts";
export { type EventTypeRow, eventTypeRows, type SyncResult, syncEventTypes } from "./sync.ts";
