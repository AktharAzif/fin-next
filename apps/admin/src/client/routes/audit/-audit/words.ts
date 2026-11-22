// What AdminAudit says about a row (the board's What, Who, Reason and "What changed"; spec 02
// §14.5: the sentences are drawn in the client from the row's IDs, codes and counts). Every
// staff-scope event of spec 08 §3.4's catalogue has its words here, grouped as the Action filter
// lists them; an event this file does not know is shown by its name. Nothing here is typed text
// from a row: metadata holds IDs, codes, counts and role keys only (spec 02 §16.1).
import type { AuditEntry } from "./contract.ts";

export interface ActionGroup {
  readonly label: string;
  readonly events: Readonly<Record<string, string>>;
}

/** The staff scope's events by area, in the Action filter's order. */
export const ACTION_GROUPS: readonly ActionGroup[] = [
  {
    label: "Customers",
    events: {
      "staff.customer_approved": "Approved a customer",
      "staff.customer_unapproved": "Unapproved a customer",
      "staff.customer_rejected": "Rejected a customer",
      "staff.customer_restart_allowed": "Sent a customer back to review",
      "staff.customer_details_shown": "Was shown the details",
      "staff.document_viewed": "Viewed a document",
      "staff.reveal_budget_reached": "Reached the limit on showing details",
      "staff.flag_resolved": "Resolved a flag",
    },
  },
  {
    label: "Requests for information",
    events: {
      "staff.rfi_created": "Asked for information",
      "staff.rfi_accepted": "Accepted an answer",
      "staff.rfi_more_needed": "Asked for more information",
      "staff.rfi_withdrawn": "Cancelled a request for information",
      "staff.rfi_changed": "Changed a request for information",
    },
  },
  {
    label: "Production access",
    events: {
      "staff.go_live_first_approval": "Gave the first approval for Production access",
      "staff.go_live_approved": "Approved Production access",
      "staff.go_live_changes_requested": "Requested Production access changes",
      "staff.go_live_declined": "Declined Production access",
      "staff.organization_paused": "Paused Production access",
      "staff.organization_restore_requested": "Asked to restore Production access",
      "staff.organization_restored": "Restored Production access",
      "staff.fin_approval_enabled": "Turned on Fin approves each customer",
      "staff.fin_approval_disabled": "Turned off Fin approves each customer",
      "staff.approval_cancelled": "Cancelled an approval",
      "staff.approval_expired": "Let an approval expire",
    },
  },
  {
    label: "Settings",
    events: {
      "staff.form_created": "Created a form",
      "staff.form_updated": "Changed a form",
      "staff.form_published": "Published a form",
      "staff.form_archived": "Archived a form",
      "staff.reason_preset_added": "Added a preset reason",
      "staff.reason_preset_renamed": "Renamed a preset reason",
      "staff.reason_preset_moved": "Moved a preset reason",
      "staff.reason_preset_retired": "Retired a preset reason",
      "staff.reason_preset_restored": "Brought back a preset reason",
      "staff.message_template_added": "Added a message template",
      "staff.message_template_changed": "Changed a message template",
      "staff.message_template_retired": "Retired a message template",
      "staff.message_template_restored": "Brought back a message template",
      "staff.saved_view_created": "Saved a view",
      "staff.saved_view_deleted": "Deleted a view",
    },
  },
  {
    label: "Staff",
    events: {
      "staff.member_added": "Added a member of staff",
      "staff.role_changed": "Changed a member of staff’s role",
      "staff.member_removed": "Removed a member of staff",
      "staff.factors_reset": "Reset a member of staff’s second factors",
      "staff.enrolment_code_issued": "Made an enrolment code",
      "staff.enrolment_code_redeemed": "Used an enrolment code",
      "staff.role_created": "Created a staff role",
      "staff.role_updated": "Changed a staff role",
      "staff.role_deleted": "Deleted a staff role",
      "staff.bootstrapped": "Made the first Admin",
    },
  },
  {
    label: "Signing in",
    events: {
      "staff.signed_in": "Signed in",
      "staff.signed_out": "Signed out",
      "staff.second_factor_required": "Was asked for a second factor",
      "staff.sign_in_failed": "Couldn’t sign in",
      "staff.session_revoked": "Signed out a session",
      "staff.signed_out_everywhere": "Signed out everywhere else",
      "staff.step_up_passed": "Confirmed it was them",
      "staff.step_up_failed": "Couldn’t confirm it was them",
      "staff.step_up_locked": "Was signed out after too many tries",
      "staff.factor_setup_started": "Started setting up an authenticator app",
      "staff.factor_enrolled": "Added their first second factor",
      "staff.factor_added": "Added a second factor",
      "staff.factor_removed": "Removed a second factor",
    },
  },
  {
    label: "Operations",
    events: {
      "switch.set": "Turned on a kill switch",
      "switch.cleared": "Turned off a kill switch",
      "switch.tripped": "Tripped a kill switch",
      "operator.task_completed": "Ran an operator task",
      "operator.credential_rotated": "Rotated a credential",
      "operator.escrow_opened": "Opened an escrowed credential",
      "audit.epoch_started": "Started a new audit epoch",
      "audit.restore_replayed": "Replayed the revocation journal",
      "audit.failover_recorded": "Recorded a database failover",
      "system.sweep_completed": "Cleared expired records",
      "system.kyc_write_refused": "Refused a verification update",
      "system.kyc_unknown_applicant": "Had an update for an unknown applicant",
    },
  },
  {
    label: "Money",
    events: {
      "money.holder.retry_requested": "Asked to retry an account holder",
      "money.routing_decided": "Decided a transfer’s route",
      "beneficiary.sealed_opened": "Opened a beneficiary’s sealed details",
      "beneficiary.registered": "Registered a beneficiary",
      "treasury.funding_created": "Funded the treasury",
      "money.reconciliation_break": "Found a reconciliation break",
      "money.reconciliation_break_resolved": "Resolved a reconciliation break",
    },
  },
];

const EVENT_WORDS: ReadonlyMap<string, string> = new Map(
  ACTION_GROUPS.flatMap((group) => Object.entries(group.events)),
);

/** The row's words ("Added a member of staff"), or its event name when this file has none. */
export function wordsOf(event: string): string {
  return EVENT_WORDS.get(event) ?? event;
}

const ROLES: Readonly<Record<string, string>> = {
  viewer: "Viewer",
  compliance: "Compliance",
  operator: "Operator",
  admin: "Admin",
};

/** A role key as words: a prebuilt role's label, or "A custom role" for an `srl_` ID. */
export function roleWords(key: unknown): string {
  if (typeof key !== "string" || key === "") return "None";
  return ROLES[key] ?? (key.startsWith("srl_") ? "A custom role" : key);
}

const PROVIDERS: Readonly<Record<string, string>> = { sumsub: "Sumsub", masspay: "MassPay" };

/** Who acted: a member of staff by their address; the operator, Fin itself or a provider by name. */
export function whoOf(entry: AuditEntry): string {
  if (entry.actor.kind === "staff") {
    return entry.actor.email ?? entry.actor.name ?? "A member of staff";
  }
  if (entry.actor.kind === "operator") return "Operator";
  if (entry.actor.kind === "provider") {
    return PROVIDERS[entry.actor.id ?? ""] ?? entry.actor.id ?? "A provider";
  }
  return "Fin";
}

/** How the actor was verified ([BC-03]), as the chip says it. */
export function verificationWords(verification: string | null): string | null {
  switch (verification) {
    case "passkey":
      return "Passkey";
    case "totp":
      return "Authenticator app";
    case "backup_code":
      return "Backup code";
    case "email_otp":
      return "Emailed code";
    case "password":
      return "Password";
    case "google":
      return "Google";
    case "session":
      return "Signed-in session";
    default:
      return null;
  }
}

/** Codes a row's `reason` or `reasonCode` carries, as words. */
const REASONS: Readonly<Record<string, string>> = {
  added: "Added to staff",
  reset: "Second factors reset",
  reissued: "A new code was asked for",
  bootstrap: "The first Admin",
  role_deleted: "Their role was deleted",
  wrong_code: "Wrong code",
  expired: "Code expired",
  passkey_failed: "The passkey didn’t work",
  access_mismatch: "Another Access identity",
  removed: "No longer staff",
  too_many_tries: "Too many tries",
  other_person: "Someone else’s factor",
};

/** "risk_review" as "Risk review". */
export function humanise(code: string): string {
  const words = code.replace(/_/g, " ").trim();
  return words === "" ? code : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** The row's reason: its words and code, or null for "No reason asked". */
export function reasonOf(entry: AuditEntry): { words: string; code: string } | null {
  const raw = entry.metadata.reasonCode ?? entry.metadata.reason;
  if (typeof raw !== "string" || raw === "" || raw === "changed") return null;
  return { words: REASONS[raw] ?? humanise(raw), code: raw };
}

export interface Change {
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

function valueWords(field: string, value: unknown): string {
  if (field.toLowerCase().includes("role")) return roleWords(value);
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (value === null || value === undefined || value === "") return "None";
  if (typeof value === "string") return humanise(value);
  return String(value);
}

/**
 * "What changed": each `fromX` and `toX` pair the metadata holds, then what an event's own
 * fields say (a role given, a switch turned, factors removed). Empty when the row records none.
 */
export function changesOf(entry: AuditEntry): Change[] {
  const changes: Change[] = [];
  const m = entry.metadata;
  for (const key of Object.keys(m)) {
    const match = /^from([A-Z][A-Za-z]*)$/.exec(key);
    if (match === null) continue;
    const name = match[1] ?? "";
    const toKey = `to${name}`;
    if (!(toKey in m)) continue;
    const field = humanise(name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase());
    changes.push({
      field,
      before: valueWords(field, m[key]),
      after: valueWords(field, m[toKey]),
    });
  }
  switch (entry.event) {
    case "staff.member_added":
      changes.push({ field: "Role", before: "None", after: roleWords(m.roleKey) });
      break;
    case "staff.member_removed":
      changes.push({ field: "Fin Admin", before: "Member of staff", after: "Removed" });
      break;
    case "switch.set":
    case "switch.tripped":
      changes.push({ field: "Kill switch", before: "Off", after: "On" });
      break;
    case "switch.cleared":
      changes.push({ field: "Kill switch", before: "On", after: "Off" });
      break;
    case "staff.factors_reset":
      if (typeof m.factorsRemoved === "number") {
        changes.push({ field: "Second factors", before: String(m.factorsRemoved), after: "None" });
      }
      break;
    case "staff.signed_out_everywhere":
      if (typeof m.count === "number") {
        changes.push({ field: "Other sessions", before: String(m.count), after: "None" });
      }
      break;
  }
  return changes;
}

/** What the row was done to, for the What column and the drawer: a label, or the target itself. */
export function targetText(entry: AuditEntry): string {
  return entry.target.label ?? entry.target.id;
}
