// Fin Admin's route policy, assembled from its area fragments (spec 02 §14.1, §14.3). `/api/auth/*`
// is the staff realm's library behind its endpoint allowlist (@fin/identity, §4.3) and
// `/api/health` is the shared host's; every other route is listed here exactly once.
//
// Not routed on Saturday, as §14.3 marks it: the custom staff role writes (stretch 3), recorded in
// the pull request's open items. `GET /api/audit` (Sunday's spill screen) reads through the staff
// package's two SECURITY DEFINER reads until `api`'s door has its staff operation.
import { ACCOUNT_POLICIES } from "./account.ts";
import { AUDIT_POLICIES } from "./audit.ts";
import { SESSION_POLICIES } from "./session.ts";
import { STAFF_POLICIES } from "./staff.ts";
import { SWITCH_POLICIES } from "./switches.ts";
import { definePolicies } from "./types.ts";

export const ADMIN_POLICIES = definePolicies([
  ...SESSION_POLICIES,
  ...ACCOUNT_POLICIES,
  ...STAFF_POLICIES,
  ...SWITCH_POLICIES,
  ...AUDIT_POLICIES,
] as const);

export type AdminPolicy = (typeof ADMIN_POLICIES)[number];
export type PolicyId = AdminPolicy["id"];

export type { Method, RoutePolicy } from "./types.ts";
