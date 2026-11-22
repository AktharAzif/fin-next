// The staff area's step-up actions (spec 02 §7.6, IF-03): every staff change and the kill switches
// take an intent bound to the action, its target and the fields below. The reason key is the
// AdminStepUp board's ("Use your second factor to {reason}.", §15.5), keyed by the action. The
// staff realm's own credential and session actions (`staff.factor_add`, `staff.session_revoke`,
// ...) are @fin/identity's fragment; createRealm assembles both and refuses a key listed twice.
// Custom staff roles' actions (`staffRole.*`) join with their routes (stretch 3).
import type { StepUpAction } from "@fin/identity";

export const STAFF_ACTIONS = [
  {
    key: "staff.add",
    realm: "staff",
    kind: "intent",
    reasonKey: "staff.add",
    bind: [
      { name: "email", kind: "address" },
      { name: "roleKey", kind: "string" },
    ],
  },
  {
    key: "staff.role",
    realm: "staff",
    kind: "intent",
    reasonKey: "staff.role",
    bind: [{ name: "roleKey", kind: "string" }],
  },
  { key: "staff.remove", realm: "staff", kind: "intent", reasonKey: "staff.remove", bind: [] },
  {
    key: "staff.reset_factors",
    realm: "staff",
    kind: "intent",
    reasonKey: "staff.reset_factors",
    bind: [],
  },
  {
    key: "staff.enrolment_code",
    realm: "staff",
    kind: "intent",
    reasonKey: "staff.enrolment_code",
    bind: [],
  },
  {
    key: "switch.set",
    realm: "staff",
    kind: "intent",
    reasonKey: "switch.set",
    bind: [
      { name: "state", kind: "string" },
      { name: "reasonCode", kind: "string" },
    ],
  },
] as const satisfies readonly StepUpAction[];

export type StaffActionKey = (typeof STAFF_ACTIONS)[number]["key"];
