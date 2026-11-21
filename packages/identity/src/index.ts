// @fin/identity: the two Better Auth realms and everything around them that is Fin's own
// (spec 02 §3 to §7, §11): the factory, the endpoint allowlist, the gate, step-up intents and
// windows, emailed codes, known and trusted browsers, limits, names, sessions and enrolment codes.
export {
  eventTypeRows,
  IDENTITY_EVENTS,
  REALM_EVENTS,
  STAFF_REALM_EVENTS,
} from "./audit/events.ts";
export {
  type AuditActor,
  type AuditInput,
  createRecordAudit,
  type RecordAudit,
} from "./audit/record.ts";
export { AuditMetadataError, assertNoPersonalShapes, personalShapeOf } from "./audit/shapes.ts";
export { codeLinkAsking } from "./codes.ts";
export {
  type Environment,
  expectedTrustedOrigins,
  REALM_HOST_ROLE,
  REFUSED_ENV,
  RealmConfigError,
  type RealmName,
  type RealmSettings,
  readRealmSettings,
} from "./config.ts";
export { finCookieName, readCookie, serializeFinCookie } from "./cookies.ts";
export { KeyedHasher } from "./crypto/keyed.ts";
export { deviceSummary } from "./device.ts";
export { createEmailEnqueue, type EmailEnqueue } from "./email/enqueue.ts";
export { IDENTITY_TEMPLATES, REALM_TEMPLATES, STAFF_REALM_TEMPLATES } from "./email/templates.ts";
export {
  authPathOf,
  createEndpointPolicy,
  type EndpointPolicy,
  type EndpointRule,
} from "./endpoint-policy.ts";
export { type AuthProblemCode, AuthRefusal, problemResponse } from "./errors.ts";
export {
  canSkipProtect,
  developerGate,
  PRIVILEGED_PERMISSIONS,
  personGate,
  staffGate,
  trustedBrowserEligible,
} from "./gate.ts";
export { REALM_GUARDS } from "./guards.ts";
export { createLimitStore, LIMITS, type LimitStore } from "./limits.ts";
export { checkName, NAME_RULES, type NameKind } from "./names.ts";
export {
  createPasswordHasher,
  type PasswordHasher,
  type PasswordHasherOptions,
} from "./passwords/hasher.ts";
export { type ResetLinkState, resetCodeLink } from "./passwords/links.ts";
export {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordProblem,
  passwordProblem,
} from "./passwords/policy.ts";
export { type Clock, ManualClock, systemClock } from "./ports/clock.ts";
export { AuditGuardError, type FinDatabase, UnitRolledBackError, type UnitTx } from "./ports/db.ts";
export { isId, newId } from "./ports/ids.ts";
export { type LineSink, MemoryLineSink } from "./ports/log.ts";
export { createPgDatabase, type PgFinDatabase } from "./ports/pg-database.ts";
export {
  buildAuthOptions,
  createRealm,
  type Realm,
  type RealmDeps,
  type RealmSession,
} from "./realm.ts";
export type { RequestContext } from "./request.ts";
export { type PersonActor, requirePerson } from "./require-person.ts";
export { revokeOtherSessions, revokeSession } from "./sessions.ts";
export { signUp } from "./sign-up.ts";
export {
  generateEnrolmentCode,
  hasMixedGroup,
  issueEnrolmentCode,
  redeemEnrolmentCode,
} from "./staff/enrolment.ts";
export { canonicalJson, paramsDigest } from "./step-up/digest.ts";
export { hasFreshProof } from "./step-up/intents.ts";
export type { StepUpAction } from "./step-up/types.ts";
