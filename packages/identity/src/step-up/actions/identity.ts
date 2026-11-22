// The identity area's step-up actions (spec 02 §7.6, IF-03): the person's own credentials and
// sessions in both realms. Each area adds its fragment beside this one
// (`step-up/actions/<area>.ts`) under the same rules; index.ts assembles them.
import type { StepUpAction } from "../types.ts";

export const IDENTITY_ACTIONS: readonly StepUpAction[] = [
  { key: "account.name", realm: "developer", kind: "window", reasonKey: "change_name", bind: [] },
  {
    key: "account.passkey_add",
    realm: "developer",
    kind: "intent_after_first_factor",
    reasonKey: "add_passkey",
    bind: [],
  },
  {
    key: "account.passkey_remove",
    realm: "developer",
    kind: "intent",
    reasonKey: "remove_passkey",
    bind: [{ name: "id", kind: "string" }],
  },
  {
    key: "account.totp_enable",
    realm: "developer",
    kind: "intent_after_first_factor",
    reasonKey: "add_authenticator",
    bind: [],
  },
  {
    key: "account.totp_disable",
    realm: "developer",
    kind: "intent",
    reasonKey: "remove_authenticator",
    bind: [],
  },
  {
    key: "account.backup_codes",
    realm: "developer",
    kind: "intent",
    reasonKey: "new_backup_codes",
    bind: [],
  },
  {
    key: "account.session_revoke",
    realm: "developer",
    kind: "intent",
    reasonKey: "sign_out_session",
    bind: [],
  },
  {
    key: "account.sessions_revoke_others",
    realm: "developer",
    kind: "intent",
    reasonKey: "sign_out_everywhere",
    bind: [],
  },
  {
    key: "account.trusted_browser_revoke",
    realm: "developer",
    kind: "intent",
    reasonKey: "forget_browser",
    bind: [],
  },
  {
    key: "staff.factor_add",
    realm: "staff",
    kind: "intent_after_first_factor",
    reasonKey: "add_factor",
    bind: [],
  },
  {
    key: "staff.factor_remove",
    realm: "staff",
    kind: "intent",
    reasonKey: "remove_factor",
    bind: [{ name: "id", kind: "string" }],
  },
  {
    key: "staff.session_revoke",
    realm: "staff",
    kind: "intent",
    reasonKey: "sign_out_session",
    bind: [],
  },
  {
    key: "staff.sessions_revoke_others",
    realm: "staff",
    kind: "intent",
    reasonKey: "sign_out_everywhere",
    bind: [],
  },
];

/** Which action guards each `step_up_self` library path, per realm (§7.6). */
export const SELF_PATH_ACTIONS = {
  developer: {
    "/passkey/generate-register-options": "account.passkey_add",
    "/passkey/verify-registration": "account.passkey_add",
    "/passkey/delete-passkey": "account.passkey_remove",
    "/two-factor/enable": "account.totp_enable",
    "/two-factor/disable": "account.totp_disable",
    "/two-factor/generate-backup-codes": "account.backup_codes",
  },
  staff: {
    "/passkey/generate-register-options": "staff.factor_add",
    "/passkey/verify-registration": "staff.factor_add",
    "/passkey/delete-passkey": "staff.factor_remove",
    "/two-factor/enable": "staff.factor_add",
    "/two-factor/disable": "staff.factor_remove",
  },
} as const satisfies Record<"developer" | "staff", Record<string, string>>;
