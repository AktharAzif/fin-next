// @fin/testing/playwright: the shared journey fixtures and helpers (spec 06 §10.2, §11.3).
export { type AccessSignIn, accessLoginUrl, signInThroughAccess } from "./access.ts";
export {
  installAuthenticator,
  rpIdFor,
  type VirtualAuthenticator,
  type VirtualCredential,
} from "./authenticator.ts";
export {
  CSP_INIT_SCRIPT,
  type CspViolation,
  type CspWatcher,
  isPolicyConsoleMessage,
  watchCsp,
} from "./csp.ts";
export {
  expect,
  type FinFixtures,
  type FinOptions,
  prepareContext,
  type ResolvedContextOptions,
  refuseBypassCsp,
  refuseResolvedBypassCsp,
  secondContextOptions,
  test,
} from "./fixtures.ts";
export {
  isOffsite,
  type OffsiteOptions,
  type OffsiteRequest,
  type OffsiteWatcher,
  watchOffsite,
} from "./offsite.ts";
export { gotoReady, READY_SELECTOR, waitForReady } from "./ready.ts";
