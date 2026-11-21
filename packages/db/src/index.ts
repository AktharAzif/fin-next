// @fin/db: the pool and unit of work, the migration runner and bootstrap, the grant matrix, the guard
// registrations and typed access to Phase 0's ops tables (spec 01 §6.6, §6.10; ARCHITECTURE §3.5, §4.5,
// §6). Test helpers are in `@fin/db/testing`.
export {
  type BootstrapInput,
  type BootstrapResult,
  bootstrap,
  bootstrapFiles,
  type Environment,
  parseReplicas,
  parseRoleVerifiers,
} from "./bootstrap.ts";
export {
  type Credentials,
  connectClient,
  type DatabaseTarget,
  type PresentedCertificate,
  parseSuperuserUrl,
  readPresentedCertificate,
  withOwnerSession,
} from "./connect.ts";
export {
  type Clock,
  discardLines,
  type Line,
  type LineSink,
  type LineValue,
  type UnitContext,
} from "./context.ts";
export {
  AuditGuardError,
  ClientHeldAcrossCallError,
  DatabaseConfigError,
  LoginCheckError,
  MigrationError,
  NestedUnitError,
  SessionStateError,
  TransactionAbortedError,
  UnitClosedError,
} from "./errors.ts";
export {
  applyGrants,
  expandMatrix,
  expectedMemberships,
  type GrantDrift,
  type GrantFragment,
  grantDrift,
  liveMemberships,
  livePrivileges,
  loadFragments,
  type Membership,
  membershipKey,
  type Privilege,
} from "./grants.ts";
export { defineGuards, type GuardOperation, type GuardRegistration } from "./guards/types.ts";
export { createIdSource, type IdSource, idPattern, isId, newId } from "./ids.ts";
export { assertServiceLogin } from "./login-check.ts";
export {
  BOOTSTRAP_DIR,
  GRANTS_DIR,
  MIGRATION_NAME,
  MIGRATIONS_DIR,
  type MigrationFile,
  migrationsNotAfterMain,
  parseMigration,
  type RunResult,
  readMigrations,
  runMigrations,
  schemaVersion,
} from "./migrations.ts";
export {
  acquireLease,
  type DutyState,
  type EnqueueJob,
  enqueueJob,
  isSwitchOn,
  KILL_SWITCHES,
  type KillSwitch,
  LEASE_SECONDS,
  readDutyStates,
  recordDutyRun,
  releaseLease,
  type Scheduler,
} from "./ops.ts";
export {
  commitTransaction,
  type PgClient,
  PgDatabaseError,
  type PgPool,
  sqlState,
} from "./pg.ts";
export {
  type ConnectionSettings,
  clientConfig,
  createPool,
  InsecureAuthenticationError,
  type PoolSettings,
  poolSettingsFromEnv,
  ScramOnlyClient,
  type TlsSettings,
} from "./pool.ts";
export {
  connectionLimit,
  ENQUEUE_OWNER,
  FIN_ROLES,
  FIN_SCHEMAS,
  GRANTEE_ROLES,
  groupOf,
  POOL_BUDGET,
  SERVICE_GROUPS,
  SERVICE_LOGINS,
  type ServiceGroup,
  type ServiceLogin,
  type ServiceName,
} from "./roles.ts";
export {
  assertNotHoldingClient,
  createDatabase,
  type FinDatabase,
  isHoldingClient,
  type Queryable,
  type UnitTx,
} from "./unit.ts";
