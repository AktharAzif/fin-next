import type { BindField } from "./digest.ts";

/**
 * `window`: a factor shown in this session within 5 minutes. `intent`: an intent bound to the
 * action and its parameters, proved and consumed once. `intent_after_first_factor`: the
 * first-factor rule while the person has no factor (§6.3), an intent once one exists.
 */
export type StepUpKind = "window" | "intent" | "intent_after_first_factor";

export interface StepUpAction {
  readonly key: string;
  readonly realm: "developer" | "staff";
  readonly kind: StepUpKind;
  /** The StepUp board's reason line key ("Use your second factor to {reason}.", §15.5). */
  readonly reasonKey: string;
  /** The request fields the digest covers besides realm, action, organisation and target. */
  readonly bind: readonly BindField[];
}

export type ProofMethod = "passkey" | "totp" | "backup_code";

export type IntentRefusal =
  | "unproved"
  | "expired"
  | "used"
  | "other_session"
  | "other_action"
  | "digest";
