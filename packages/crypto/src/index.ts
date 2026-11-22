// @fin/crypto: sealing, HKDF, keyed hashes, argon2id, SCRAM verifiers and constant-time
// comparisons, all on node:crypto with no dependency (ARCHITECTURE §6.6, §7; DECISIONS DA-06, SA-07).
export {
  ARGON2ID_DEFAULTS,
  type Argon2Params,
  hashPassword,
  needsRehash,
  PasswordHashError,
  parsePasswordHash,
  verifyPassword,
} from "./argon2.ts";
export {
  EncodingError,
  fromBase64NoPad,
  fromBase64Url,
  fromHex,
  toBase64NoPad,
  toBase64Url,
  toHex,
} from "./bytes.ts";
export { constantTimeEqual, constantTimeEqualBytes } from "./compare.ts";
export { hkdfSha256 } from "./hkdf.ts";
export {
  beneficiaryFingerprint,
  cursorMac,
  hmacSha256,
  type IndexHash,
  type IndexScope,
  type IndexUse,
  indexHashesForWrite,
  indexHashForSearch,
  limitKeyHash,
  type Mode,
  verifyCursorMac,
} from "./keyed-hash.ts";
export {
  createKeyring,
  KEY_BYTES,
  type KeyFamily,
  type Keyring,
  KeyringConfigError,
  keyringFromEnv,
} from "./keyring.ts";
export {
  generateDatabasePassword,
  isScramVerifier,
  parseScramVerifier,
  SCRAM_ITERATIONS,
  ScramVerifierError,
  scramSha256Verifier,
} from "./scram.ts";
export {
  createSealer,
  type Sealer,
  type SealField,
  SealOpenError,
  type SealPurpose,
} from "./seal.ts";
