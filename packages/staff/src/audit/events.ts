// The staff area's management events (spec 02 §16.4; spec 08 §3.4's `staff.ts` rows, D08-33's
// canonical names): adding, changing, removing and resetting staff, the operator's bootstrap of
// the first Admin, and the kill switches. @fin/identity's STAFF_REALM_EVENTS holds the rest of the
// fragment (the sign-in, factor, step-up and enrolment-code events its realm writes).
//
// These are written in @fin/audit's `defineEvents` shape (category, scope, roles, actors, target,
// a strict flat metadata schema, the journal kind). packages/audit/src/events/staff.ts holds them
// with identity's half: that fragment is what `migrate` syncs to audit.event_type, and
// fragment.test.ts holds it equal to these. `staffEventTypeRows()` serves the test platform.
//
// Metadata is flat: IDs, role keys, codes, counts and flags. Never a name, an address, a code, a
// token or typed text (spec 02 §16.1, ARCHITECTURE §8.2).
import { STAFF_REALM_EVENTS } from "@fin/identity";
import * as z from "zod";

export type AuditScope = "organisation" | "person" | "staff";
export type AuditCategory = "staff" | "operations" | "security" | "sign_in";
export type AuditRole = "fin_admin" | "fin_owner";
export type ActorKind = "staff" | "operator" | "system";
export type JournalKind =
  | "staff_removed"
  | "staff_factors_reset"
  | "staff_role_lowered"
  | "switch_set"
  | "switch_cleared";

export interface StaffEventSpec {
  readonly category: AuditCategory;
  readonly scope: AuditScope;
  readonly roles: readonly AuditRole[];
  readonly actors: readonly ActorKind[];
  /** The target ID's three-letter prefix, or a label (`switch`) for a target that is a name. */
  readonly target: string;
  readonly metadata: z.ZodObject;
  /** The revocation-journal entry written in the same transaction (spec 08 §3.10). */
  readonly journal?: { readonly kind: JournalKind; readonly when?: (metadata: never) => boolean };
}

const roleKey = z.string().regex(/^(viewer|compliance|operator|admin|srl_[0-9a-hjkmnp-tv-z]{26})$/);
/** A preset reason code, as ops.set_switch checks it: never typed text. */
export const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const reasonCode = z.string().regex(REASON_CODE);

export const STAFF_EVENTS = {
  "staff.member_added": {
    category: "staff",
    scope: "staff",
    // fin_owner: the operator's bootstrap of the first Admin (§10.6).
    roles: ["fin_admin", "fin_owner"],
    actors: ["staff", "operator"],
    target: "stf",
    metadata: z.strictObject({ roleKey, reactivated: z.boolean() }),
  },
  "staff.role_changed": {
    category: "staff",
    scope: "staff",
    roles: ["fin_admin"],
    actors: ["staff"],
    target: "stf",
    metadata: z.strictObject({
      fromRole: roleKey,
      toRole: roleKey,
      reason: z.enum(["changed", "role_deleted"]),
      lowered: z.boolean(),
    }),
    journal: { kind: "staff_role_lowered", when: (m: { lowered: boolean }) => m.lowered },
  },
  "staff.member_removed": {
    category: "staff",
    scope: "staff",
    roles: ["fin_admin"],
    actors: ["staff"],
    target: "stf",
    metadata: z.strictObject({
      sessionsEnded: z.int().min(0),
      factorsRemoved: z.int().min(0),
    }),
    journal: { kind: "staff_removed" },
  },
  "staff.factors_reset": {
    category: "staff",
    scope: "staff",
    // fin_owner: the bootstrap task's `--reset` of the last Admin (§10.4, §10.6).
    roles: ["fin_admin", "fin_owner"],
    actors: ["staff", "operator"],
    target: "stf",
    metadata: z.strictObject({
      sessionsEnded: z.int().min(0),
      factorsRemoved: z.int().min(0),
    }),
    journal: { kind: "staff_factors_reset" },
  },
  "staff.bootstrapped": {
    category: "staff",
    scope: "staff",
    roles: ["fin_owner"],
    actors: ["operator"],
    target: "stf",
    metadata: z.strictObject({ reset: z.boolean(), reasonCode }),
  },
  "switch.set": {
    category: "operations",
    scope: "staff",
    // fin_owner: `pnpm fin switch`'s operator task (spec 08 §3.4).
    roles: ["fin_admin", "fin_owner"],
    actors: ["staff", "operator"],
    target: "switch",
    metadata: z.strictObject({ reasonCode }),
    journal: { kind: "switch_set" },
  },
  "switch.cleared": {
    category: "operations",
    scope: "staff",
    roles: ["fin_admin", "fin_owner"],
    actors: ["staff", "operator"],
    target: "switch",
    metadata: z.strictObject({ reasonCode }),
    journal: { kind: "switch_cleared" },
  },
} as const satisfies Record<string, StaffEventSpec>;

export type StaffEventName = keyof typeof STAFF_EVENTS;

/**
 * The events this package records: its own, and the enrolment-code event @fin/identity declares
 * (issued here for Fin Admin's routes, redeemed by identity's realm).
 */
export const RECORDED_EVENTS = {
  ...STAFF_EVENTS,
  "staff.enrolment_code_issued": STAFF_REALM_EVENTS["staff.enrolment_code_issued"],
} as const;

export type RecordedEventName = keyof typeof RECORDED_EVENTS;

/** The `audit.event_type` rows these events need (spec 08 §3.2's audit-sync), journal kind included. */
export function staffEventTypeRows(): {
  name: string;
  area: string;
  category: string;
  scope: string;
  roles: string[];
  journal_kind: string | null;
  retired: boolean;
}[] {
  return Object.entries(STAFF_EVENTS)
    .map(([name, spec]) => ({
      name,
      area: "staff",
      category: spec.category,
      scope: spec.scope,
      roles: [...spec.roles].sort(),
      journal_kind: "journal" in spec ? spec.journal.kind : null,
      retired: false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
