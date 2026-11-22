// @fin/web-host: the API host the app services share, the origin gate, the Access check, and (in
// src/static/, a control path) the static hosts' header profiles and their renderer.
export {
  ACCESS_HEADER,
  type AccessCheckOptions,
  AccessKeysUnavailable,
  type AccessRefusal,
  type AccessResult,
  AccessVerifier,
  type AccessVerifierOptions,
  accessCheck,
  accessIssuer,
} from "./access-jwt.ts";
export {
  APP_ROLES,
  type ApiHostOptions,
  type AppName,
  type AuthClass,
  type AuthHook,
  BODY_LIMIT_BYTES,
  createApiHost,
} from "./api-host.ts";
export {
  type BodyRequest,
  bodyDecision,
  type GateCode,
  type GateRefusalOptions,
  type GateRequest,
  gateDecision,
  hasBody,
  type OriginGateOptions,
  originGate,
  type RouteBodyCheckOptions,
  type RouteRegistration,
  routeBodyCheck,
  SAFE_METHODS,
} from "./origin-gate.ts";
export { type ApiServiceHooks, buildApiService, defineApiService } from "./service.ts";
export {
  OUTPUT_PROFILE,
  PROFILES,
  type ProfileName,
  type StaticOutput,
} from "./static/profiles.ts";
export {
  contentSecurityPolicy,
  hstsValue,
  type Rendered,
  type RenderInput,
  renderEnvJson,
  renderHeaders,
  renderStatic,
} from "./static/render.ts";
