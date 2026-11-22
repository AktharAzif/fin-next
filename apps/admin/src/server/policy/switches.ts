// The kill switches (spec 02 §14.3, S2-27; the screen is Sunday's pending composition).
import { noParams, switchBody, switchNameParams } from "./schemas.ts";
import { definePolicies } from "./types.ts";

export const SWITCH_POLICIES = definePolicies([
  {
    id: "switches.list",
    method: "GET",
    path: "/api/switches",
    guard: "requireStaff",
    permission: "switches.manage",
    scope: "staff",
    stepUp: "none",
    action: null,
    bind: [],
    assurance: "aal2_or_working",
    params: noParams,
    query: null,
    body: null,
    limits: [],
    audit: [],
    secret: false,
  },
  {
    id: "switches.set",
    method: "POST",
    path: "/api/switches/:switchName",
    guard: "requireStaff",
    permission: "switches.manage",
    scope: "staff",
    stepUp: "intent",
    action: "switch.set",
    bind: ["state", "reasonCode"],
    assurance: "aal2_or_working",
    params: switchNameParams,
    query: null,
    body: switchBody,
    limits: ["step_up_intents"],
    audit: ["switch.set", "switch.cleared"],
    secret: false,
  },
] as const);
