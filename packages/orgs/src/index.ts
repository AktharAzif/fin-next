// @fin/orgs: organisations, members, invitations and custom roles, and `requireActor` (spec 02 §9,
// §13.2, §14.1; DECISIONS SA-10, SA-11, SA-32, SA-33, SA-34, BC-06), on the developer realm of
// @fin/identity and the permission engine of @fin/access.

export {
  type EventSpec,
  eventTypeRows,
  ORGS_EVENTS,
  type OrgsEventName,
  REALM_WRITTEN_EVENTS,
} from "./audit/events.ts";
export {
  createRecordOrgAudit,
  type OrgAuditActor,
  type OrgAuditInput,
  orgAuditPayload,
  type RecordOrgAudit,
  type RequestFacts,
} from "./audit/record.ts";
export {
  type AuditLogQuery,
  type AuditLogRow,
  type AuditRange,
  deviceOf,
  ORGANISATION_CATEGORIES,
  type OrganisationCategory,
  organisationLog,
  personActivity,
  startOfDay,
  windowOf,
} from "./audit-log.ts";
export { revokeTrustedBrowsers } from "./browsers.ts";
export {
  type CredentialItem,
  CredentialRegistry,
  type CredentialSource,
  type ListedCredential,
  type RollOutcome,
} from "./credentials.ts";
export {
  createRole,
  deleteRole,
  getRole,
  listRoles,
  type RoleDetail,
  updateRole,
} from "./custom-roles.ts";
export {
  createEnqueueOrgEmail,
  displayValue,
  type EnqueueOrgEmail,
  ORG_TEMPLATES,
  type OrgEmail,
  type OrgTemplate,
} from "./email.ts";
export {
  type FieldProblem,
  invalid,
  isOrgRefusal,
  notFound,
  ORG_PROBLEM_STATUS,
  ORG_PROBLEM_TITLE,
  type OrgProblemCode,
  OrgRefusal,
} from "./errors.ts";
export {
  type ActorOptions,
  type FactorMethod,
  type GateState,
  type Guarded,
  type GuardOptions,
  methodsOf,
  ORGANIZATION_HEADER,
  type OrgActor,
  organizationIdOf,
  type Person,
  personGuard,
  type RealmState,
  requireActor,
  type StepUpRule,
} from "./guard.ts";
export { type GuardRegistration, guardSql, NEVER, ORGS_GUARDS } from "./guards.ts";
export { type DateClock, isId, newId } from "./ids.ts";
export { INTENT_HEADER } from "./intents.ts";
export {
  acceptInvitation,
  cancelInvitation,
  changeInvitation,
  declineInvitation,
  INVITATION_LIFETIME_MS,
  type InvitationState,
  type InvitationView,
  invitationFromCookie,
  inviteMember,
  myInvitations,
  openInvitation,
  pendingInvitationsFor,
  resendInvitation,
} from "./invitations.ts";
export {
  ORG_LIMITS,
  type OrgLimitBucket,
  OrgLimits,
  PENDING_INVITATIONS,
  SUPER_ADMIN_ORGANISATIONS,
} from "./limits.ts";
export {
  changeMemberRole,
  memberCredentials,
  removeMember,
  type TeamInvitation,
  type TeamMember,
  teamList,
} from "./members.ts";
export {
  createFirstOrganization,
  createOrganization,
  deleteOrganization,
  firstOrganizationName,
  listOrganizations,
  type OrganizationSummary,
  organisationName,
  organizationProfile,
  renameOrganization,
  switchOrganization,
} from "./organizations.ts";
export { createOrgs, notifyEach, type Orgs, type OrgsOptions } from "./orgs.ts";
export { ORGS_ACTIONS, type OrgsActionKey } from "./step-up.ts";
export {
  CATALOGUE,
  customRolesOf,
  customRolesOfMany,
  labelOf,
  lookupRole,
  membershipsOfPerson,
  permissionsFor,
  TOP_ROLE,
} from "./store.ts";
export {
  INVITATION_COOKIE_MAX_AGE_S,
  InvitationCookie,
  isInvitationToken,
  maskAddress,
  newInvitationToken,
  tokenHash,
} from "./tokens.ts";
