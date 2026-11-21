// @fin/keys: API keys (spec 05 §4; spec 02 §12; ARCHITECTURE §7.7). The key's format and checksum
// salts, scopes bounded by the maker's role, address allowlists, the stored hash and its pepper
// chain, the lifecycle the console's API half calls, the edge's check and its statements, the audit
// and email adapters, and the step-up actions. `@fin/keys/format` is the browser-safe subpath.
export {
  type AllowlistProblem,
  type AllowlistRefusal,
  allowlistAllows,
  entryProblem,
  formatRange,
  MAX_ALLOWLIST_ENTRIES,
  normaliseAllowlist,
  parseAddress,
  parseRange,
} from "./allowlist.ts";
export {
  createRecordKeyAudit,
  KEY_EVENTS,
  type KeyAuditActor,
  type KeyAuditInput,
  type KeyEventName,
  keyAuditPayload,
  keyEventTypeRows,
  type RecordKeyAudit,
} from "./audit.ts";
export { BASE62_ALPHABET, base62, base62Random } from "./base62.ts";
export { crc32, crc32Ascii } from "./crc32.ts";
export { CROCKFORD_ALPHABET, crockfordFromBytes, isKeyId, KEY_ID_LENGTH } from "./crockford.ts";
export {
  createEnqueueKeyEmail,
  type EnqueueKeyEmail,
  KEY_TEMPLATES,
  type KeyEmail,
  type KeyTemplate,
  keyTemplateGrants,
} from "./email.ts";
export {
  invalidField,
  isKeyRefusal,
  type KeyExtensions,
  type KeyFieldProblem,
  type KeyProblemCode,
  KeyRefusal,
} from "./errors.ts";
export {
  buildKey,
  CHECKSUM_LENGTH,
  checksumOf,
  KEY_LENGTH,
  KEY_REGEX,
  type KeyKind,
  type KeyMode,
  keyPrefix,
  otherDeploymentSalt,
  type ParsedKey,
  parseKey,
  SECRET_LENGTH,
  verifyChecksum,
} from "./format.ts";
export { type NewKey, newKey, newKeyId, type RandomBytes, systemRandom } from "./generate.ts";
export {
  chainHash,
  decoyCompare,
  HASH_BYTES,
  hashForStorage,
  matchesStored,
  PepperMissingError,
  rehash,
} from "./hash.ts";
export {
  abilitiesOf,
  type CreateInput,
  createKey,
  createKeys,
  EXPIRY_CHOICES,
  type ExpiryChoice,
  type KeyAbilities,
  type KeyActor,
  type KeyList,
  type KeyStatus,
  type Keys,
  type KeyView,
  keysOfMember,
  listKeys,
  type MadeKey,
  type MemberKey,
  OVERLAPS,
  type Overlap,
  type RolledKey,
  revokeKey,
  rollForMember,
  rollKey,
  type UpdateInput,
  updateKey,
  WORKING_KEY_LIMIT,
} from "./lifecycle.ts";
export {
  KEY_WINDOW_LIMIT,
  type KeyStore,
  keyStore,
  keyWindowKey,
  LOOKUP_SQL,
  type Lookup,
  type Queryable,
  REFUSED_KEYS_LIMIT,
  refusedWindowKey,
  WINDOW_SECONDS,
  type WindowCount,
} from "./lookup.ts";
export { checkKeyName, KEY_NAME_MAX, KEY_NAME_SENTENCE, type KeyNameRefusal } from "./names.ts";
export { type KeyEnvironment, KNOWN_SALTS, SALTS, saltFor } from "./salts.ts";
export {
  accessLabel,
  checkScopes,
  FULL_ACCESS_NEEDS,
  isScope,
  KEY_SCOPE_NEEDS,
  type MakeableKeys,
  MONEY_SCOPES,
  makeableFor,
  managePermission,
  missingPermissions,
  permissionsNeeded,
  SANDBOX_ONLY_SCOPES,
  SCOPES,
  type Scope,
  type ScopeProblem,
  scopesAllowedFor,
} from "./scopes.ts";
export { type KeySettings, keySettingsAbsent, keySettingsFromEnv } from "./settings.ts";
export { KEYS_ACTIONS, type KeysActionKey } from "./step-up.ts";
export type { DateClock, KeysLines, KeysTx } from "./tx.ts";
export {
  bearerOf,
  type Judgement,
  judgeKey,
  type KeyReason,
  type KeyRecord,
  type LiveRefusal,
  liveGate,
  type OrgLiveStatus,
  type Precheck,
  precheck,
  type VerifiedKey,
} from "./verify.ts";
