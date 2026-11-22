// The two Fin routes reachable below aal2 (spec 02 §6.4, §14.3, §14.4; T-SAT-14, AC-SAT-40): the
// viewer, in every staff state, and the pending member's enrolment-code redemption.
import { noParams, redeemBody } from "./schemas.ts";
import { definePolicies } from "./types.ts";

export const SESSION_POLICIES = definePolicies([
  {
    id: "viewer.get",
    method: "GET",
    path: "/api/viewer",
    guard: "requireStaff",
    permission: null,
    scope: "staff",
    stepUp: "none",
    action: null,
    bind: [],
    assurance: "aal1_allowed",
    params: noParams,
    query: null,
    body: null,
    limits: [],
    audit: [],
    secret: false,
  },
  {
    id: "enrolment.redeem",
    method: "POST",
    path: "/api/enrolment/redeem",
    guard: "requireStaff",
    permission: null,
    scope: "staff",
    stepUp: "none",
    action: null,
    bind: [],
    assurance: "aal1_allowed",
    params: noParams,
    query: null,
    body: redeemBody,
    limits: [],
    audit: ["staff.enrolment_code_redeemed"],
    secret: false,
  },
] as const);
