// @fin/app-contracts: the web apps' own JSON routes (FW-C08). Browser-safe: Zod only, no server
// package and no node:* module (FW-C12). Each area's lane adds its contracts in `src/<area>/**`
// (spec 06 §11.3) and exports them here. `z` is Zod configured for the page policy (./zod.ts):
// browser code builds its schemas with it, never with "zod" directly.

export {
  APP_NAMES,
  type AppContract,
  type AppName,
  type ContractInput,
  type ContractOutput,
  defineContract,
  type HttpMethod,
  isUnsafeMethod,
  noContent,
  noInput,
  pathParams,
} from "./contract.ts";
export {
  type ConsoleMembership,
  type ConsoleViewer,
  type ConsoleViewerSignedIn,
  consoleViewer,
  consoleViewerAnswer,
  setCurrentOrganization,
} from "./identity/viewer.ts";
export { health, healthAnswer } from "./platform/health.ts";
export {
  PROBLEM_CONTENT_TYPE,
  type Problem,
  problemSchema,
  rateLimitedSchema,
  STEP_UP_METHODS,
  type StepUpMethod,
  type StepUpRequired,
  secondFactorRequiredSchema,
  stepUpRequiredSchema,
} from "./problem.ts";
export {
  STAFF_ENVIRONMENTS,
  type StaffViewer,
  type StaffViewerSignedIn,
  staffViewer,
  staffViewerAnswer,
} from "./staff/viewer.ts";
export { z } from "./zod.ts";
