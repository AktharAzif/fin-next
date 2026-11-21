// @fin/testing: test-only code, built only into the `test` image target and the e2e harness
// (ARCHITECTURE §3.1, [SA-38]). Playwright's fixtures are at @fin/testing/playwright.

export { decodeToken, signRs256, unsignedToken, verifyRs256 } from "./access/jwt.ts";
export {
  type AccessGate,
  type AccessIdentity,
  type AccessJwk,
  AccessStandIn,
  type AccessStandInOptions,
  type IssueOptions,
  type RunningAccessStandIn,
  startAccessStandIn,
} from "./access/stand-in.ts";
export {
  type AddressBook,
  CANON,
  type Canon,
  type CanonWriter,
  checkCanon,
  createAddressBook,
  type SeededCanon,
  type SeededRandom,
  scopeCanon,
  seedCanon,
  seededRandom,
  seedFromEnv,
  testScope,
} from "./canon/index.ts";
export {
  CANON_TIME,
  type Clock,
  durationMs,
  e2eClock,
  FrozenClock,
  freezeBrowserClock,
  type JourneyClock,
  journeyClock,
  type RunClock,
} from "./clock.ts";
export {
  AUTH_CODE,
  COMPANY_EMAIL_CODE,
  codeFrom,
  codePatternFor,
  EmailSinkReader,
  linksFrom,
} from "./email/reader.ts";
export {
  EmailSink,
  isFixtureAddress,
  type RunningEmailSink,
  type SinkFilter,
  type SinkMessage,
  type SinkMessageInput,
  startEmailSink,
} from "./email/sink.ts";
export { selfSignedIdentity, type TlsIdentity } from "./http/certificate.ts";
export {
  ACCESS_STAND_IN_PORT,
  appHostName,
  appLoopbackOrigin,
  appOrigin,
  EMAIL_SINK_PORT,
  type HostRole,
  STATIC_APPS,
  testAccessAudience,
  testIngressProof,
} from "./static-host/apps.ts";
export {
  applyHeaderRules,
  compileHeaders,
  type HeaderRule,
  parseHeaders,
  parseHeadersStrict,
} from "./static-host/headers.ts";
export { createStaticHost, type RequestLine, type StaticHostOptions } from "./static-host/host.ts";
export { normaliseEdgePath } from "./static-host/paths.ts";
export { type RunningStaticHost, startStaticHost } from "./static-host/server.ts";
export {
  base32Decode,
  base32Encode,
  hotp,
  msUntilNextStep,
  parseOtpauthUri,
  totp,
  totpCounter,
} from "./totp.ts";
