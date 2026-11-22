// The organisation area's step-up actions (spec 02 §7.6, IF-03): every organisation, invitation,
// member and role change takes an intent bound to the action, the organisation, the target and the
// fields listed in `bind`. Spec 02 §7.6 places the fragment at
// packages/identity/src/step-up/actions/orgs.ts; this lane owns packages/orgs/** only, so the
// fragment lives here and the console hands it to createRealm({ actions }), which refuses a key
// listed twice. The reason keys are the StepUp board's (§15.5).
import type { StepUpAction } from "@fin/identity";

export const ORGS_ACTIONS = [
  {
    key: "org.create",
    realm: "developer",
    kind: "intent",
    reasonKey: "create_organisation",
    bind: [{ name: "name", kind: "string" }],
  },
  {
    key: "org.rename",
    realm: "developer",
    kind: "intent",
    reasonKey: "rename_organisation",
    bind: [{ name: "name", kind: "string" }],
  },
  {
    key: "org.delete",
    realm: "developer",
    kind: "intent",
    reasonKey: "delete_organisation",
    bind: [{ name: "confirmName", kind: "string" }],
  },
  {
    key: "member.invite",
    realm: "developer",
    kind: "intent",
    reasonKey: "invite_someone",
    bind: [
      { name: "email", kind: "address" },
      { name: "roleKey", kind: "string" },
    ],
  },
  {
    key: "invitation.change",
    realm: "developer",
    kind: "intent",
    reasonKey: "change_invitation",
    bind: [{ name: "roleKey", kind: "string" }],
  },
  {
    key: "invitation.resend",
    realm: "developer",
    kind: "intent",
    reasonKey: "resend_invitation",
    bind: [],
  },
  {
    key: "invitation.cancel",
    realm: "developer",
    kind: "intent",
    reasonKey: "cancel_invitation",
    bind: [],
  },
  {
    key: "invitation.accept",
    realm: "developer",
    kind: "intent",
    reasonKey: "join_team",
    bind: [],
  },
  {
    key: "member.role",
    realm: "developer",
    kind: "intent",
    reasonKey: "change_role",
    bind: [
      { name: "roleKey", kind: "string" },
      { name: "rollCredentials", kind: "value" },
    ],
  },
  {
    key: "member.remove",
    realm: "developer",
    kind: "intent",
    reasonKey: "remove_someone",
    bind: [{ name: "rollCredentials", kind: "value" }],
  },
  {
    key: "role.create",
    realm: "developer",
    kind: "intent",
    reasonKey: "create_role",
    bind: [
      { name: "name", kind: "string" },
      { name: "description", kind: "string" },
      { name: "permissions", kind: "keys" },
    ],
  },
  {
    key: "role.update",
    realm: "developer",
    kind: "intent",
    reasonKey: "change_role_permissions",
    bind: [
      { name: "name", kind: "string" },
      { name: "description", kind: "string" },
      { name: "permissions", kind: "keys" },
      { name: "version", kind: "value" },
    ],
  },
  {
    key: "role.delete",
    realm: "developer",
    kind: "intent",
    reasonKey: "delete_role",
    // The role the holders move to, and the holders the actor was shown (beyond §7.6's `moveTo`,
    // so a proved intent moves nobody given the role after the actor looked; recorded in the PR).
    bind: [
      { name: "moveTo", kind: "string" },
      { name: "holders", kind: "keys" },
    ],
  },
] as const satisfies readonly StepUpAction[];

export type OrgsActionKey = (typeof ORGS_ACTIONS)[number]["key"];
