// The staff area's integration harness on the real platform, for this package's
// tests and Fin Admin's (apps/admin). Imported only by *.test.ts files.
export {
  type AccessIdentity,
  ADMIN_ORIGIN,
  type Answer,
  type AuditRow,
  accessFor,
  Browser,
  createStaffHarness,
  DOCS_ORIGIN,
  SoftAuthenticator,
  type StaffHarness,
  signInByCode,
  staffRealmEnv,
  unique,
} from "./harness.ts";
export {
  createStaffPlatform,
  DROP_TIMEOUT_MS,
  eventTypes,
  type PlatformClient,
  type StaffPlatform,
} from "./platform.mjs";
