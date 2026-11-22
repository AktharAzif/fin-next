// @fin/staff: Fin Admin's staff (spec 02 §6.4, §6.5, §8.3, §10, §16.4, §17.3): requireStaff and
// the same-person check, staff members and the prebuilt roles, the staff-change lock and the last
// Admin, enrolment codes, the kill switches, the Access drift check, the staff area's audit events
// and its notices. The staff realm itself (Better Auth, the gate, the ceremonies) is @fin/identity's.
export {
  type AccessApplication,
  AccessDriftUnavailable,
  type AllowList,
  allowListOf,
  compareAccess,
  type DriftResult,
  readAllowList,
  runAccessDriftCheck,
  staffAccessList,
} from "./access-drift.ts";
export {
  revokeOtherStaffSessions,
  revokeStaffSession,
  type StaffAccount,
  staffAccount,
} from "./account.ts";
export { STAFF_ACTIONS, type StaffActionKey } from "./actions.ts";
export {
  REASON_CODE,
  RECORDED_EVENTS,
  type RecordedEventName,
  STAFF_EVENTS,
  type StaffEventName,
  staffEventTypeRows,
} from "./audit/events.ts";
export {
  type AuditActorInput,
  createRecordStaffAudit,
  type RecordStaffAudit,
  StaffAuditError,
  staffAuditPayload,
} from "./audit/record.ts";
export {
  isStaffPermission,
  lowers,
  PREBUILT_ROLE_KEYS,
  resolveStaffRole,
  STAFF_CATALOGUE,
  staffPermissionsOf,
  staffRoleLabel,
  TOP_ROLE,
} from "./catalogue.ts";
export { createStaffDeps, type StaffDeps } from "./deps.ts";
export {
  activeAdminAddresses,
  createEnqueueStaffNotice,
  type EnqueueStaffNotice,
  type StaffNotice,
  StaffNoticeError,
} from "./email.ts";
export {
  ENROLMENT_CODE_LIFETIME_MS,
  generateEnrolmentCode,
  hashEnrolmentCode,
  type IssuedCode,
  issueEnrolmentCode,
  normaliseEnrolmentCode,
} from "./enrolment-codes.ts";
export { type StaffProblemCode, StaffRefusal } from "./errors.ts";
export { isIdOf } from "./ids.ts";
export {
  actorInsideLock,
  memberForChange,
  otherActiveAdmins,
  takeStaffChangeLock,
} from "./lock.ts";
export {
  type AddedStaff,
  addStaff,
  changeStaffRole,
  listStaff,
  newEnrolmentCode,
  normaliseAddress,
  redeemCode,
  refuseLastActiveAdmin,
  removeStaff,
  resetStaffFactors,
  type StaffListRow,
} from "./members.ts";
export type { Queryable, RequestFacts, UnitTx } from "./ports.ts";
export {
  type FactorMethod,
  methodsOf,
  type RequireStaffOptions,
  requestFacts,
  requireStaff,
  type StaffActor,
  type StaffGateState,
} from "./require-staff.ts";
export { getStaffRole, listStaffRoles, type StaffRoleDetail, type StaffRoleView } from "./roles.ts";
export { INTENT_HEADER, type IntentRefusal, intentProblem, requireIntent } from "./step-up.ts";
export { listSwitches, SWITCH_NAME, type SwitchRow, setSwitch } from "./switches.ts";
export { type StaffViewer, staffViewer } from "./viewer.ts";
